const { transaction, SEVERITY_RANK } = require('./db');
const { HttpError, sha256 } = require('./auth');

const MAX_FINDINGS = 5000;

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normSeverity(v) {
  const s = String(v || '').toLowerCase();
  if (s.startsWith('crit')) return 'critical';
  if (s.startsWith('high')) return 'high';
  if (s.startsWith('med') || s === 'moderate') return 'medium';
  if (s.startsWith('low')) return 'low';
  return 'info';
}

function normVerdict(v) {
  const s = String(v || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (s.startsWith('true') || s === 'tp' || s === 'confirmed') return 'true_positive';
  if (s.startsWith('false') || s === 'fp') return 'false_positive';
  return 'needs_review';
}

function normFinding(raw, index) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, `findings[${index}] must be an object.`);
  const ruleId = str(raw.ruleId ?? raw.rule_id ?? raw.rule, 300);
  const file = str(raw.file ?? raw.path, 1000)?.replace(/\\/g, '/') ?? null;
  const lineNum = parseInt(raw.line, 10);
  const line = Number.isFinite(lineNum) && lineNum > 0 ? lineNum : null;
  const title = str(raw.title ?? raw.message, 500) || ruleId || `Finding ${index + 1}`;
  const locations = Array.isArray(raw.locations)
    ? raw.locations.slice(0, 500).map((l) => str(l, 1000)).filter(Boolean)
    : [];
  const severity = normSeverity(raw.severity);
  const verdict = normVerdict(raw.verdict);
  const fingerprint = str(raw.fingerprint, 200) || sha256([ruleId || title, file || '', line || ''].join('|'));

  return {
    fingerprint,
    ruleId,
    title,
    file,
    line,
    locations: JSON.stringify(locations),
    severity: verdict === 'false_positive' && !raw.severity ? 'info' : severity,
    verdict,
    reasoning: str(raw.reasoning, 20000),
    fix: str(raw.fix, 20000),
  };
}

function makeIngest(db) {
  const insertScan = db.prepare(`
    INSERT INTO scans (project_id, branch, commit_sha, run_url, triggered_by, engine, model, summary, report_markdown, finding_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const finishScan = db.prepare('UPDATE scans SET new_count = ?, reopened_count = ? WHERE id = ?');
  const findByFp = db.prepare('SELECT * FROM findings WHERE project_id = ? AND fingerprint = ?');
  const insertFinding = db.prepare(`
    INSERT INTO findings (project_id, fingerprint, rule_id, title, file, line, locations, severity, severity_rank,
                          verdict, reasoning, fix, first_seen_scan_id, last_seen_scan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateFinding = db.prepare(`
    UPDATE findings SET rule_id = ?, title = ?, file = ?, line = ?, locations = ?,
      severity = CASE WHEN severity_locked = 1 THEN severity ELSE ? END,
      severity_rank = CASE WHEN severity_locked = 1 THEN severity_rank ELSE ? END,
      verdict = ?, reasoning = ?, fix = ?, status = ?, resolved_at = ?,
      last_seen_scan_id = ?, updated_at = datetime('now')
    WHERE id = ?`);
  const logActivity = db.prepare('INSERT INTO activity (finding_id, user_id, kind, message) VALUES (?, NULL, ?, ?)');

  return function ingest(project, body) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be JSON.');
    if (!Array.isArray(body.findings)) throw new HttpError(400, '`findings` must be an array.');
    if (body.findings.length > MAX_FINDINGS) {
      throw new HttpError(413, `Too many findings (max ${MAX_FINDINGS}). Group duplicates before sending.`);
    }

    // Normalise everything up front so a bad entry rejects the whole payload
    const findings = body.findings.map(normFinding);
    // The same fingerprint twice in one payload: keep the last one
    const unique = [...new Map(findings.map((f) => [f.fingerprint, f])).values()];

    return transaction(db, () => {
      const scan = insertScan.run(
        project.id,
        str(body.branch, 200),
        str(body.commit, 100),
        str(body.runUrl, 1000),
        str(body.triggeredBy, 200),
        str(body.engine, 100),
        str(body.model, 200),
        str(body.summary, 20000),
        str(body.reportMarkdown, 2_000_000),
        unique.length
      );
      const scanId = Number(scan.lastInsertRowid);
      let created = 0;
      let updated = 0;
      let reopened = 0;

      for (const f of unique) {
        const existing = findByFp.get(project.id, f.fingerprint);
        if (!existing) {
          const r = insertFinding.run(
            project.id, f.fingerprint, f.ruleId, f.title, f.file, f.line, f.locations,
            f.severity, SEVERITY_RANK[f.severity], f.verdict, f.reasoning, f.fix, scanId, scanId
          );
          logActivity.run(Number(r.lastInsertRowid), 'created', `Reported by scan #${scanId}`);
          created++;
          continue;
        }

        let status = existing.status;
        let resolvedAt = existing.resolved_at;
        if (existing.status === 'done' && f.verdict !== 'false_positive') {
          status = 'open';
          resolvedAt = null;
          reopened++;
          logActivity.run(existing.id, 'reopened', `Reported again by scan #${scanId} after being marked done`);
        }
        updateFinding.run(
          f.ruleId, f.title, f.file, f.line, f.locations,
          f.severity, SEVERITY_RANK[f.severity],
          f.verdict, f.reasoning, f.fix, status, resolvedAt, scanId, existing.id
        );
        updated++;
      }

      finishScan.run(created, reopened, scanId);
      return { scanId, project: project.name, total: unique.length, created, updated, reopened };
    });
  };
}

module.exports = { makeIngest };
