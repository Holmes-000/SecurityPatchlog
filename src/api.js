const express = require('express');
const { transaction, SEVERITIES, SEVERITY_RANK, STATUSES, VERDICTS } = require('./db');
const {
  HttpError,
  sha256,
  hashPassword,
  verifyPassword,
  validatePassword,
  DUMMY_HASH,
  issueSession,
  newApiKey,
  makeAuthMiddleware,
  rateLimit,
} = require('./auth');
const { makeIngest } = require('./ingest');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(v, field, { max = 200, required = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`);
  return s;
}

function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.');
  return n;
}

function list(v, allowed) {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at };
}

function publicFinding(f) {
  return {
    id: f.id,
    projectId: f.project_id,
    projectName: f.project_name,
    ruleId: f.rule_id,
    title: f.title,
    file: f.file,
    line: f.line,
    locations: JSON.parse(f.locations || '[]'),
    severity: f.severity,
    severityLocked: !!f.severity_locked,
    verdict: f.verdict,
    reasoning: f.reasoning,
    fix: f.fix,
    status: f.status,
    assigneeId: f.assignee_id,
    assigneeName: f.assignee_name,
    inLatestScan: f.latest_scan_id != null && f.last_seen_scan_id === f.latest_scan_id,
    firstSeenScanId: f.first_seen_scan_id,
    lastSeenScanId: f.last_seen_scan_id,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    resolvedAt: f.resolved_at,
  };
}

const FINDING_SELECT = `
  SELECT f.*, p.name AS project_name, u.name AS assignee_name,
         (SELECT MAX(s.id) FROM scans s WHERE s.project_id = f.project_id) AS latest_scan_id
  FROM findings f
  JOIN projects p ON p.id = f.project_id
  LEFT JOIN users u ON u.id = f.assignee_id`;

const MAX_INTERVAL_DAYS = 365;

/** Server-wide default for how often a project may be scanned (SCAN_INTERVAL_DAYS, default 7). */
function defaultInterval() {
  const n = Number(process.env.SCAN_INTERVAL_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= MAX_INTERVAL_DAYS ? n : 7;
}

/** PUBLIC_URL without a trailing slash, or null if unset/invalid. */
function publicUrl() {
  const raw = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function effectiveInterval(project) {
  return project.scan_interval_days ?? defaultInterval();
}

function createApi(db, getSecret) {
  const router = express.Router();
  const { requireUser, requireAdmin, requireProjectKey } = makeAuthMiddleware(db, getSecret);
  const ingest = makeIngest(db);

  const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const insertUser = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)');

  function createUser({ email, name, password, role }) {
    email = text(email, 'Email', { max: 200, required: true }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email is not valid.');
    name = text(name, 'Name', { max: 100, required: true });
    validatePassword(password);
    if (!['admin', 'member'].includes(role)) throw new HttpError(400, 'Role must be admin or member.');
    if (userByEmail.get(email)) throw new HttpError(409, 'A user with that email already exists.');
    const r = insertUser.run(email, name, hashPassword(password), role);
    return userById.get(Number(r.lastInsertRowid));
  }

  // ---------- Ingest (CI / triage script) ----------
  router.post('/ingest', requireProjectKey, (req, res) => {
    res.status(201).json(ingest(req.project, req.body));
  });

  // ---------- Scan gate (CI asks this before spending AI compute) ----------
  // Returns plain-text "1" (scan now) or "0" (skip), or JSON with ?format=json.
  router.get('/should-scan', requireProjectKey, (req, res) => {
    const intervalDays = effectiveInterval(req.project);
    const last = db
      .prepare('SELECT id, received_at FROM scans WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(req.project.id);
    const lastAt = last ? new Date(`${last.received_at.replace(' ', 'T')}Z`) : null;
    const ageDays = lastAt ? (Date.now() - lastAt.getTime()) / 86_400_000 : null;
    const scan = !lastAt || ageDays >= intervalDays;

    if (req.query.format === 'json') {
      return res.json({
        scan: scan ? 1 : 0,
        project: req.project.name,
        intervalDays,
        lastScanId: last ? last.id : null,
        lastScanAt: lastAt ? lastAt.toISOString() : null,
        lastScanAgeDays: ageDays === null ? null : Math.round(ageDays * 100) / 100,
        nextScanDueAt: lastAt ? new Date(lastAt.getTime() + intervalDays * 86_400_000).toISOString() : null,
      });
    }
    res.type('text/plain').send(scan ? '1' : '0');
  });

  // ---------- First-run setup ----------
  router.get('/setup', (req, res) => {
    res.json({ needsSetup: countUsers.get().n === 0 });
  });

  router.post('/setup', rateLimit({ windowMs: 15 * 60_000, max: 10 }), (req, res) => {
    const user = transaction(db, () => {
      if (countUsers.get().n > 0) throw new HttpError(409, 'Setup has already been completed.');
      return createUser({ ...req.body, role: 'admin' });
    });
    res.status(201).json({ token: issueSession(user, getSecret()), user: publicUser(user) });
  });

  // ---------- Auth ----------
  router.post('/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 20 }), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = email ? userByEmail.get(email) : null;
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || user.disabled) throw new HttpError(401, 'Wrong email or password.');
    res.json({ token: issueSession(user, getSecret()), user: publicUser(user) });
  });

  router.use(requireUser); // everything below needs a signed-in user

  router.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

  // Settings the UI needs. publicUrl is the address CI uses to reach this server (PUBLIC_URL),
  // null = the UI falls back to the address in the browser.
  router.get('/config', (req, res) => res.json({ publicUrl: publicUrl() }));

  router.post('/auth/password', (req, res) => {
    if (!verifyPassword(String(req.body?.current || ''), req.user.password_hash)) {
      throw new HttpError(400, 'Current password is wrong.');
    }
    validatePassword(req.body?.next);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.next), req.user.id);
    const user = userById.get(req.user.id);
    res.json({ token: issueSession(user, getSecret()) });
  });

  // ---------- Users ----------
  router.get('/users', (req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY disabled, name COLLATE NOCASE').all();
    res.json({ users: users.map(publicUser) });
  });

  router.post('/users', requireAdmin, (req, res) => {
    const user = createUser({ ...req.body, role: req.body?.role || 'member' });
    res.status(201).json({ user: publicUser(user) });
  });

  router.patch('/users/:id', requireAdmin, (req, res) => {
    const id = idParam(req.params.id);
    const user = userById.get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    const b = req.body || {};
    const self = id === req.user.id;

    if (b.name !== undefined) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(text(b.name, 'Name', { max: 100, required: true }), id);
    }
    if (b.role !== undefined) {
      if (!['admin', 'member'].includes(b.role)) throw new HttpError(400, 'Role must be admin or member.');
      if (self && b.role !== 'admin') throw new HttpError(400, "You can't remove your own admin role.");
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
    }
    if (b.disabled !== undefined) {
      if (self && b.disabled) throw new HttpError(400, "You can't disable your own account.");
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, id);
    }
    if (b.password !== undefined) {
      validatePassword(b.password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
    }
    res.json({ user: publicUser(userById.get(id)) });
  });

  // ---------- Projects ----------
  const projectStats = `
    SELECT p.id, p.name, p.description, p.api_key_prefix, p.scan_interval_days, p.created_at,
      (SELECT COUNT(*) FROM findings f WHERE f.project_id = p.id AND f.status IN ('open','in_progress')
         AND f.verdict != 'false_positive') AS open_count,
      (SELECT MAX(received_at) FROM scans s WHERE s.project_id = p.id) AS last_scan_at,
      (SELECT updated_at FROM project_covers c WHERE c.project_id = p.id) AS cover_updated_at
    FROM projects p`;

  function openBySeverity(projectId) {
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    const rows = db
      .prepare(
        `SELECT project_id, severity, COUNT(*) AS n FROM findings
         WHERE status IN ('open','in_progress') AND verdict != 'false_positive'
         ${projectId ? 'AND project_id = ?' : ''} GROUP BY project_id, severity`
      )
      .all(...(projectId ? [projectId] : []));
    const byProject = new Map();
    for (const r of rows) {
      if (!byProject.has(r.project_id)) byProject.set(r.project_id, { ...counts });
      byProject.get(r.project_id)[r.severity] = r.n;
    }
    return (id) => byProject.get(id) || { ...counts };
  }

  function publicProject(p, sevCounts) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      keyPrefix: p.api_key_prefix,
      openCount: p.open_count ?? 0,
      openBySeverity: (sevCounts || openBySeverity(p.id))(p.id),
      lastScanAt: p.last_scan_at ?? null,
      scanIntervalDays: p.scan_interval_days ?? null,
      effectiveScanIntervalDays: effectiveInterval(p),
      // Changes whenever the cover changes, so the UI can tell when to refetch it. null = no cover.
      coverVersion: p.cover_updated_at ?? null,
      createdAt: p.created_at,
    };
  }

  router.get('/projects', (req, res) => {
    const rows = db.prepare(`${projectStats} ORDER BY p.name COLLATE NOCASE`).all();
    const sevCounts = openBySeverity();
    res.json({ projects: rows.map((p) => publicProject(p, sevCounts)) });
  });

  router.get('/projects/:id', (req, res) => {
    const p = db.prepare(`${projectStats} WHERE p.id = ?`).get(idParam(req.params.id));
    if (!p) throw new HttpError(404, 'Project not found.');
    res.json({ project: publicProject(p) });
  });

  // ---------- Project cover images ----------
  // Raster formats only. SVG is refused because it can carry script.
  const COVER_MAX_BYTES = 5 * 1024 * 1024;
  const COVER_TYPES = {
    'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/gif': (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
    'image/webp': (b) =>
      b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  };

  router.put(
    '/projects/:id/cover',
    requireAdmin,
    express.raw({ type: () => true, limit: COVER_MAX_BYTES }),
    (req, res) => {
      const id = idParam(req.params.id);
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new HttpError(404, 'Project not found.');
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const check = COVER_TYPES[mime];
      if (!check) throw new HttpError(415, 'Cover must be a PNG, JPEG, WebP or GIF image.');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!check(body)) throw new HttpError(400, `File is not a valid ${mime.slice(6).toUpperCase()} image.`);
      db.prepare(
        `INSERT INTO project_covers (project_id, mime, data, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
         ON CONFLICT(project_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`
      ).run(id, mime, body);
      res.json({ project: publicProject(db.prepare(`${projectStats} WHERE p.id = ?`).get(id)) });
    }
  );

  router.delete('/projects/:id/cover', requireAdmin, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new HttpError(404, 'Project not found.');
    db.prepare('DELETE FROM project_covers WHERE project_id = ?').run(id);
    res.json({ project: publicProject(db.prepare(`${projectStats} WHERE p.id = ?`).get(id)) });
  });

  router.get('/projects/:id/cover', (req, res) => {
    const cover = db.prepare('SELECT mime, data FROM project_covers WHERE project_id = ?').get(idParam(req.params.id));
    if (!cover || !COVER_TYPES[cover.mime]) throw new HttpError(404, 'No cover image.');
    res.set({ 'Content-Type': cover.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=0' });
    res.send(Buffer.from(cover.data));
  });

  router.post('/projects', requireAdmin, (req, res) => {
    const name = text(req.body?.name, 'Name', { max: 100, required: true });
    const description = text(req.body?.description, 'Description', { max: 500 });
    if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name)) {
      throw new HttpError(409, 'A project with that name already exists.');
    }
    const apiKey = newApiKey();
    const r = db
      .prepare('INSERT INTO projects (name, description, api_key_hash, api_key_prefix) VALUES (?, ?, ?, ?)')
      .run(name, description, sha256(apiKey), apiKey.slice(0, 10));
    const project = db.prepare(`${projectStats} WHERE p.id = ?`).get(Number(r.lastInsertRowid));
    res.status(201).json({ project: publicProject(project), apiKey });
  });

  router.patch('/projects/:id', requireAdmin, (req, res) => {
    const id = idParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new HttpError(404, 'Project not found.');
    const b = req.body || {};
    if (b.description !== undefined) {
      db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(
        text(b.description, 'Description', { max: 500 }),
        id
      );
    }
    if (b.scanIntervalDays !== undefined) {
      let days = null; // null / "" = use the server default
      if (b.scanIntervalDays !== null && b.scanIntervalDays !== '') {
        days = Number(b.scanIntervalDays);
        if (!Number.isFinite(days) || days < 0 || days > MAX_INTERVAL_DAYS) {
          throw new HttpError(400, `Scan interval must be between 0 and ${MAX_INTERVAL_DAYS} days.`);
        }
      }
      db.prepare('UPDATE projects SET scan_interval_days = ? WHERE id = ?').run(days, id);
    }
    res.json({ project: publicProject(db.prepare(`${projectStats} WHERE p.id = ?`).get(id)) });
  });

  router.post('/projects/:id/rotate-key', requireAdmin, (req, res) => {
    const id = idParam(req.params.id);
    const apiKey = newApiKey();
    const r = db
      .prepare('UPDATE projects SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?')
      .run(sha256(apiKey), apiKey.slice(0, 10), id);
    if (!r.changes) throw new HttpError(404, 'Project not found.');
    res.json({ apiKey });
  });

  // ---------- Findings ----------
  router.get('/findings', (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];

    if (q.project) {
      where.push('f.project_id = ?');
      params.push(idParam(q.project));
    }

    const statuses = q.status === 'all' ? [] : list(q.status, STATUSES);
    const useStatuses = q.status === 'all' ? [] : statuses.length ? statuses : ['open', 'in_progress'];
    if (useStatuses.length) {
      where.push(`f.status IN (${useStatuses.map(() => '?').join(',')})`);
      params.push(...useStatuses);
    }

    const severities = list(q.severity, SEVERITIES);
    if (severities.length) {
      where.push(`f.severity IN (${severities.map(() => '?').join(',')})`);
      params.push(...severities);
    }

    const verdicts = list(q.verdict, VERDICTS);
    if (verdicts.length) {
      where.push(`f.verdict IN (${verdicts.map(() => '?').join(',')})`);
      params.push(...verdicts);
    } else if (q.includeFalsePositives !== '1') {
      where.push("f.verdict != 'false_positive'");
    }

    if (q.assignee === 'me') {
      where.push('f.assignee_id = ?');
      params.push(req.user.id);
    } else if (q.assignee === 'none') {
      where.push('f.assignee_id IS NULL');
    } else if (q.assignee) {
      where.push('f.assignee_id = ?');
      params.push(idParam(q.assignee));
    }

    if (q.q) {
      const like = `%${String(q.q).slice(0, 200).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(f.title LIKE ? ESCAPE '\\' OR f.rule_id LIKE ? ESCAPE '\\' OR f.file LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }

    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 2000);
    const sql = `${FINDING_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.severity_rank DESC,
               CASE f.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'wont_fix' THEN 2 ELSE 3 END,
               CASE f.verdict WHEN 'true_positive' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END,
               f.updated_at DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit);
    res.json({ findings: rows.map(publicFinding), limit });
  });

  router.get('/findings/:id', (req, res) => {
    const id = idParam(req.params.id);
    const f = db.prepare(`${FINDING_SELECT} WHERE f.id = ?`).get(id);
    if (!f) throw new HttpError(404, 'Finding not found.');
    const activity = db
      .prepare(
        `SELECT a.id, a.kind, a.message, a.created_at, u.name AS user_name
         FROM activity a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.finding_id = ? ORDER BY a.id DESC`
      )
      .all(id)
      .map((a) => ({ id: a.id, kind: a.kind, message: a.message, createdAt: a.created_at, userName: a.user_name }));
    res.json({ finding: publicFinding(f), activity });
  });

  const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', done: 'Done', wont_fix: "Won't fix" };

  router.patch('/findings/:id', (req, res) => {
    const id = idParam(req.params.id);
    const b = req.body || {};
    const logActivity = db.prepare('INSERT INTO activity (finding_id, user_id, kind, message) VALUES (?, ?, ?, ?)');

    transaction(db, () => {
      const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
      if (!f) throw new HttpError(404, 'Finding not found.');

      if (b.status !== undefined && b.status !== f.status) {
        if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Invalid status.');
        const resolved = b.status === 'done' || b.status === 'wont_fix';
        db.prepare(
          `UPDATE findings SET status = ?, resolved_at = ${resolved ? "datetime('now')" : 'NULL'},
           updated_at = datetime('now') WHERE id = ?`
        ).run(b.status, id);
        logActivity.run(id, req.user.id, 'status', `${STATUS_LABEL[f.status]} → ${STATUS_LABEL[b.status]}`);
      }

      if (b.assigneeId !== undefined) {
        const assigneeId = b.assigneeId === null || b.assigneeId === '' ? null : idParam(b.assigneeId);
        if (assigneeId !== f.assignee_id) {
          let message = 'Unassigned';
          if (assigneeId) {
            const a = userById.get(assigneeId);
            if (!a || a.disabled) throw new HttpError(400, 'Assignee not found.');
            message = `Assigned to ${a.name}`;
          }
          db.prepare("UPDATE findings SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(
            assigneeId,
            id
          );
          logActivity.run(id, req.user.id, 'assign', message);
        }
      }

      if (b.severity !== undefined && b.severity !== f.severity) {
        if (!SEVERITIES.includes(b.severity)) throw new HttpError(400, 'Invalid severity.');
        db.prepare(
          "UPDATE findings SET severity = ?, severity_rank = ?, severity_locked = 1, updated_at = datetime('now') WHERE id = ?"
        ).run(b.severity, SEVERITY_RANK[b.severity], id);
        logActivity.run(id, req.user.id, 'severity', `Severity ${f.severity} → ${b.severity}`);
      }
    });

    const f = db.prepare(`${FINDING_SELECT} WHERE f.id = ?`).get(id);
    res.json({ finding: publicFinding(f) });
  });

  router.post('/findings/:id/comments', (req, res) => {
    const id = idParam(req.params.id);
    const message = text(req.body?.message, 'Comment', { max: 5000, required: true });
    if (!db.prepare('SELECT 1 FROM findings WHERE id = ?').get(id)) throw new HttpError(404, 'Finding not found.');
    db.prepare("INSERT INTO activity (finding_id, user_id, kind, message) VALUES (?, ?, 'comment', ?)").run(
      id,
      req.user.id,
      message
    );
    db.prepare("UPDATE findings SET updated_at = datetime('now') WHERE id = ?").run(id);
    res.status(201).json({ ok: true });
  });

  // ---------- Stats ----------
  router.get('/stats', (req, res) => {
    const params = [];
    let filter = '';
    if (req.query.project) {
      filter = 'AND project_id = ?';
      params.push(idParam(req.query.project));
    }
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const r of db
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM findings
         WHERE status IN ('open','in_progress') AND verdict != 'false_positive' ${filter} GROUP BY severity`
      )
      .all(...params)) {
      bySeverity[r.severity] = r.n;
    }
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM findings WHERE verdict != 'false_positive' ${filter} GROUP BY status`
      )
      .all(...params)) {
      byStatus[r.status] = r.n;
    }
    const mine = db
      .prepare(
        `SELECT COUNT(*) AS n FROM findings WHERE assignee_id = ? AND status IN ('open','in_progress') ${filter}`
      )
      .get(req.user.id, ...params).n;
    res.json({ bySeverity, byStatus, mine });
  });

  // ---------- Scans ----------
  router.get('/scans', (req, res) => {
    const params = [];
    let filter = '';
    if (req.query.project) {
      filter = 'WHERE s.project_id = ?';
      params.push(idParam(req.query.project));
    }
    const rows = db
      .prepare(
        `SELECT s.id, s.project_id, p.name AS project_name, s.branch, s.commit_sha, s.run_url, s.triggered_by,
                s.engine, s.model, s.finding_count, s.new_count, s.reopened_count, s.received_at
         FROM scans s JOIN projects p ON p.id = s.project_id ${filter}
         ORDER BY s.id DESC LIMIT 200`
      )
      .all(...params);
    res.json({ scans: rows });
  });

  router.get('/scans/:id', (req, res) => {
    const id = idParam(req.params.id);
    const scan = db
      .prepare('SELECT s.*, p.name AS project_name FROM scans s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
      .get(id);
    if (!scan) throw new HttpError(404, 'Scan not found.');
    res.json({ scan });
  });

  return router;
}

module.exports = { createApi };
