# SecPatchlog

A small standalone app that receives AI-triaged security scan results and lets the team work through them:
findings are listed most-severe first, and signed-in users can assign them, move them through
**Open → In progress → Done / Won't fix**, change severity and comment. Each change is logged.

```
opengrep scan ──► AI triage (scripts/triage-opengrep.js) ──► POST /api/ingest ──► SecPatchlog ──► team
```

To connect a repository, follow **[SETUP-README.md](SETUP-README.md)**.

- Backend: Node ≥ 22.13 + Express 5. Storage: SQLite through Node's built-in `node:sqlite`, so there's no DB server.
- Frontend: plain HTML/JS in `public/`, served by the same server.

## Run it

```bash
cd secpatchlog
npm install
cp .env.example .env      # optional, see below
npm start                 # http://localhost:4400
```

On first visit you'll get a **setup page** to create the first admin. You can also set `ADMIN_EMAIL` and `ADMIN_PASSWORD`
in `.env` so the admin is created on first start. After that:

1. **Projects → Manage projects → New project**. This shows the project's **API key once**, so copy it.
2. **Users → Add team member** for each person, with a temporary password. They can change it under their name → Account.

### Projects and covers

- The home page is a grid of project cards, each with a cover image, its open counts by severity and when it was last scanned.
- Clicking a card opens that project's findings, with the severity tiles and all the filters (status, severity, assignee, verdict, search).
- **All findings** in the top bar still lists findings across every project, with a project filter.
- Admins can upload, change or remove a cover on the project page or under **Manage projects**.
  - Formats: PNG, JPEG, WebP or GIF, up to 5 MB. SVG is refused because it can carry script.
  - The file's contents are checked against its type.
  - Covers are stored in the SQLite DB (`project_covers` table) and need a signed-in user to view.
- Under **Manage projects**, admins can **Edit** a project (its name and description; the API key stays the same) or **Delete** it.
  - Deleting is permanent. It removes the project with all its scans, findings, comments, activity and cover, and its API key stops working.
  - You must type the project name to confirm. The API checks it too: `DELETE /api/projects/:id` with body `{"confirmName": "<exact name>"}`.
  - Each delete is logged to the server console.

| Env var          | Default            | Notes                                                    |
| ---------------- | ------------------ | -------------------------------------------------------- |
| `PORT`           | `4400`             |                                                          |
| `PUBLIC_URL`     | browser address    | Address CI uses to reach SecPatchlog, e.g. `https://security.example.com`. Used for the URLs shown with a new or rotated key |
| `DB_PATH`        | `data/security.db` | Relative to this folder. Back this file up.              |
| `SESSION_SECRET` | generated          | If empty, a random one is generated and stored in the DB |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Only used when there are no users yet |
| `TRUST_PROXY`    | `0`                | Set `1` behind nginx or a load balancer so rate limiting sees real IPs |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | — / `587` / auto | SMTP server for emailing new users. Mail is off while `SMTP_HOST` is empty. `SMTP_SECURE` defaults to on for port 465 (TLS); port 587 uses STARTTLS |
| `MAIL_FROM`      | `SMTP_USER`        | Sender, e.g. `SecPatchlog <security@example.com>` |

### Welcome emails

When SMTP is configured, **Users → Add team member** shows an "Email the sign-in details" checkbox (ticked by default).
The new user gets the sign-in link (`PUBLIC_URL`, else the address the admin is using), their email and the temporary
password, and is asked to change it under **Account**. If sending fails the user is still created, the admin sees a
warning, and the error is in the server log (`pm2 logs`).

## Sending results from the triage script

In the **repo root** `.env` (or as CI secrets):

```
TRIAGE_REPORT_URL=https://your-secpatchlog-host/api/ingest
TRIAGE_REPORT_TOKEN=sdk_...the project key...
```

Then `npm run triage` scans, triages and posts the results. To resend the last results without running again:
`npm run triage -- --send-only`.

## Scan gate: `GET /api/should-scan`

CI calls this **before** installing tools or spending AI compute. It uses the same project API key as ingest:

```bash
curl -s https://your-secpatchlog-host/api/should-scan -H "Authorization: Bearer $TRIAGE_REPORT_TOKEN"
# -> 1   project has never been scanned, or its last scan is at least N days old: scan now
# -> 0   it was scanned within the last N days: skip
```

- **N** is set per project on the **Projects** page under "Scan at most every … days". Leave it empty to use
  the server default from `SCAN_INTERVAL_DAYS` (7). Fractions work: `0.5` is 12 hours. `0` means always scan.
- `?format=json` returns the details:
  `{ scan, intervalDays, lastScanAt, lastScanAgeDays, nextScanDueAt, ... }`
- The "last scan" is the last time results were **received** through `/api/ingest`.
- `npm run triage` checks this endpoint first and exits 0 without scanning when it says `0`.
  - `--force` overrides the check.
  - If SecPatchlog can't be reached, the script scans anyway, so a SecPatchlog outage never silently stops scanning.
  - It derives the URL from `TRIAGE_REPORT_URL` (`…/ingest` → `…/should-scan`). Set `TRIAGE_GATE_URL` to override that.

## Ingest API

`POST /api/ingest`, header `Authorization: Bearer <project API key>`. The key decides which project the scan belongs to.

```json
{
  "branch": "main",
  "commit": "cc253c8b...",
  "runUrl": "https://github.com/org/repo/actions/runs/123",
  "triggeredBy": "Holmes-000",
  "engine": "claude",
  "model": "claude-sonnet-5-5",
  "summary": "Overall assessment…",
  "reportMarkdown": "# full AI report…",
  "findings": [
    {
      "ruleId": "express-path-join-resolve-traversal",
      "title": "Unauthenticated file deletion",
      "file": "backend/src/controllers/x.js",
      "line": 305,
      "locations": ["backend/src/controllers/x.js:305"],
      "verdict": "true_positive",
      "severity": "critical",
      "reasoning": "…",
      "fix": "…",
      "fingerprint": "optional stable id"
    }
  ]
}
```

- `verdict` is one of `true_positive`, `needs_review` or `false_positive`. Loose forms such as `"True positive"` are accepted.
- `severity` is one of `critical`, `high`, `medium`, `low` or `info`.
- Limits: 20 MB body and 5,000 findings per scan.
- The response is `201 { scanId, project, total, created, updated, reopened }`.

How findings are matched across scans:

- Each finding is identified by `fingerprint`. If you don't send one, it's `sha256(ruleId|file|line)`. A matching finding is
  **updated, not duplicated**.
- If a finding marked **Done** is reported again (and isn't a false positive), it's **reopened** and the reopen is
  logged.
- If a user changed a finding's severity by hand, later scans don't overwrite it.
- Findings missing from the project's latest scan are tagged **Not in latest scan**, which usually means they're fixed.
- False positives are stored but hidden by default. Use the verdict filter to see them.

curl example:

```bash
curl -X POST http://localhost:4400/api/ingest \
  -H "Authorization: Bearer $TRIAGE_REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d @opengrep-triage.json
```

(`opengrep-triage.json` written by the triage script is already in this format. The extra `meta` key is ignored.)

## Connecting a repo (GitHub Actions)

**See [SETUP-README.md](SETUP-README.md)** for the full, tested setup: creating the project, copying the
workflow and script from [`templates/`](templates/), preparing the runner, adding the secrets and variables, the
first run and troubleshooting.

In short, each repo gets:

- `.github/workflows/security-scan.yml`: after a successful deploy, a gate job asks `/api/should-scan`. If a scan
  is due, a job in a `node:24` container checks out the deployed commit, runs opengrep, has Claude Code (or opencode)
  triage the results read-only, and posts them to `/api/ingest`.
- `scripts/triage-opengrep.js`: the scan + triage + send script, also usable locally (`npm run triage`).

## Roles

| Action                                                    | Member | Admin |
| --------------------------------------------------------- | :----: | :---: |
| View findings, scans and projects                         |   ✓    |   ✓   |
| Assign, change status or severity, comment                |   ✓    |   ✓   |
| Create, edit and delete projects, rotate keys, set covers |        |   ✓   |
| Add users, change roles, disable users, reset passwords   |        |   ✓   |

## Security notes

- Passwords are hashed with scrypt. Project API keys are stored only as SHA-256 hashes.
- Sessions are HMAC-signed tokens that last 7 days. Changing or resetting a password, or disabling a user, ends their existing sessions.
- Login and setup are rate-limited per IP.
- Responses carry a strict CSP, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. The UI never puts data into `innerHTML`.
- Run it behind HTTPS (a reverse proxy) in production, because the API key and session tokens travel in headers.
