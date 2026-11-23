#!/usr/bin/env node
/**
 * opengrep scan + AI triage.
 *
 * 1. Runs opengrep (rule folders from $OPENGREP_RULESETS, default javascript,typescript,generic,
 *    inside $OPENGREP_RULES_DIR or ~/opengrep-rules) and writes opengrep.txt (text) + opengrep-results.sarif.
 * 2. Hands opengrep.txt to a local coding agent (opencode or Claude Code), which
 *    reads the referenced source files and decides whether each finding is real.
 *    The agent runs headless and read-only; its report is saved to opengrep-triage.md
 *    and its structured results to opengrep-triage.json.
 * 3. If TRIAGE_REPORT_URL and TRIAGE_REPORT_TOKEN are set (env or .env), posts the
 *    results to SecPatchlog (POST /api/ingest).
 *
 * Before 1 and 2, if SecPatchlog is configured, it asks GET /api/should-scan and stops early
 * (exit 0) when the project was scanned within its interval. --force skips that check.
 *
 * Usage:
 *   node scripts/triage-opengrep.js [--force] [--skip-scan] [--input opengrep.txt] [--sarif opengrep-results.sarif]
 *                                   [--output opengrep-triage.md] [--json opengrep-triage.json]
 *                                   [--engine auto|claude|opencode] [--model <id>]
 *   node scripts/triage-opengrep.js --send-only     # re-send the last opengrep-triage.json
 *   node scripts/triage-opengrep.js --from-raw      # finish a run from the saved opengrep-triage.raw.txt
 *
 * Engine selection (auto):
 *   - opencode  if a provider API key is in .env AND `opencode` is on PATH
 *   - claude    otherwise, if `claude` (Claude Code CLI) is on PATH — uses your existing login
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_FILE = 'opengrep-triage.raw.txt';
const IDLE_KILL_MS = 60_000;

// Provider keys opencode understands -> default model for that provider
const PROVIDER_KEYS = {
  ANTHROPIC_API_KEY: 'anthropic/claude-sonnet-5-5',
  OPENAI_API_KEY: 'openai/gpt-5',
  OPENROUTER_API_KEY: 'openrouter/anthropic/claude-sonnet-5-5',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google/gemini-2.5-pro',
};

function parseArgs(argv) {
  const args = {
    input: 'opengrep.txt',
    output: 'opengrep-triage.md',
    sarif: 'opengrep-results.sarif',
    json: 'opengrep-triage.json',
    sendOnly: false,
    force: false,
    engine: 'auto',
    model: null,
    scan: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v;
    };
    if (a === '--input' || a === '-i') args.input = next();
    else if (a === '--output' || a === '-o') args.output = next();
    else if (a === '--engine' || a === '-e') args.engine = next();
    else if (a === '--model' || a === '-m') args.model = next();
    else if (a === '--sarif') args.sarif = next();
    else if (a === '--skip-scan') args.scan = false;
    else if (a === '--json') args.json = next();
    else if (a === '--send-only') args.sendOnly = true;
    else if (a === '--force') args.force = true;
    else if (a === '--from-raw') args.fromRaw = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  if (!['auto', 'claude', 'opencode'].includes(args.engine)) {
    fail(`--engine must be auto, claude or opencode (got "${args.engine}")`);
  }
  return args;
}

function fail(msg) {
  console.error(`\n[triage] ERROR: ${msg}\n`);
  process.exit(1);
}

/** Minimal .env parser: KEY=VALUE, optional quotes, # comments, `export` prefix. */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    out[m[1]] = val;
  }
  return out;
}

function onPath(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * Runs opengrep over the repo. Writes a text report (what the AI triages) and a SARIF copy.
 * Rules dir: $OPENGREP_RULES_DIR, defaulting to ~/opengrep-rules.
 */
function runScan(textOut, sarifOut, env) {
  if (!onPath('opengrep')) fail('opengrep is not on PATH.');

  const rulesDir = env.OPENGREP_RULES_DIR || path.join(os.homedir(), 'opengrep-rules');
  // Rule folders inside opengrep-rules, e.g. OPENGREP_RULESETS=python,generic for a Python repo
  const ruleNames = (env.OPENGREP_RULESETS || 'javascript,typescript,generic').split(',').map((r) => r.trim()).filter(Boolean);
  const ruleSets = ruleNames.map((r) => path.join(rulesDir, r));
  const missing = ruleSets.filter((r) => !fs.existsSync(r));
  if (missing.length) fail(`opengrep rules not found:\n  ${missing.join('\n  ')}\nSet OPENGREP_RULES_DIR in .env.`);

  const scanArgs = ['scan'];
  for (const r of ruleSets) scanArgs.push('-f', r);
  scanArgs.push('--taint-intrafile');
  for (const ex of ['node_modules', 'dist', 'build', 'coverage']) scanArgs.push('--exclude', ex);
  scanArgs.push(`--sarif-output=${sarifOut}`, `--text-output=${textOut}`, '.');

  console.log(`[scan] opengrep ${scanArgs.join(' ')}\n`);
  const r = spawnSync('opengrep', scanArgs, { cwd: ROOT, env, stdio: 'inherit' });
  if (r.error) fail(`Failed to start opengrep: ${r.error.message}`);
  // 0 = clean, 1 = findings (with --error); anything else is a real failure
  if (r.status !== 0 && r.status !== 1) fail(`opengrep exited with code ${r.status}.`);
  console.log(`\n[scan] done -> ${textOut}, ${sarifOut}\n`);
}

function buildPrompt(inputRel) {
  return `You are a senior application security engineer triaging static-analysis results.

The file \`${inputRel}\` in the current directory contains the output of an opengrep (semgrep-compatible) scan of this repository.

Your job:
1. Read \`${inputRel}\` fully.
2. For EACH finding, open the referenced source file and lines in this repo and look at the surrounding code (callers, sanitisation, middleware, config) before deciding.
3. Classify each finding as one of: **True positive**, **False positive**, or **Needs review**.
4. Assign a severity: Critical / High / Medium / Low (use "-" for false positives).
5. For true positives, give a concrete, minimal fix (code snippet where useful).

Rules:
- Do NOT modify, create or delete any files. Read-only analysis.
- Base verdicts on the actual code, not just the rule name. Say briefly why.
- Group duplicates of the same rule+pattern if they share the same root cause, but list every location.

Output ONLY Markdown in this structure:

## Summary
A table with counts by verdict and by severity, plus a 2-3 sentence overall assessment.

## Findings
For each finding, a subsection:
### <n>. <rule id> — \`<file>:<line>\`
- **Verdict:** ...
- **Severity:** ...
- **Reasoning:** ...
- **Fix:** ... (true positives only)

## Prioritized action list
Numbered list of what to fix first, most severe first.

## Machine-readable results
Finish with ONE fenced \`\`\`json code block (and nothing after it) containing every finding from the Findings section,
in the same order, using exactly this shape:

\`\`\`json
{
  "summary": "<the 2-3 sentence overall assessment>",
  "findings": [
    {
      "ruleId": "<opengrep rule id>",
      "title": "<short human title of the problem, max ~100 chars>",
      "file": "<repo-relative path of the primary location, forward slashes>",
      "line": <primary line number as an integer>,
      "locations": ["<file:line>", "..."],
      "verdict": "true_positive" | "false_positive" | "needs_review",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "reasoning": "<your reasoning>",
      "fix": "<the fix, or empty string>"
    }
  ]
}
\`\`\`
Use "info" as the severity for false positives. Grouped findings are ONE entry with all their locations.
The JSON must be valid (no comments, no trailing commas).
`;
}

/** Splits the agent output into the markdown report and the trailing ```json block. */
function splitOutput(output) {
  const text = output.trim();
  const start = text.lastIndexOf('```json');
  if (start === -1) return { markdown: text, results: null, error: 'no ```json block found' };
  const end = text.indexOf('```', start + 7);
  const jsonText = text.slice(start + 7, end === -1 ? undefined : end).trim();
  const markdown = text
    .slice(0, start)
    .replace(/\n#+\s*Machine-readable results\s*$/i, '')
    .trim();
  try {
    const results = JSON.parse(jsonText);
    if (!Array.isArray(results.findings)) throw new Error('missing "findings" array');
    return { markdown, results, error: null };
  } catch (err) {
    return { markdown: text, results: null, error: err.message };
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Posts triage results to SecPatchlog if TRIAGE_REPORT_URL + TRIAGE_REPORT_TOKEN are set. */
async function sendResults(results, markdown, meta, env) {
  const url = env.TRIAGE_REPORT_URL;
  const token = env.TRIAGE_REPORT_TOKEN;
  if (!url || !token) {
    console.log('[report] TRIAGE_REPORT_URL / TRIAGE_REPORT_TOKEN not set — not sending to SecPatchlog.');
    return true;
  }

  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  const body = {
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: env.GITHUB_SHA || git(['rev-parse', 'HEAD']),
    runUrl,
    triggeredBy: env.GITHUB_ACTOR || git(['config', 'user.name']) || null,
    engine: meta.engine,
    model: meta.model,
    summary: results.summary || null,
    reportMarkdown: markdown,
    findings: results.findings,
  };

  console.log(`[report] sending ${results.findings.length} findings to ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[report] SecPatchlog rejected the results (${res.status}): ${data.error || res.statusText}`);
      return false;
    }
    console.log(
      `[report] scan #${data.scanId} for ${data.project}: ${data.created} new, ${data.updated} updated, ${data.reopened} reopened`
    );
    return true;
  } catch (err) {
    console.error(`[report] could not reach SecPatchlog: ${err.message}`);
    return false;
  }
}

/**
 * Asks SecPatchlog whether this project is due for a scan (GET /api/should-scan -> "1" or "0").
 * Skipped when SecPatchlog isn't configured. If SecPatchlog can't be reached, it scans anyway (fail open).
 */
async function shouldScan(env) {
  const token = env.TRIAGE_REPORT_TOKEN;
  const gateUrl =
    env.TRIAGE_GATE_URL || (env.TRIAGE_REPORT_URL && env.TRIAGE_REPORT_URL.replace(/\/ingest\/?$/, '/should-scan'));
  if (!gateUrl || !token) return true;

  try {
    const res = await fetch(`${gateUrl}${gateUrl.includes('?') ? '&' : '?'}format=json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[gate] SecPatchlog returned ${res.status} (${data.error || res.statusText}); scanning anyway.`);
      return true;
    }
    if (data.scan === 1) {
      console.log(
        data.lastScanAt
          ? `[gate] last scan was ${data.lastScanAgeDays} days ago (interval ${data.intervalDays}d) -> scanning.`
          : '[gate] no previous scan for this project -> scanning.'
      );
      return true;
    }
    console.log(
      `[gate] last scan was ${data.lastScanAgeDays} days ago (interval ${data.intervalDays}d); ` +
        `next scan due ${data.nextScanDueAt}.`
    );
    return false;
  } catch (err) {
    console.warn(`[gate] could not reach SecPatchlog (${err.message}); scanning anyway.`);
    return true;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const inputPath = path.resolve(ROOT, args.input);
  const outputPath = path.resolve(ROOT, args.output);
  const inputRel = path.relative(ROOT, inputPath).replace(/\\/g, '/');

  // .env values fill in, but never override, variables already in the environment
  const fileEnv = loadEnv(path.join(ROOT, '.env'));
  const env = { ...fileEnv, ...process.env };

  const jsonPath = path.resolve(ROOT, args.json);

  const rawPath = path.resolve(ROOT, RAW_FILE);

  if (args.fromRaw) {
    // Finish a run whose agent output was saved but never processed (e.g. the agent hung)
    if (!fs.existsSync(rawPath)) fail(`${RAW_FILE} not found.`);
    await finalize(fs.readFileSync(rawPath, 'utf8'), {
      engine: args.engine === 'auto' ? 'claude' : args.engine,
      model: args.model,
      inputRel,
      outputPath,
      jsonPath,
      env,
    });
    return;
  }

  if (args.sendOnly) {
    if (!fs.existsSync(jsonPath)) fail(`${args.json} not found. Run a triage first.`);
    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const markdown = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    sendResults(saved, markdown, saved.meta || {}, env).then((ok) => process.exit(ok ? 0 : 1));
    return;
  }

  if (!args.force && !(await shouldScan(env))) {
    console.log('[gate] skipping scan and triage. Use --force to run anyway.');
    process.exit(0);
  }

  if (args.scan) runScan(inputRel, args.sarif, env);

  if (!fs.existsSync(inputPath)) {
    fail(`${inputRel} not found. Run without --skip-scan to generate it.`);
  }
  const size = fs.statSync(inputPath).size;
  if (size === 0) fail(`${inputRel} is empty — nothing to triage.`);

  const foundKey = Object.keys(PROVIDER_KEYS).find((k) => env[k]);
  const hasOpencode = onPath('opencode');
  const hasClaude = onPath('claude');

  let engine = args.engine;
  if (engine === 'auto') {
    if (foundKey && hasOpencode) engine = 'opencode';
    else if (hasClaude) engine = 'claude';
    else {
      fail(
        'No usable AI engine found.\n' +
          '  - For opencode: npm i -g opencode-ai, and put a provider key in .env ' +
          `(${Object.keys(PROVIDER_KEYS).join(', ')})\n` +
          '  - Or install Claude Code and sign in: https://claude.com/claude-code'
      );
    }
  }
  if (engine === 'opencode' && !hasOpencode) fail('opencode is not on PATH. Install it with: npm i -g opencode-ai');
  if (engine === 'claude' && !hasClaude) fail('claude (Claude Code CLI) is not on PATH.');

  const prompt = buildPrompt(inputRel);
  let cmd;
  let cmdArgs;
  let model = args.model;
  const childEnv = { ...env };

  if (engine === 'claude') {
    cmd = 'claude';
    // Prompt is piped via stdin; only read-only tools are allowed.
    // --strict-mcp-config: load no MCP servers/connectors (not needed, and they can keep the process alive)
    cmdArgs = [
      '-p',
      '--allowedTools', 'Read,Grep,Glob',
      '--output-format', 'text',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
    if (model) cmdArgs.push('--model', model);
  } else {
    cmd = 'opencode';
    if (!model && foundKey) model = PROVIDER_KEYS[foundKey];
    // Deny edits and shell so the agent stays read-only.
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    });
    // opencode appends piped stdin to the message.
    cmdArgs = ['run'];
    if (model) cmdArgs.push('--model', model);
    cmdArgs.push(`Triage the opengrep results as instructed below. The scan output is in ${inputRel}.`);
  }

  console.log(`[triage] engine: ${engine}${model ? `  model: ${model}` : ''}`);
  console.log(`[triage] input:  ${inputRel} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`[triage] output: ${path.relative(ROOT, outputPath)}`);
  console.log('[triage] running... (this can take several minutes)\n');

  // npm-installed CLIs on Windows are .cmd shims and need a shell; quote every arg so
  // spaces or cmd metacharacters (& | < >) in them can't be interpreted by cmd.exe.
  const useShell = process.platform === 'win32' && engine === 'opencode';
  if (useShell) {
    if (cmdArgs.some((a) => /["%^!\r\n]/.test(a))) fail('Arguments contain characters that are unsafe to pass through cmd.exe.');
    cmdArgs = cmdArgs.map((a) => `"${a}"`);
  }

  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: childEnv,
    shell: useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Raw output is saved as it streams, so a hung or killed agent never loses finished work
  // (recover with --from-raw).
  fs.writeFileSync(rawPath, '', 'utf8');

  let stdout = '';
  let stderr = '';
  let stoppedByWatchdog = false;
  let idleTimer = null;

  // Some CLI versions finish printing but never exit. Once the complete JSON block has arrived
  // and nothing new has been printed for IDLE_KILL_MS, stop the agent and carry on.
  const armWatchdog = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (splitOutput(stdout).results) {
        stoppedByWatchdog = true;
        console.warn(`\n[triage] ${engine} finished its output but did not exit; stopping it.`);
        child.kill();
      }
    }, IDLE_KILL_MS);
  };

  child.stdout.on('data', (d) => {
    stdout += d;
    fs.appendFileSync(rawPath, d);
    process.stdout.write(d);
    armWatchdog();
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    process.stderr.write(d);
  });
  child.on('error', (err) => fail(`Failed to start ${cmd}: ${err.message}`));

  child.stdin.write(prompt);
  child.stdin.end();

  child.on('close', async (code) => {
    clearTimeout(idleTimer);
    if (code !== 0 && !stoppedByWatchdog) {
      if (!splitOutput(stdout).results) {
        fail(
          `${engine} exited with code ${code}.${stderr ? '' : ' (no stderr output)'} ` +
            `Partial output saved to ${path.relative(ROOT, rawPath)}.`
        );
      }
      console.warn(`[triage] ${engine} exited with code ${code}, but its output is complete; continuing.`);
    }
    await finalize(stdout, { engine, model, inputRel, outputPath, jsonPath, env });
  });
}

async function finalize(stdout, { engine, model, inputRel, outputPath, jsonPath, env }) {
  {
    if (!stdout.trim()) fail(`${engine} returned no output.`);

    const { markdown, results, error } = splitOutput(stdout);
    const header =
      `# opengrep AI triage\n\n` +
      `- **Date:** ${new Date().toISOString()}\n` +
      `- **Engine:** ${engine}${model ? ` (${model})` : ''}\n` +
      `- **Input:** \`${inputRel}\`\n\n---\n\n`;
    const fullMarkdown = header + markdown + '\n';
    fs.writeFileSync(outputPath, fullMarkdown, 'utf8');
    console.log(`\n[triage] done -> ${path.relative(ROOT, outputPath)}`);

    if (!results) {
      console.warn(`[triage] WARNING: could not read the JSON results (${error}). Nothing sent to SecPatchlog.`);
      process.exit(1);
    }
    const meta = { engine, model: model || null };
    fs.writeFileSync(jsonPath, JSON.stringify({ meta, ...results }, null, 2) + '\n', 'utf8');
    console.log(`[triage] ${results.findings.length} findings -> ${path.relative(ROOT, jsonPath)}`);

    const ok = await sendResults(results, fullMarkdown, meta, env);
    process.exit(ok ? 0 : 1);
  }
}

main().catch((err) => fail(err.message));
