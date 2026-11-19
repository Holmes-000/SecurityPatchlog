# SecPatchlog

A small standalone app that receives AI-triaged security scan results and lets the team work through them:
findings are listed most-severe first, and signed-in users can assign them, move them through
**Open → In progress → Done / Won't fix**, change severity and comment. Each change is logged.

```
opengrep scan ──► AI triage (scripts/triage-opengrep.js) ──► POST /api/ingest ──► SecPatchlog ──► team
```

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

| Env var          | Default            | Notes                                                    |
| ---------------- | ------------------ | -------------------------------------------------------- |
| `PORT`           | `4400`             |                                                          |
| `PUBLIC_URL`     | browser address    | Address CI uses to reach SecPatchlog, e.g. `https://security.example.com`. Used for the URLs shown with a new or rotated key |
| `DB_PATH`        | `data/security.db` | Relative to this folder. Back this file up.              |
| `SESSION_SECRET` | generated          | If empty, a random one is generated and stored in the DB |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Only used when there are no users yet |
| `TRUST_PROXY`    | `0`                | Set `1` behind nginx or a load balancer so rate limiting sees real IPs |

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

## GitHub Action (example, not enabled)

This assumes opengrep rules are available in the runner, and an AI key for opencode
(e.g. `ANTHROPIC_API_KEY`) is stored as a repo secret:

```yaml
name: security-scan
on:
  push: { branches: [main] }
  workflow_dispatch:
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      # Ask SecPatchlog first; everything below is skipped if the project was scanned recently
      - id: gate
        run: |
          echo "scan=$(curl -sf "${{ secrets.TRIAGE_GATE_URL }}" \
            -H "Authorization: Bearer ${{ secrets.TRIAGE_REPORT_TOKEN }}" || echo 1)" >> "$GITHUB_OUTPUT"
      - if: steps.gate.outputs.scan == '1'
        uses: actions/checkout@v4
      - if: steps.gate.outputs.scan == '1'
        uses: actions/setup-node@v4
        with: { node-version: 24 }
      - if: steps.gate.outputs.scan == '1'
        run: |
          curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash
          git clone --depth 1 https://github.com/opengrep/opengrep-rules ~/opengrep-rules
          npm i -g opencode-ai
      - if: steps.gate.outputs.scan == '1'
        run: node scripts/triage-opengrep.js --engine opencode --force   # gate already checked
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TRIAGE_REPORT_URL: ${{ secrets.TRIAGE_REPORT_URL }}
          TRIAGE_REPORT_TOKEN: ${{ secrets.TRIAGE_REPORT_TOKEN }}
```

## Roles

| Action                                                    | Member | Admin |
| --------------------------------------------------------- | :----: | :---: |
| View findings, scans and projects                         |   ✓    |   ✓   |
| Assign, change status or severity, comment                |   ✓    |   ✓   |
| Create projects, rotate API keys, set cover images        |        |   ✓   |
| Add users, change roles, disable users, reset passwords   |        |   ✓   |

## Security notes

- Passwords are hashed with scrypt. Project API keys are stored only as SHA-256 hashes.
- Sessions are HMAC-signed tokens that last 7 days. Changing or resetting a password, or disabling a user, ends their existing sessions.
- Login and setup are rate-limited per IP.
- Responses carry a strict CSP, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. The UI never puts data into `innerHTML`.
- Run it behind HTTPS (a reverse proxy) in production, because the API key and session tokens travel in headers.
