'use strict';

/* =========================================================================
   SecPatchlog — vanilla JS SPA with hash routing.
   All data is inserted with textContent (never innerHTML).
   ========================================================================= */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', done: 'Done', wont_fix: "Won't fix" };
const VERDICT_LABEL = { true_positive: 'True positive', needs_review: 'Needs review', false_positive: 'False positive' };

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ }
  },
};

const state = {
  token: store.get('sd_token'),
  me: null,
  users: [],
  projects: [],
  filters: loadFilters(),
};

function loadFilters() {
  const defaults = { project: '', status: 'active', severity: '', assignee: '', verdict: '', q: '' };
  try {
    return { ...defaults, ...JSON.parse(store.get('sd_filters') || '{}') };
  } catch {
    return defaults;
  }
}
function saveFilters() {
  store.set('sd_filters', JSON.stringify(state.filters));
}

/* ---------------- DOM helpers ---------------- */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

function options(pairs, selected) {
  return pairs.map(([v, label]) => h('option', { value: v, selected: String(v) === String(selected) }, label));
}

function sevBadge(s) {
  return h('span', { class: `badge sev-badge ${s}` }, SEV_LABEL[s] || s);
}
function statusBadge(s) {
  return h('span', { class: `badge status-badge ${s}` }, STATUS_LABEL[s] || s);
}
function verdictBadge(v) {
  return h('span', { class: `badge verdict-badge ${v}` }, VERDICT_LABEL[v] || v);
}

function fmtDate(sqlDate) {
  if (!sqlDate) return '—';
  const d = new Date(sqlDate.replace(' ', 'T') + (sqlDate.endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return sqlDate;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fileLoc(f) {
  if (!f.file) return '';
  return f.line ? `${f.file}:${f.line}` : f.file;
}

let toastTimer;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 5000 : 2500);
}

function mount(...nodes) {
  const app = document.getElementById('app');
  app.replaceChildren(...nodes);
}

/* ---------------- API ---------------- */

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && state.token && !path.startsWith('/auth/login')) {
    logout();
    throw new Error('Your session has expired. Sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setToken(token) {
  state.token = token;
  store.set('sd_token', token);
}

function logout() {
  setToken(null);
  state.me = null;
  location.hash = '#/login';
  route();
}

async function loadShared() {
  const [users, projects, config] = await Promise.all([
    api('GET', '/users'),
    api('GET', '/projects'),
    api('GET', '/config'),
  ]);
  state.users = users.users;
  state.projects = projects.projects;
  state.publicUrl = config.publicUrl;
  state.mailEnabled = !!config.mailEnabled;
}

/* ---------------- Project covers ---------------- */

const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const coverCache = new Map(); // projectId -> { version, url }

/** Cover images need the auth header, so they're fetched and shown as blob: URLs. */
async function coverUrl(p) {
  if (!p.coverVersion) return null;
  const cached = coverCache.get(p.id);
  if (cached && cached.version === p.coverVersion) return cached.url;
  const res = await fetch(`/api/projects/${p.id}/cover`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) return null;
  const url = URL.createObjectURL(await res.blob());
  if (cached) URL.revokeObjectURL(cached.url);
  coverCache.set(p.id, { version: p.coverVersion, url });
  return url;
}

function hueClass(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `hue-${n % 6}`;
}

/** Cover image, or a coloured placeholder with the project's initial while loading / when there is none. */
function coverEl(p, extraClass) {
  const el = h(
    'div',
    { class: `cover ${hueClass(p.name)} ${extraClass || ''}` },
    h('span', { class: 'cover-initial', 'aria-hidden': 'true' }, p.name.slice(0, 1).toUpperCase())
  );
  coverUrl(p)
    .then((url) => {
      if (url) el.replaceChildren(h('img', { src: url, alt: `${p.name} cover` }));
    })
    .catch(() => {});
  return el;
}

/** Admin buttons to upload / replace / remove a project's cover. Calls onChange() after a change. */
function coverControls(p, onChange) {
  const input = h('input', {
    type: 'file',
    accept: COVER_TYPES.join(','),
    class: 'visually-hidden',
    'aria-label': `Cover image for ${p.name}`,
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!COVER_TYPES.includes(file.type)) return toast('Use a PNG, JPEG, WebP or GIF image.', true);
      if (file.size > COVER_MAX_BYTES) return toast('Image is too large (max 5 MB).', true);
      try {
        const res = await fetch(`/api/projects/${p.id}/cover`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type, Authorization: `Bearer ${state.token}` },
          body: file,
        });
        let data = {};
        try { data = await res.json(); } catch { /* empty */ }
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        toast('Cover updated');
        onChange();
      } catch (ex) {
        toast(ex.message, true);
      }
    },
  });
  const remove = p.coverVersion
    ? h(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick: async () => {
            try {
              await api('DELETE', `/projects/${p.id}/cover`);
              toast('Cover removed');
              onChange();
            } catch (ex) {
              toast(ex.message, true);
            }
          },
        },
        'Remove'
      )
    : null;
  return h(
    'span',
    { class: 'cover-controls' },
    input,
    h('button', { type: 'button', onclick: () => input.click() }, p.coverVersion ? 'Change cover' : 'Upload cover'),
    remove
  );
}

/* ---------------- Shell ---------------- */

function shell(active, ...content) {
  const links = [
    ['projects', '#/', 'Projects'],
    ['findings', '#/findings', 'All findings'],
    ['scans', '#/scans', 'Scans'],
  ];
  if (state.me.role === 'admin') links.push(['users', '#/users', 'Users']);

  return [
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, 'SecPatchlog'),
      h('nav', { class: 'nav' }, links.map(([k, href, label]) => h('a', { href, class: k === active ? 'active' : '' }, label))),
      h(
        'div',
        { class: 'userbox' },
        h('a', { href: '#/account', title: 'Account' }, state.me.name),
        h('button', { class: 'link', onclick: logout }, 'Sign out')
      )
    ),
    h('main', {}, ...content),
  ];
}

/* ---------------- Auth pages ---------------- */

async function renderLogin() {
  let needsSetup = false;
  try {
    needsSetup = (await api('GET', '/setup')).needsSetup;
  } catch (e) {
    toast(e.message, true);
  }
  const err = h('div', { class: 'error-text' });

  if (needsSetup) {
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          try {
            const r = await api('POST', '/setup', Object.fromEntries(fd));
            setToken(r.token);
            location.hash = '#/';
            route();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h('h1', {}, 'Set up SecPatchlog'),
      h('p', { class: 'muted' }, 'Create the first admin account. You can add the rest of the team afterwards.'),
      h('label', { class: 'field' }, 'Name', h('input', { name: 'name', required: true, autocomplete: 'name' })),
      h('label', { class: 'field' }, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h(
        'label',
        { class: 'field' },
        'Password (min 10 characters)',
        h('input', { name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })
      ),
      err,
      h('button', { class: 'primary', type: 'submit' }, 'Create admin')
    );
    return mount(h('div', { class: 'auth-wrap' }, h('div', { class: 'card auth-card' }, form)));
  }

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          const r = await api('POST', '/auth/login', Object.fromEntries(fd));
          setToken(r.token);
          location.hash = '#/';
          route();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('h1', {}, 'Sign in'),
    h('p', { class: 'muted' }, 'SecPatchlog: security findings from the scan pipeline.'),
    h('label', { class: 'field' }, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    h(
      'label',
      { class: 'field' },
      'Password',
      h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })
    ),
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Sign in')
  );
  mount(h('div', { class: 'auth-wrap' }, h('div', { class: 'card auth-card' }, form)));
}

/* ---------------- Findings list ---------------- */

function findingsQuery(projectId) {
  const f = state.filters;
  const p = new URLSearchParams();
  const project = projectId || f.project;
  if (project) p.set('project', project);
  if (f.status === 'all') p.set('status', 'all');
  else if (f.status !== 'active') p.set('status', f.status);
  if (f.severity) p.set('severity', f.severity);
  if (f.assignee) p.set('assignee', f.assignee);
  if (f.verdict === 'all') p.set('includeFalsePositives', '1');
  else if (f.verdict) p.set('verdict', f.verdict);
  if (f.q) p.set('q', f.q);
  return p.toString();
}

/**
 * Findings list. With { projectId } it shows one project's findings under its cover (the project page);
 * without it, findings across all projects with a project filter (the "All findings" page).
 * Both share the same status / severity / assignee / verdict / search filters.
 */
async function renderFindings(opts = {}) {
  const scopedId = opts.projectId ? String(opts.projectId) : '';
  const project = scopedId ? state.projects.find((p) => String(p.id) === scopedId) : null;
  if (scopedId && !project) {
    mount(...shell('projects', h('a', { href: '#/' }, '← All projects'), h('div', { class: 'card empty' }, 'Project not found.')));
    return;
  }

  const tilesEl = h('div', { class: 'tiles' });
  const tableEl = h('div', { class: 'card table-wrap' }, h('div', { class: 'empty' }, 'Loading…'));
  const countEl = h('span', { class: 'muted' });

  async function refresh() {
    saveFilters();
    const statsProject = scopedId || state.filters.project;
    const statsQ = statsProject ? `?project=${statsProject}` : '';
    try {
      const [stats, list] = await Promise.all([api('GET', `/stats${statsQ}`), api('GET', `/findings?${findingsQuery(scopedId)}`)]);
      drawTiles(stats);
      drawTable(list.findings, list.limit);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function drawTiles(stats) {
    const tiles = SEVERITIES.map((s) =>
      h(
        'button',
        {
          class: `tile sev-${s}${state.filters.severity === s ? ' selected' : ''}`,
          title: `Show open ${SEV_LABEL[s]} findings`,
          onclick: () => {
            state.filters.severity = state.filters.severity === s ? '' : s;
            state.filters.status = 'active';
            sevSel.value = state.filters.severity;
            statusSel.value = 'active';
            refresh();
          },
        },
        h('div', { class: 'n' }, stats.bySeverity[s]),
        h('div', { class: 'l' }, `${SEV_LABEL[s]} open`)
      )
    );
    tiles.push(
      h(
        'button',
        {
          class: `tile${state.filters.assignee === 'me' ? ' selected' : ''}`,
          title: 'Show findings assigned to me',
          onclick: () => {
            state.filters.assignee = state.filters.assignee === 'me' ? '' : 'me';
            assigneeSel.value = state.filters.assignee;
            refresh();
          },
        },
        h('div', { class: 'n' }, stats.mine),
        h('div', { class: 'l' }, 'Assigned to me')
      )
    );
    tilesEl.replaceChildren(...tiles);
  }

  function drawTable(findings, limit) {
    countEl.textContent = `${findings.length}${findings.length >= limit ? '+' : ''} finding${findings.length === 1 ? '' : 's'}`;
    if (!findings.length) {
      tableEl.replaceChildren(h('div', { class: 'empty' }, 'No findings match these filters.'));
      return;
    }
    const showProject = !scopedId && !state.filters.project && state.projects.length > 1;
    const rows = findings.map((f) =>
      h(
        'tr',
        { class: 'clickable', onclick: () => (location.hash = `#/findings/${f.id}`) },
        h('td', {}, sevBadge(f.severity)),
        h(
          'td',
          { class: 'title-cell' },
          h('a', { href: `#/findings/${f.id}`, onclick: (e) => e.stopPropagation() }, f.title),
          h('div', { class: 'sub mono' }, fileLoc(f)),
          f.ruleId && f.ruleId !== f.title ? h('div', { class: 'sub' }, f.ruleId) : null
        ),
        showProject ? h('td', {}, f.projectName) : null,
        h('td', {}, verdictBadge(f.verdict)),
        h(
          'td',
          {},
          statusBadge(f.status),
          !f.inLatestScan && f.status !== 'done' ? h('div', {}, h('span', { class: 'badge ghost', title: 'Not reported by the most recent scan — may already be fixed' }, 'Not in latest scan')) : null
        ),
        h('td', {}, f.assigneeName || h('span', { class: 'muted' }, 'Unassigned')),
        h('td', { class: 'muted' }, fmtDate(f.updatedAt))
      )
    );
    tableEl.replaceChildren(
      h(
        'table',
        { class: 'responsive' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Severity'),
            h('th', {}, 'Finding'),
            showProject ? h('th', {}, 'Project') : null,
            h('th', {}, 'Verdict'),
            h('th', {}, 'Status'),
            h('th', {}, 'Assignee'),
            h('th', {}, 'Updated')
          )
        ),
        h('tbody', {}, rows)
      )
    );
  }

  const f = state.filters;
  const bind = (key) => (e) => {
    state.filters[key] = e.target.value;
    refresh();
  };

  const projectSel = h(
    'select',
    { onchange: bind('project'), 'aria-label': 'Project' },
    options([['', 'All projects'], ...state.projects.map((p) => [p.id, p.name])], f.project)
  );
  const statusSel = h(
    'select',
    { onchange: bind('status'), 'aria-label': 'Status' },
    options(
      [
        ['active', 'Open + in progress'],
        ['open', 'Open'],
        ['in_progress', 'In progress'],
        ['done', 'Done'],
        ['wont_fix', "Won't fix"],
        ['all', 'Any status'],
      ],
      f.status
    )
  );
  const sevSel = h(
    'select',
    { onchange: bind('severity'), 'aria-label': 'Severity' },
    options([['', 'Any severity'], ...SEVERITIES.map((s) => [s, SEV_LABEL[s]])], f.severity)
  );
  const assigneeSel = h(
    'select',
    { onchange: bind('assignee'), 'aria-label': 'Assignee' },
    options(
      [
        ['', 'Anyone'],
        ['me', 'Assigned to me'],
        ['none', 'Unassigned'],
        ...state.users.filter((u) => !u.disabled).map((u) => [u.id, u.name]),
      ],
      f.assignee
    )
  );
  const verdictSel = h(
    'select',
    { onchange: bind('verdict'), 'aria-label': 'Verdict' },
    options(
      [
        ['', 'Real + needs review'],
        ['true_positive', 'True positives'],
        ['needs_review', 'Needs review'],
        ['false_positive', 'False positives'],
        ['all', 'All verdicts'],
      ],
      f.verdict
    )
  );
  let searchTimer;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search title, rule or file…',
    value: f.q,
    'aria-label': 'Search',
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filters.q = e.target.value.trim();
        refresh();
      }, 250);
    },
  });

  if (project) {
    mount(
      ...shell(
        'projects',
        h('a', { href: '#/' }, '← All projects'),
        projectHero(project, countEl),
        tilesEl,
        h('div', { class: 'filters' }, search, statusSel, sevSel, assigneeSel, verdictSel),
        tableEl
      )
    );
    refresh();
    return;
  }

  mount(
    ...shell(
      'findings',
      h('div', { class: 'page-head' }, h('h1', {}, 'All findings'), countEl, h('div', { class: 'spacer' }), projectSel),
      tilesEl,
      h('div', { class: 'filters' }, search, statusSel, sevSel, assigneeSel, verdictSel),
      state.projects.length
        ? tableEl
        : h(
            'div',
            { class: 'card empty' },
            'No projects yet. ',
            state.me.role === 'admin' ? h('a', { href: '#/projects/manage' }, 'Create one') : 'Ask an admin to create one',
            ' to get an ingest key for your pipeline.'
          )
    )
  );
  if (state.projects.length) refresh();
}

/* ---------------- Projects home (cards) ---------------- */

function sevCounts(p) {
  const nonZero = SEVERITIES.filter((s) => p.openBySeverity && p.openBySeverity[s] > 0);
  if (!nonZero.length) return h('span', { class: 'muted' }, 'No open findings');
  return nonZero.map((s) => h('span', { class: `badge sev-badge ${s}`, title: `${SEV_LABEL[s]} open` }, `${p.openBySeverity[s]} ${SEV_LABEL[s]}`));
}

/** Banner at the top of a project's findings page. */
function projectHero(p, countEl) {
  return h(
    'section',
    { class: 'project-hero card' },
    coverEl(p, 'hero-cover'),
    h(
      'div',
      { class: 'hero-body' },
      h('div', { class: 'page-head' }, h('h1', {}, p.name), countEl),
      p.description ? h('p', { class: 'muted' }, p.description) : null,
      h('div', { class: 'badges' }, sevCounts(p)),
      h('p', { class: 'muted small' }, `Last scan: ${fmtDate(p.lastScanAt)}`),
      state.me.role === 'admin' ? coverControls(p, route) : null
    )
  );
}

async function renderProjectsHome() {
  const isAdmin = state.me.role === 'admin';
  const cards = state.projects.map((p) =>
    h(
      'a',
      { href: `#/projects/${p.id}`, class: 'project-card card' },
      coverEl(p, 'card-cover'),
      h(
        'div',
        { class: 'project-card-body' },
        h('h2', {}, p.name),
        p.description ? h('p', { class: 'muted desc' }, p.description) : null,
        h('div', { class: 'badges' }, sevCounts(p)),
        h('div', { class: 'muted small' }, `${p.openCount} open · last scan ${fmtDate(p.lastScanAt)}`)
      )
    )
  );

  mount(
    ...shell(
      'projects',
      h(
        'div',
        { class: 'page-head' },
        h('h1', {}, 'Projects'),
        h('div', { class: 'spacer' }),
        isAdmin ? h('a', { href: '#/projects/manage', class: 'button' }, 'Manage projects') : null
      ),
      cards.length
        ? h('div', { class: 'project-grid' }, cards)
        : h(
            'div',
            { class: 'card empty' },
            'No projects yet. ',
            isAdmin ? h('a', { href: '#/projects/manage' }, 'Create one') : 'Ask an admin to create one',
            ' to get an ingest key for your pipeline.'
          )
    )
  );
}

/* ---------------- Finding detail ---------------- */

async function renderFinding(id) {
  let data;
  try {
    data = await api('GET', `/findings/${id}`);
  } catch (e) {
    mount(...shell('findings', h('div', { class: 'card empty' }, e.message)));
    return;
  }
  const f = data.finding;

  async function update(patch) {
    try {
      await api('PATCH', `/findings/${id}`, patch);
      toast('Saved');
      renderFinding(id);
    } catch (e) {
      toast(e.message, true);
      renderFinding(id);
    }
  }

  const statusSel = h(
    'select',
    { onchange: (e) => update({ status: e.target.value }) },
    options(Object.entries(STATUS_LABEL), f.status)
  );
  const assignee = h(
    'select',
    { onchange: (e) => update({ assigneeId: e.target.value ? Number(e.target.value) : null }) },
    options(
      [['', 'Unassigned'], ...state.users.filter((u) => !u.disabled || u.id === f.assigneeId).map((u) => [u.id, u.name])],
      f.assigneeId ?? ''
    )
  );
  const sevSel = h(
    'select',
    { onchange: (e) => update({ severity: e.target.value }) },
    options(SEVERITIES.map((s) => [s, SEV_LABEL[s]]), f.severity)
  );

  const commentBox = h('textarea', { placeholder: 'Add a comment…', maxlength: 5000 });
  const commentForm = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!commentBox.value.trim()) return;
        try {
          await api('POST', `/findings/${id}/comments`, { message: commentBox.value });
          renderFinding(id);
        } catch (ex) {
          toast(ex.message, true);
        }
      },
    },
    commentBox,
    h('div', { class: 'form-row' }, h('div', { class: 'spacer' }), h('button', { class: 'primary', type: 'submit' }, 'Comment'))
  );

  const timeline = h(
    'ul',
    { class: 'timeline' },
    data.activity.map((a) =>
      h(
        'li',
        { class: a.kind },
        h('span', { class: 'who' }, a.userName || 'Pipeline'),
        h('span', { class: 'when' }, fmtDate(a.createdAt)),
        h('div', { class: 'msg' }, a.message)
      )
    )
  );

  const assignToMe =
    f.assigneeId !== state.me.id ? h('button', { onclick: () => update({ assigneeId: state.me.id }) }, 'Assign to me') : null;
  const startBtn = f.status === 'open' ? h('button', { onclick: () => update({ status: 'in_progress', ...(f.assigneeId ? {} : { assigneeId: state.me.id }) }) }, 'Start work') : null;
  const doneBtn = f.status !== 'done' ? h('button', { class: 'primary', onclick: () => update({ status: 'done' }) }, 'Mark done') : null;

  mount(
    ...shell(
      'projects',
      h('a', { href: `#/projects/${f.projectId}` }, `← ${f.projectName}`),
      h('h2', { class: 'detail-title' }, f.title),
      h(
        'div',
        { class: 'badges' },
        sevBadge(f.severity),
        verdictBadge(f.verdict),
        statusBadge(f.status),
        f.inLatestScan ? null : h('span', { class: 'badge ghost' }, 'Not in latest scan')
      ),
      h('div', { class: 'form-row detail-actions' }, assignToMe, startBtn, doneBtn),
      h(
        'div',
        { class: 'grid-2' },
        h(
          'div',
          { class: 'stack' },
          f.reasoning ? h('div', { class: 'card' }, h('h3', {}, 'Why'), h('div', { class: 'prose' }, f.reasoning)) : null,
          f.fix ? h('div', { class: 'card' }, h('h3', {}, 'Suggested fix'), h('pre', { class: 'block' }, f.fix)) : null,
          f.locations.length
            ? h(
                'div',
                { class: 'card' },
                h('h3', {}, `Locations (${f.locations.length})`),
                h('ul', { class: 'locations mono' }, f.locations.map((l) => h('li', {}, l)))
              )
            : null,
          h('div', { class: 'card' }, h('h3', {}, 'Activity'), commentForm, timeline)
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'card stack' },
            h('label', { class: 'field' }, 'Status', statusSel),
            h('label', { class: 'field' }, 'Assignee', assignee),
            h(
              'label',
              { class: 'field' },
              f.severityLocked ? 'Severity (set manually)' : 'Severity',
              sevSel
            )
          ),
          h(
            'div',
            { class: 'card' },
            h(
              'dl',
              { class: 'meta' },
              h('dt', {}, 'Project'), h('dd', {}, f.projectName),
              h('dt', {}, 'Rule'), h('dd', { class: 'mono' }, f.ruleId || '—'),
              h('dt', {}, 'Location'), h('dd', { class: 'mono' }, fileLoc(f) || '—'),
              h('dt', {}, 'First seen'), h('dd', {}, h('a', { href: `#/scans/${f.firstSeenScanId}` }, `Scan #${f.firstSeenScanId}`), ' · ', fmtDate(f.createdAt)),
              h('dt', {}, 'Last seen'), h('dd', {}, h('a', { href: `#/scans/${f.lastSeenScanId}` }, `Scan #${f.lastSeenScanId}`)),
              h('dt', {}, 'Resolved'), h('dd', {}, fmtDate(f.resolvedAt))
            )
          )
        )
      )
    )
  );
}

/* ---------------- Scans ---------------- */

async function renderScans() {
  let scans;
  try {
    scans = (await api('GET', '/scans')).scans;
  } catch (e) {
    return toast(e.message, true);
  }
  const body = scans.length
    ? h(
        'table',
        { class: 'responsive' },
        h(
          'thead',
          {},
          h('tr', {}, ['Scan', 'Project', 'Branch / commit', 'Findings', 'New', 'Reopened', 'Received'].map((t) => h('th', {}, t)))
        ),
        h(
          'tbody',
          {},
          scans.map((s) =>
            h(
              'tr',
              { class: 'clickable', onclick: () => (location.hash = `#/scans/${s.id}`) },
              h('td', {}, h('a', { href: `#/scans/${s.id}` }, `#${s.id}`)),
              h('td', {}, s.project_name),
              h('td', { class: 'mono' }, [s.branch, s.commit_sha && s.commit_sha.slice(0, 8)].filter(Boolean).join(' @ ') || '—'),
              h('td', {}, s.finding_count),
              h('td', {}, s.new_count),
              h('td', {}, s.reopened_count),
              h('td', { class: 'muted' }, fmtDate(s.received_at))
            )
          )
        )
      )
    : h('div', { class: 'empty' }, 'No scans received yet.');

  mount(...shell('scans', h('div', { class: 'page-head' }, h('h1', {}, 'Scans')), h('div', { class: 'card table-wrap' }, body)));
}

async function renderScan(id) {
  let scan;
  try {
    scan = (await api('GET', `/scans/${id}`)).scan;
  } catch (e) {
    return mount(...shell('scans', h('div', { class: 'card empty' }, e.message)));
  }
  const isHttp = scan.run_url && /^https?:\/\//i.test(scan.run_url);
  mount(
    ...shell(
      'scans',
      h('a', { href: '#/scans' }, '← All scans'),
      h('h2', { class: 'detail-title' }, `Scan #${scan.id} · ${scan.project_name}`),
      h(
        'div',
        { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h(
          'dl',
          { class: 'meta' },
          h('dt', {}, 'Received'), h('dd', {}, fmtDate(scan.received_at)),
          h('dt', {}, 'Branch'), h('dd', { class: 'mono' }, scan.branch || '—'),
          h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, scan.commit_sha || '—'),
          h('dt', {}, 'Triggered by'), h('dd', {}, scan.triggered_by || '—'),
          h('dt', {}, 'Engine'), h('dd', {}, [scan.engine, scan.model].filter(Boolean).join(' · ') || '—'),
          h('dt', {}, 'Findings'), h('dd', {}, `${scan.finding_count} (${scan.new_count} new, ${scan.reopened_count} reopened)`),
          h('dt', {}, 'Run'), h('dd', {}, isHttp ? h('a', { href: scan.run_url, target: '_blank', rel: 'noopener noreferrer' }, scan.run_url) : scan.run_url || '—')
        )
      ),
      scan.summary ? h('div', { class: 'card' }, h('h3', {}, 'Summary'), h('div', { class: 'prose' }, scan.summary)) : null,
      scan.report_markdown
        ? h('div', { class: 'card' }, h('h3', {}, 'Full AI report'), h('pre', { class: 'block' }, scan.report_markdown))
        : null
      )
    )
  );
}

/* ---------------- Projects ---------------- */

function keyBox(project, apiKey) {
  const base = state.publicUrl || window.location.origin;
  const ingestUrl = `${base}/api/ingest`;
  const gateUrl = `${base}/api/should-scan`;
  const copy = (text) => () =>
    navigator.clipboard.writeText(text).then(
      () => toast('Copied'),
      () => toast('Copy failed — select and copy manually', true)
    );
  return h(
    'div',
    { class: 'keybox' },
    h('strong', {}, `API key for ${project}`),
    h('div', { class: 'muted' }, 'Copy it now — it will not be shown again.'),
    h('code', {}, apiKey),
    h('button', { onclick: copy(apiKey) }, 'Copy key'),
    h('p', { class: 'muted' }, 'Put these in the repo .env (or CI secrets) to send triage results here:'),
    h('code', {}, `TRIAGE_REPORT_URL=${ingestUrl}\nTRIAGE_REPORT_TOKEN=${apiKey}`),
    h('button', { onclick: copy(`TRIAGE_REPORT_URL=${ingestUrl}\nTRIAGE_REPORT_TOKEN=${apiKey}`) }, 'Copy both lines'),
    h('p', { class: 'muted' }, 'Scan gate for GitHub Actions (TRIAGE_GATE_URL secret):'),
    h('code', {}, gateUrl),
    state.publicUrl
      ? null
      : h(
          'p',
          { class: 'muted' },
          'These URLs use the address in your browser. If CI reaches SecPatchlog at a different address, set PUBLIC_URL in secpatchlog/.env and restart.'
        )
  );
}

/** Admin control for a project's minimum days between scans (empty = server default). */
function intervalInput(p) {
  const input = h('input', {
    type: 'number',
    min: 0,
    max: 365,
    step: 'any',
    class: 'interval-input',
    'aria-label': `Days between scans for ${p.name}`,
    placeholder: `${p.effectiveScanIntervalDays} (default)`,
    value: p.scanIntervalDays ?? '',
    onchange: async (e) => {
      const raw = e.target.value.trim();
      try {
        const r = await api('PATCH', `/projects/${p.id}`, { scanIntervalDays: raw === '' ? null : Number(raw) });
        toast(
          raw === ''
            ? `${p.name}: using the default (${r.project.effectiveScanIntervalDays} days)`
            : `${p.name}: scans at most every ${r.project.effectiveScanIntervalDays} days`
        );
      } catch (ex) {
        toast(ex.message, true);
        e.target.value = p.scanIntervalDays ?? '';
      }
    },
  });
  return h('span', { class: 'interval' }, input, h('span', { class: 'muted' }, 'days'));
}

async function renderProjects() {
  await loadShared();
  const isAdmin = state.me.role === 'admin';
  const keyArea = h('div');

  const createForm = isAdmin
    ? h(
        'form',
        {
          class: 'card stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
              const r = await api('POST', '/projects', Object.fromEntries(fd));
              await renderProjects();
              document.getElementById('key-area').replaceChildren(keyBox(r.project.name, r.apiKey));
            } catch (ex) {
              toast(ex.message, true);
            }
          },
        },
        h('h2', {}, 'New project'),
        h(
          'div',
          { class: 'form-row' },
          h('label', { class: 'field' }, 'Name', h('input', { name: 'name', required: true, maxlength: 100, placeholder: 'e.g. ghanachamber-react' })),
          h('label', { class: 'field' }, 'Description', h('input', { name: 'description', maxlength: 500 })),
          h('button', { class: 'primary', type: 'submit' }, 'Create project')
        )
      )
    : null;
  keyArea.id = 'key-area';

  const rows = state.projects.map((p) => {
    let confirming = false;
    const rotateBtn = isAdmin
      ? h('button', {
          class: 'danger',
          onclick: async (e) => {
            if (!confirming) {
              confirming = true;
              e.target.textContent = 'Click again to confirm';
              setTimeout(() => {
                confirming = false;
                e.target.textContent = 'Rotate key';
              }, 4000);
              return;
            }
            try {
              const r = await api('POST', `/projects/${p.id}/rotate-key`);
              await renderProjects();
              document.getElementById('key-area').replaceChildren(keyBox(p.name, r.apiKey));
            } catch (ex) {
              toast(ex.message, true);
            }
          },
        }, 'Rotate key')
      : null;
    return h(
      'tr',
      {},
      h('td', {}, h('div', { class: 'cover-thumb-row' }, coverEl(p, 'thumb-cover'), isAdmin ? coverControls(p, renderProjects) : null)),
      h('td', {}, h('a', { href: `#/projects/${p.id}` }, h('strong', {}, p.name)), p.description ? h('div', { class: 'sub' }, p.description) : null),
      h('td', {}, h('a', { href: `#/projects/${p.id}` }, `${p.openCount} open`)),
      h('td', { class: 'muted' }, fmtDate(p.lastScanAt)),
      h('td', {}, isAdmin ? intervalInput(p) : `${p.effectiveScanIntervalDays} days`),
      h('td', { class: 'mono' }, `${p.keyPrefix}…`),
      isAdmin ? h('td', {}, rotateBtn) : null
    );
  });

  mount(
    ...shell(
      'projects',
      h('a', { href: '#/' }, '← All projects'),
      h('div', { class: 'page-head' }, h('h1', {}, 'Manage projects')),
      h(
        'div',
        { class: 'stack' },
        keyArea,
        createForm,
        h(
          'div',
          { class: 'card table-wrap' },
          rows.length
            ? h(
                'table',
                { class: 'responsive' },
                h('thead', {}, h('tr', {}, ['Cover', 'Project', 'Open findings', 'Last scan', 'Scan at most every', 'Key', isAdmin ? '' : null].filter((x) => x !== null).map((t) => h('th', {}, t)))),
                h('tbody', {}, rows)
              )
            : h('div', { class: 'empty' }, 'No projects yet.')
        )
      )
    )
  );
}

/* ---------------- Users (admin) ---------------- */

async function renderUsers() {
  if (state.me.role !== 'admin') {
    location.hash = '#/';
    return;
  }
  await loadShared();

  async function patch(id, body, msg) {
    try {
      await api('PATCH', `/users/${id}`, body);
      toast(msg || 'Saved');
      renderUsers();
    } catch (e) {
      toast(e.message, true);
      renderUsers();
    }
  }

  const createForm = h(
    'form',
    {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = Object.fromEntries(new FormData(e.target));
          body.sendEmail = body.sendEmail === 'on';
          const r = await api('POST', '/users', body);
          if (r.email?.sent) toast(`User created. Sign-in details emailed to ${r.user.email}`);
          else if (r.email?.error) toast(`User created, but ${r.email.error.charAt(0).toLowerCase()}${r.email.error.slice(1)}`, true);
          else toast('User created');
          renderUsers();
        } catch (ex) {
          toast(ex.message, true);
        }
      },
    },
    h('h2', {}, 'Add team member'),
    h(
      'div',
      { class: 'form-row' },
      h('label', { class: 'field' }, 'Name', h('input', { name: 'name', required: true, maxlength: 100 })),
      h('label', { class: 'field' }, 'Email', h('input', { name: 'email', type: 'email', required: true })),
      h('label', { class: 'field' }, 'Temporary password', h('input', { name: 'password', type: 'text', required: true, minlength: 10, autocomplete: 'off' })),
      h('label', { class: 'field' }, 'Role', h('select', { name: 'role' }, options([['member', 'Member'], ['admin', 'Admin']], 'member'))),
      h('button', { class: 'primary', type: 'submit' }, 'Add')
    ),
    state.mailEnabled
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'sendEmail', checked: true }), 'Email the sign-in details to the new user')
      : null
  );

  const rows = state.users.map((u) => {
    const self = u.id === state.me.id;
    const pw = h('input', { type: 'text', placeholder: 'New password', minlength: 10, autocomplete: 'off' });
    return h(
      'tr',
      {},
      h('td', {}, h('strong', {}, u.name), self ? h('span', { class: 'muted' }, ' (you)') : null, h('div', { class: 'sub' }, u.email)),
      h(
        'td',
        {},
        h('select', { disabled: self, onchange: (e) => patch(u.id, { role: e.target.value }) }, options([['member', 'Member'], ['admin', 'Admin']], u.role))
      ),
      h(
        'td',
        {},
        u.disabled ? h('span', { class: 'badge' }, 'Disabled') : h('span', { class: 'badge status-badge done' }, 'Active'),
        ' ',
        self ? null : h('button', { class: 'link', onclick: () => patch(u.id, { disabled: !u.disabled }) }, u.disabled ? 'Enable' : 'Disable')
      ),
      h(
        'td',
        {},
        h(
          'form',
          {
            class: 'form-row',
            onsubmit: (e) => {
              e.preventDefault();
              patch(u.id, { password: pw.value }, 'Password reset');
            },
          },
          pw,
          h('button', { type: 'submit' }, 'Reset')
        )
      )
    );
  });

  mount(
    ...shell(
      'users',
      h('div', { class: 'page-head' }, h('h1', {}, 'Users')),
      h(
        'div',
        { class: 'stack' },
        createForm,
        h(
          'div',
          { class: 'card table-wrap' },
          h(
            'table',
            { class: 'responsive' },
            h('thead', {}, h('tr', {}, ['User', 'Role', 'Status', 'Reset password'].map((t) => h('th', {}, t)))),
            h('tbody', {}, rows)
          )
        )
      )
    )
  );
}

/* ---------------- Account ---------------- */

function renderAccount() {
  const err = h('div', { class: 'error-text' });
  const form = h(
    'form',
    {
      class: 'card stack auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        if (fd.next !== fd.confirm) {
          err.textContent = 'New passwords do not match.';
          return;
        }
        try {
          const r = await api('POST', '/auth/password', { current: fd.current, next: fd.next });
          setToken(r.token);
          form.reset();
          err.textContent = '';
          toast('Password changed');
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('h2', {}, 'Change password'),
    h('label', { class: 'field' }, 'Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', { class: 'field' }, 'New password', h('input', { name: 'next', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
    h('label', { class: 'field' }, 'Confirm new password', h('input', { name: 'confirm', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Change password')
  );
  mount(
    ...shell(
      '',
      h('div', { class: 'page-head' }, h('h1', {}, 'Account')),
      h('p', { class: 'muted' }, `${state.me.name} · ${state.me.email} · ${state.me.role}`),
      form
    )
  );
}

/* ---------------- Router ---------------- */

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';

  if (!state.token) {
    if (hash !== '/login') history.replaceState(null, '', '#/login');
    return renderLogin();
  }

  try {
    if (!state.me) {
      state.me = (await api('GET', '/auth/me')).user;
    }
    await loadShared();
  } catch (e) {
    if (state.token) toast(e.message, true);
    return;
  }

  if (hash === '/login') {
    history.replaceState(null, '', '#/');
    return renderProjectsHome();
  }
  let m;
  if (hash === '/findings') return renderFindings();
  if ((m = hash.match(/^\/findings\/(\d+)$/))) return renderFinding(Number(m[1]));
  if (hash === '/scans') return renderScans();
  if ((m = hash.match(/^\/scans\/(\d+)$/))) return renderScan(Number(m[1]));
  if (hash === '/projects/manage') return renderProjects();
  if ((m = hash.match(/^\/projects\/(\d+)$/))) return renderFindings({ projectId: Number(m[1]) });
  if (hash === '/projects') return renderProjectsHome();
  if (hash === '/users') return renderUsers();
  if (hash === '/account') return renderAccount();
  return renderProjectsHome();
}

window.addEventListener('hashchange', route);
route();
