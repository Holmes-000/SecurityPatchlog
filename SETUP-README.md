# Connecting a repo to SecPatchlog

This guide sets up the **Security Scan** pipeline on another repository. When it's done, every successful deploy
can trigger a scan, and the results land in SecPatchlog for the team to assign and fix:

```
push ─► your deploy workflow ─► Security Scan workflow
                                   │
                                   ├─ gate job:  "is a scan due?"  ── asks SecPatchlog ── 0 → stop (≈5 s)
                                   │
                                   └─ scan job (node:24 container, only if due):
                                        checkout deployed commit
                                        install opengrep + Claude Code
                                        opengrep scan ─► AI triage (reads the whole repo, read-only)
                                        POST results ─► SecPatchlog ─► team assigns / fixes
                                        report on the run page + downloadable artifact (14 days)
```

The first repo set up this way is **ghanachamber-react**. The files to copy are in [`templates/`](templates/) in this
repo.

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Create the project in SecPatchlog](#2-create-the-project-in-secpatchlog)
3. [Add the files to the repo](#3-add-the-files-to-the-repo)
4. [Edit the workflow for this repo](#4-edit-the-workflow-for-this-repo)
5. [Prepare the runner](#5-prepare-the-runner)
6. [Add secrets and variables on GitHub](#6-add-secrets-and-variables-on-github)
7. [Merge and run it the first time](#7-merge-and-run-it-the-first-time)
8. [How it behaves day to day](#8-how-it-behaves-day-to-day)
9. [Running a scan on your own machine](#9-running-a-scan-on-your-own-machine)
10. [Settings reference](#10-settings-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Security notes](#12-security-notes)

---

## 1. Before you start

You need:

| What | Notes |
| --- | --- |
| SecPatchlog admin account | Live at **https://secdashboard.smartinnovationsgh.com** |
| Admin access to the GitHub repo | To add the workflow, environment, secrets and variables |
| A runner that can run Docker | A self-hosted Linux runner with Docker (we use the `marketing` runner, label `markrunner`), or GitHub-hosted `ubuntu-latest` |
| An AI credential | A Claude subscription (`claude setup-token`), an Anthropic API key, or another provider's key (see [Switching the AI provider](#switching-the-ai-provider)) |
| [GitHub CLI](https://cli.github.com/) (`gh`), logged in | Used for the commands below. Everything can also be done in the GitHub web UI. |
| An existing deploy workflow | The scan runs after it succeeds. If there isn't one, see [No deploy workflow?](#no-deploy-workflow) |

---

## 2. Create the project in SecPatchlog

1. Sign in to SecPatchlog as an admin.
2. Go to **Projects → Manage projects → New project**. Use the repo name, e.g. `my-service`.
3. **Copy the API key now** (`sdk_…`). It's shown only once and stored only as a hash. If you lose it, use **Rotate
   key** and update the GitHub secret.
4. The box under the key shows the two URLs you need:
   - ingest URL: `https://secdashboard.smartinnovationsgh.com/api/ingest`
   - gate URL: `https://secdashboard.smartinnovationsgh.com/api/should-scan`
5. Optional: under **Scan at most every … days**, set how often this project may be scanned. Empty uses the server
   default (7 days). `0` means scan after every deploy. The gate uses this to decide whether a deploy triggers a scan.
6. Optional: upload a cover image for the project card.

> The API key decides which project the results belong to. Each repo gets its own project and key; don't share
> keys between repos.

---

## 3. Add the files to the repo

Copy these two files from [`templates/`](templates/) into the **same paths** in the target repo:

| From SecPatchlog | To the target repo |
| --- | --- |
| `templates/.github/workflows/security-scan.yml` | `.github/workflows/security-scan.yml` |
| `templates/scripts/triage-opengrep.js` | `scripts/triage-opengrep.js` |

The script has **no dependencies** (Node ≥ 18 built-ins only), so nothing is added to `package.json` dependencies.

Optional, for local runs, add a script to the repo's root `package.json`:

```json
"scripts": {
  "triage": "node scripts/triage-opengrep.js"
}
```

Add the scan outputs to the repo's `.gitignore`, so a local run never commits a vulnerability report:

```gitignore
# opengrep AI triage
/.env
/opengrep.txt
/opengrep-triage.md
/opengrep-results.sarif
/opengrep-triage.json
/opengrep-triage.raw.txt
```

> If the repo already has a root `.env` that's committed on purpose, leave out the `/.env` line and keep triage
> credentials elsewhere.

---

## 4. Edit the workflow for this repo

Open `.github/workflows/security-scan.yml` and search for **`CHANGE ME`**. There are four values:

| Line | Set it to | Example |
| --- | --- | --- |
| `workflows: ["Deploy"]` | The exact `name:` at the top of the repo's deploy workflow. It must match character for character. | `workflows: ["Deploy Chambers"]` |
| `branches: [main]` | The branch your deploy runs on | `[main]` or `[master]` |
| `runs-on:` (twice: gate and scan jobs) | Your runner's labels. Find them under **repo or org Settings → Actions → Runners**. | `[self-hosted, Linux, X64, markrunner]` or `ubuntu-latest` |
| `environment:` (twice) | The GitHub environment that will hold the secrets (step 6). Any name. | `security-scan`, or an existing one like `chambers` |

Nothing else needs changing.

### Choose the opengrep rule sets (non-JavaScript repos)

By default the scan uses the `javascript`, `typescript` and `generic` rule folders from
[opengrep-rules](https://github.com/opengrep/opengrep-rules). For another language, set the **variable**
`OPENGREP_RULESETS` (step 6) to a comma-separated list of folders:

| Repo | `OPENGREP_RULESETS` |
| --- | --- |
| React / Node (default) | *(leave unset)* = `javascript,typescript,generic` |
| Python | `python,generic` |
| Go | `go,generic` |
| PHP | `php,generic` |
| Java / Kotlin | `java,kotlin,generic` |
| With Docker / Terraform files | add `dockerfile` / `terraform` |

All the available folders are `ai apex bash c clojure csharp dockerfile elixir generic go html java javascript json
kotlin libsonnet ocaml php python ruby rust scala solidity swift terraform typescript yaml`.

The scan always skips `node_modules`, `dist`, `build` and `coverage`.

### No deploy workflow?

If the repo has no deploy workflow to follow, replace the `workflow_run:` block with a schedule or a push trigger.
The gate still stops repeat scans within the interval:

```yaml
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 2 * * 1"     # Mondays 02:00 UTC
  workflow_dispatch: ...      # keep this block as it is
```

With `push`, the scan checks out the pushed commit. `github.event.workflow_run.*` is empty there and the workflow
falls back to `github.sha` automatically. Also change the gate job's
`if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'` to
`if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'`, so push and schedule
runs aren't skipped.

---

## 5. Prepare the runner

The scan job runs inside a `node:24-bookworm` container (`container:` in the workflow), so the runner must be able
to start Docker containers.

### Option A: self-hosted runner (what we use)

Requirements:

- **Linux x64** with **Docker** installed.
- The **runner's user must be in the `docker` group, and the runner service restarted afterwards.** Without that, the job
  fails with `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`.
- **The repo must be allowed to use the runner.** For an org runner, check **org Settings → Actions → Runner groups →
  Default → Repository access**.

Checks on the runner machine:

```bash
# Which user runs the runner?
ps -o user= -p "$(pgrep -f Runner.Listener | head -1)"           # e.g. gitaction

# Is that user in the docker group?
id gitaction                                                      # must list "docker"
sudo usermod -aG docker gitaction                                 # if it doesn't

# Does the RUNNING runner have the group? (it only gets it after a restart)
getent group docker                                               # note the number, e.g. 988
grep Groups /proc/"$(pgrep -f Runner.Listener | head -1)"/status  # must include that number

# Restart the runner service to pick up the group
cd ~/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh start

# Final check
sudo -u gitaction docker version                                  # must show a "Server:" section
```

> Being in the `docker` group is effectively root on that machine, so only let trusted repos use a runner like this.

The first scan on a runner downloads the `node:24-bookworm` image (≈1 GB). Docker keeps it for later runs.

### Option B: GitHub-hosted runner

Set both `runs-on:` lines to `ubuntu-latest`. Docker is already available. This works because SecPatchlog is
reachable from the internet. It uses GitHub Actions minutes; for private repos that's about 5–20 minutes per scan.

---

## 6. Add secrets and variables on GitHub

All settings go in **one GitHub environment**, the one named under `environment:` in the workflow. Run these from
inside the repo's folder. They act on that repo.

```bash
ENV=security-scan        # the environment name you put in the workflow

# Create the environment (skip if it already exists, e.g. "chambers")
gh api --method PUT "repos/{owner}/{repo}/environments/$ENV" >/dev/null

# SecPatchlog
gh secret set TRIAGE_REPORT_URL --env "$ENV" --body "https://secdashboard.smartinnovationsgh.com/api/ingest"
gh secret set TRIAGE_GATE_URL   --env "$ENV" --body "https://secdashboard.smartinnovationsgh.com/api/should-scan"
gh secret set TRIAGE_REPORT_TOKEN --env "$ENV"      # paste the project's sdk_… key when asked

# AI engine
gh variable set TRIAGE_ENGINE      --env "$ENV" --body "claude"
gh variable set TRIAGE_CLAUDE_AUTH --env "$ENV" --body "auto"

# Only for non-JavaScript repos (see step 4)
# gh variable set OPENGREP_RULESETS --env "$ENV" --body "python,generic"
```

### AI credential

**Claude subscription (what we use).** On your own machine, signed in to Claude Code:

```bash
claude setup-token                                   # prints a long-lived token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env "$ENV"   # paste it when asked
```

Run these in **your own terminal**. Don't paste tokens into chats, issues or commit messages.

**Anthropic API key (pay per use)** instead of, or as well as, the subscription:

```bash
gh secret set ANTHROPIC_API_KEY --env "$ENV"
```

With `TRIAGE_CLAUDE_AUTH=auto`, the subscription token is used if it's set, otherwise the API key. Set it to `oauth`
or `apikey` to force one.

### Check

```bash
gh secret list   --env "$ENV"
gh variable list --env "$ENV"
```

You should see `TRIAGE_REPORT_URL`, `TRIAGE_GATE_URL`, `TRIAGE_REPORT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` (or
`ANTHROPIC_API_KEY`), `TRIAGE_ENGINE` and `TRIAGE_CLAUDE_AUTH`.

---

## 7. Merge and run it the first time

1. Commit the workflow, the script and the `.gitignore`/`package.json` changes on a branch, open a PR and **merge it
   into the default branch**. GitHub only runs `workflow_run` and **Run workflow** from the copy on the default
   branch, so nothing happens before the merge.
2. Run it by hand without waiting for a deploy: **Actions → Security Scan → Run workflow**, branch `main`, tick
   **force**.
3. Watch the run:
   - **gate**: `Manual run with force: skipping the gate.`
   - **scan → Install opengrep and the AI tools**: ends with the opengrep version (e.g. `2.0.0`).
   - **scan → Scan, triage and report**:
     ```
     AI engine: claude (auth: oauth)
     [scan] … N findings in M files
     [triage] engine: claude …
     [report] scan #12 for my-service: 9 new, 0 updated, 0 reopened
     ```
     The AI triage takes 5–15 minutes, depending on the number of findings.
4. Check the results:
   - **The run's Summary page** shows the full AI triage report.
   - **Artifacts** has `security-scan-<run id>`, containing the report (`.md`), findings (`.json`), SARIF and raw
     opengrep output. It's kept 14 days.
   - **SecPatchlog**: open the project card. Findings are listed most severe first, ready to assign.

From then on it runs by itself after every successful deploy.

---

## 8. How it behaves day to day

- **After each successful deploy**, the gate asks SecPatchlog whether the project's last scan is older than its
  interval:
  - **No** → the run ends after about 5 seconds and the summary says *"Scanned recently according to SecPatchlog;
    skipping."* No AI cost.
  - **Yes** → a full scan runs and the results are sent.
- **Failed deploys** don't trigger a scan.
- **Force a scan** at any time: **Run workflow** with **force**.
- **Change how often it scans**: SecPatchlog → **Manage projects** → *Scan at most every … days*. No workflow
  change needed.
- **Re-scans don't duplicate findings.** A finding is matched by rule + file + line:
  - one that's still present is **updated**;
  - one marked *Done* that comes back is **reopened**;
  - one that has disappeared gets a *Not in latest scan* badge (usually it was fixed).
- If SecPatchlog is **down**, the gate scans anyway (with a warning), so an outage never silently stops scanning.
  If SecPatchlog **rejects the key** (401/403), the run fails straight away without spending AI time.

---

## 9. Running a scan on your own machine

Useful for trying it out before CI, or for a repo without CI.

1. Install [opengrep](https://github.com/opengrep/opengrep) and clone the rules:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash
   git clone --depth 1 https://github.com/opengrep/opengrep-rules ~/opengrep-rules
   ```
2. Install Claude Code and sign in (`npm i -g @anthropic-ai/claude-code`, then `claude`). Or install opencode and put a
   provider key in `.env`.
3. Create a `.env` in the repo root. It's git-ignored by the step 3 change.
   ```
   TRIAGE_REPORT_URL=https://secdashboard.smartinnovationsgh.com/api/ingest
   TRIAGE_REPORT_TOKEN=sdk_...
   # optional
   # OPENGREP_RULESETS=python,generic
   # OPENGREP_RULES_DIR=/path/to/opengrep-rules
   ```
   Leave out `TRIAGE_REPORT_*` to triage locally without sending anything.
4. Run it:
   ```bash
   npm run triage                      # gate → scan → triage → send
   npm run triage -- --force           # ignore the gate
   npm run triage -- --skip-scan       # re-triage the existing opengrep.txt
   npm run triage -- --send-only       # re-send the last opengrep-triage.json
   npm run triage -- --from-raw        # finish a run whose AI output was saved but not processed
   ```

> A local run and a CI run on the same project are both real scans. Each updates the gate's "last scan" time.

---

## 10. Settings reference

### Secrets (in the environment)

| Name | Required | Purpose |
| --- | --- | --- |
| `TRIAGE_REPORT_URL` | Yes | `https://secdashboard.smartinnovationsgh.com/api/ingest` |
| `TRIAGE_GATE_URL` | Yes | `https://secdashboard.smartinnovationsgh.com/api/should-scan` |
| `TRIAGE_REPORT_TOKEN` | Yes | The project's SecPatchlog API key (`sdk_…`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | One AI credential | Claude subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | One AI credential | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` | Optional | Anthropic-compatible gateway (e.g. OpenRouter, LiteLLM) for Claude Code |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | Optional | For `TRIAGE_ENGINE=opencode` |

### Variables (in the environment, all optional)

| Name | Default | Purpose |
| --- | --- | --- |
| `TRIAGE_ENGINE` | `claude` | `claude` or `opencode` |
| `TRIAGE_CLAUDE_AUTH` | `auto` | `auto` (OAuth token, else API key, else gateway), `oauth`, `apikey`, `gateway` |
| `TRIAGE_MODEL` | tool default | Model override, e.g. `opus`; for opencode e.g. `openrouter/google/gemini-2.5-pro` |
| `OPENGREP_RULESETS` | `javascript,typescript,generic` | opengrep-rules folders to scan with |
| `CLAUDE_CODE_VERSION` / `OPENCODE_VERSION` / `OPENGREP_VERSION` | latest | Pin a tool version if a new release breaks something (e.g. `OPENGREP_VERSION=v2.0.0`) |

### Switching the AI provider

No code change is needed; only settings:

| Use | Set |
| --- | --- |
| Claude subscription | secret `CLAUDE_CODE_OAUTH_TOKEN`, variable `TRIAGE_ENGINE=claude` |
| Anthropic API | secret `ANTHROPIC_API_KEY`, `TRIAGE_ENGINE=claude`, optionally `TRIAGE_CLAUDE_AUTH=apikey` |
| OpenRouter (any model) | secret `OPENROUTER_API_KEY`, `TRIAGE_ENGINE=opencode`, optionally `TRIAGE_MODEL=openrouter/<model>` |
| OpenAI | secret `OPENAI_API_KEY`, `TRIAGE_ENGINE=opencode` |
| Google | secret `GOOGLE_GENERATIVE_AI_API_KEY`, `TRIAGE_ENGINE=opencode` |

opencode can't use a Claude subscription token, only API keys.

---

## 11. Troubleshooting

These are the problems hit while setting up ghanachamber-react, plus the likely ones for a new repo.

| Symptom (in the run log) | Cause | Fix |
| --- | --- | --- |
| Security Scan never starts after a deploy | `workflows: ["…"]` doesn't match the deploy workflow's `name:` exactly, or the workflow isn't on the default branch yet | Fix the name, and merge to the default branch |
| No **Run workflow** button | Workflow file isn't on the default branch | Merge it |
| Job stuck at *Waiting for a runner to pick up this job* | Wrong `runs-on` labels, the runner is offline, or the repo isn't allowed to use the runner group | Check labels and status under Settings → Actions → Runners, and the runner group's repository access |
| `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (followed by `Value cannot be null (Parameter 'ContainerId')`) | Runner user isn't in the `docker` group, or the runner wasn't restarted after adding it | See [step 5](#option-a-self-hosted-runner-what-we-use): add to the group, then **restart the runner service** |
| `error  Could not get files from git ls-files` / `detected dubious ownership` | Container steps run as root but the checkout belongs to the runner user | Already handled: the workflow runs `git config --global --add safe.directory "$GITHUB_WORKSPACE"`. If you edited the workflow, keep that line. |
| `fatal: destination path '…/opengrep-rules' already exists` | Root-owned leftovers from an earlier run | Already handled by `rm -rf` before the clone and the **Clean up** step. Keep both. |
| `SecPatchlog rejected TRIAGE_REPORT_TOKEN (HTTP 401)` | Wrong or rotated project key | Copy a fresh key (Manage projects → Rotate key) into `TRIAGE_REPORT_TOKEN` |
| `::warning::SecPatchlog gate unavailable (HTTP 000)` | SecPatchlog unreachable from the runner, or a wrong `TRIAGE_GATE_URL` | Check the URL. The scan still runs, but sending results will fail too. |
| `TRIAGE_ENGINE=claude but none of … is set` | No AI secret in **this** environment | Add `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` to the environment named in `environment:` |
| `Failed to authenticate. API Error: 401` | AI token invalid or expired | Run `claude setup-token` again and update the secret |
| `opengrep rules not found: …/python` | `OPENGREP_RULESETS` names a folder that doesn't exist | Use folder names from the list in step 4 |
| `[report] SecPatchlog rejected the results (413)` | Payload over 20 MB or more than 5,000 findings | Narrow `OPENGREP_RULESETS`, or exclude generated code |
| `npm warn install-scripts … @anthropic-ai/claude-code` | npm notice about install scripts | Harmless, Claude Code still works |
| `Warning: cosign is required for --verify-signatures` | The opengrep installer can't verify signatures without cosign | Harmless |
| The run summary shows "skipping" every time | Scan interval is long, or a local run counted as the last scan | Lower the interval in SecPatchlog, or **Run workflow** with **force** |

Recover a finished AI run whose upload failed: download the artifact, put `opengrep-triage.json` in the repo root
locally, then run `npm run triage -- --send-only` with `TRIAGE_REPORT_*` in `.env`.

---

## 12. Security notes

- **The AI is read-only.** Claude Code is limited to the `Read`, `Grep` and `Glob` tools (opencode: edit, bash and
  webfetch denied). It can read the source but can't change files or run commands.
- **No repo token for the AI.** The checkout uses `persist-credentials: false`, so the GitHub token isn't left in
  `.git/config`. The job's `GITHUB_TOKEN` is read-only (`permissions: contents: read`).
- **One AI credential at a time.** The scan step deletes every AI credential except the one chosen, before starting
  the AI tool.
- **Nothing left on the runner.** The **Clean up** step deletes the tools, AI config and report files after every
  run, including failed ones. Reports are kept only as the 14-day artifact and in SecPatchlog.
- **Treat the reports as sensitive.** They describe real vulnerabilities. Keep the repo private, limit who can download
  artifacts, and don't paste reports into public places.
- **Runner trust.** A self-hosted runner whose user is in the `docker` group can effectively act as root on that
  machine. Only give trusted repos access to it.
- **Secrets stay in GitHub.** Secrets are set with `gh secret set` (or the web UI) and masked in logs; none are
  committed. Keep `.env` git-ignored for local runs.

---

## Keeping repos up to date

`templates/` is the reference copy. When the workflow or script is improved, update `templates/` first, then copy
the changes into each connected repo.

> ghanachamber-react's copy predates the `OPENGREP_RULESETS` option. It works as is, since it uses the default rule
> sets. Copy the template versions over when it's convenient.
