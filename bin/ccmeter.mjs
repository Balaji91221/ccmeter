#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { loadRecords } from '../src/parse.mjs';
import { byProject, bySession, byModel, byDay, tree, totals } from '../src/aggregate.mjs';
import { loadConfig, saveConfig, evaluate, applySetting } from '../src/budget.mjs';
import { flatten, toCsv } from '../src/export.mjs';
import { dataRoots, listTranscripts, configPath } from '../src/paths.mjs';
import { RATES } from '../src/pricing.mjs';
import {
  c, table, money, tokens, when, truncate, shortPath, bar, heading, note,
} from '../src/render.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';

const HELP = `
${c.bold('ccmeter')} — per-message, per-session and per-project cost analysis for Claude Code

${c.bold('USAGE')}
  ccmeter <command> [options]

${c.bold('COMMANDS')}
  projects              Spend rolled up by project
  sessions              Spend rolled up by session
  messages              Every assistant turn, individually priced
  tree                  Project → session → message, one view
  daily                 Spend per calendar day
  models                Spend per model
  budget                Check spend against your limits
  export                Write CSV/JSON at any level
  doctor                Show where your transcripts were found
  dashboard             Local web UI for sessions & conversation history
  help                  This text

${c.bold('FILTERS')} (any command)
  -p, --project <name>  Substring match on project path or folder
  -s, --session <id>    Session id or unique prefix
  -m, --model <name>    Substring match on model id
      --since <date>    Inclusive lower bound (YYYY-MM-DD, or 7d / 24h / 3w)
      --until <date>    Inclusive upper bound
      --no-sidechains   Exclude sub-agent turns
      --dir <path>      Read a specific projects/ directory

${c.bold('OUTPUT')}
      --json            Machine-readable JSON
      --csv             Comma-separated rows
  -n, --limit <n>       Cap rows shown (default 20; 0 = all)
      --sort <field>    cost | tokens | time | messages   (default cost)
      --breakdown       Add a per-model split under each row
  -o, --out <file>      Write to a file instead of stdout

${c.bold('BUDGET')}
  ccmeter budget --set monthly=200 --set myapp.daily=5
  ccmeter budget --strict        Exit 1 if any limit is exceeded

${c.bold('DASHBOARD')}
  ccmeter dashboard              Open on http://127.0.0.1:3847
  ccmeter dashboard --port 4000  Custom port
  ccmeter dashboard --host 0.0.0.0

${c.bold('EXAMPLES')}
  ccmeter projects --since 30d
  ccmeter sessions -p myapp --breakdown
  ccmeter messages -s 4f2a --sort cost -n 10
  ccmeter tree -p myapp --top 3
  ccmeter export --level message --csv -o usage.csv
  ccmeter dashboard
`;

// ---------------------------------------------------------------- arg parsing

const FLAGS = new Set([
  'json', 'csv', 'breakdown', 'strict', 'no-sidechains', 'all', 'help', 'version', 'quiet',
]);
const ALIAS = {
  p: 'project', s: 'session', m: 'model', n: 'limit', o: 'out', h: 'help', v: 'version',
};

function parseArgs(argv) {
  const opts = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { opts._.push(arg); continue; }
    let key = arg.replace(/^--?/, '');
    let value = null;
    const eq = key.indexOf('=');
    if (eq !== -1) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    key = ALIAS[key] || key;
    if (FLAGS.has(key)) { opts[camel(key)] = true; continue; }
    if (value === null) {
      value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    }
    if (key === 'set') opts.set.push(value);
    else opts[camel(key)] = value;
  }
  return opts;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/** Accepts YYYY-MM-DD, ISO timestamps, and relative spans like 7d / 36h / 2w. */
function parseDate(input, { end = false } = {}) {
  if (input == null || input === true) return null;
  const s = String(input).trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(h|d|w|m)$/i.exec(s);
  if (rel) {
    const mult = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 }[rel[2].toLowerCase()];
    return new Date(Date.now() - Number(rel[1]) * mult);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unrecognised date: ${s}`);
  return d;
}

function filtersFrom(opts) {
  return {
    project: typeof opts.project === 'string' ? opts.project : null,
    session: typeof opts.session === 'string' ? opts.session : null,
    model: typeof opts.model === 'string' ? opts.model : null,
    since: parseDate(opts.since),
    until: parseDate(opts.until, { end: true }),
    noSidechains: Boolean(opts.noSidechains),
    dir: typeof opts.dir === 'string' ? opts.dir : null,
  };
}

const SORTERS = {
  cost: (a, b) => b.cost - a.cost,
  tokens: (a, b) => b.tokens - a.tokens,
  messages: (a, b) => b.messages - a.messages,
  time: (a, b) => (b.last ?? 0) - (a.last ?? 0),
};

function limitRows(rows, opts, fallback = 20) {
  const n = opts.all ? 0 : Number(opts.limit ?? fallback);
  return n > 0 ? rows.slice(0, n) : rows;
}

// ---------------------------------------------------------------- output

function emit(text, opts) {
  if (typeof opts.out === 'string') {
    writeFileSync(opts.out, text.endsWith('\n') ? text : text + '\n');
    if (!opts.quiet) console.log(note(`wrote ${opts.out}`));
  } else {
    console.log(text);
  }
}

/** If --json/--csv was asked for, serialize and return true. */
function structured(rows, opts) {
  if (opts.json) {
    emit(JSON.stringify(rows, null, 2), opts);
    return true;
  }
  if (opts.csv) {
    emit(toCsv(rows), opts);
    return true;
  }
  return false;
}

function summaryLine(all, shown) {
  const t = totals(all);
  const parts = [
    `${c.bold(money(t.cost))} across ${t.messages.toLocaleString()} assistant turns`,
    `${tokens(t.tokens)} tokens`,
  ];
  if (t.saved > 0.005) parts.push(c.green(`${money(t.saved)} saved by prompt caching`));
  if (shown != null && shown < all.length) parts.push(note(`showing ${shown}`));
  return parts.join(c.gray(' · '));
}

function breakdownFor(bucket, indent = '    ') {
  return bucket.modelBreakdown
    .map((m) => `${indent}${c.gray('·')} ${truncate(m.model, 34).padEnd(34)} ${money(m.cost).padStart(10)}  ${tokens(m.tokens).padStart(8)}`)
    .join('\n');
}

function withBreakdown(lines, buckets, opts) {
  if (!opts.breakdown) return lines;
  // Re-render as blocks so each row can carry its own model split.
  return buckets
    .map((b) => `${b.__line}\n${breakdownFor(b)}`)
    .join('\n');
}

function warn(result) {
  if (!result.unpricedModels.size) return;
  const list = [...result.unpricedModels.entries()]
    .map(([m, n]) => `${m} (${n} turns)`)
    .join(', ');
  console.error(
    c.yellow('warning: ') +
      `no price known for ${list}. Those turns are counted as $0. ` +
      `Add rates to ${configPath('pricing.json')}.`
  );
}

// ---------------------------------------------------------------- commands

async function cmdProjects(opts) {
  const { records, ...rest } = await loadRecords(filtersFrom(opts));
  const rows = byProject(records).sort(SORTERS[opts.sort] || SORTERS.cost);
  if (structured(flatten(records, 'project'), opts)) return;
  if (!rows.length) return console.log(note('No usage found. Try `ccmeter doctor`.'));

  const shown = limitRows(rows, opts);
  const grand = totals(records).cost || 1;
  console.log(heading('Spend by project'));
  console.log(
    table(
      [
        { header: 'PROJECT', get: (r) => c.cyan(shortPath(r.key, 40)) },
        { header: 'COST', align: 'right', get: (r) => money(r.cost) },
        { header: 'SHARE', align: 'right', get: (r) => (100 * r.cost / grand).toFixed(1) + '%' },
        { header: 'TURNS', align: 'right', get: (r) => r.messages.toLocaleString() },
        { header: 'TOKENS', align: 'right', get: (r) => tokens(r.tokens) },
        { header: 'CACHED', align: 'right', get: (r) => pctCached(r) },
        { header: 'LAST USED', get: (r) => when(r.last) },
      ],
      shown
    )
  );
  if (opts.breakdown) for (const r of shown) {
    console.log(`\n  ${c.cyan(shortPath(r.key, 40))}\n${breakdownFor(r)}`);
  }
  console.log('\n' + summaryLine(records, shown.length));
  warn({ unpricedModels: rest.unpricedModels });
}

const pctCached = (r) => {
  const inputish = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite5m + r.usage.cacheWrite1h;
  return inputish ? Math.round((100 * r.usage.cacheRead) / inputish) + '%' : '-';
};

async function cmdSessions(opts) {
  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  const rows = bySession(records).sort(SORTERS[opts.sort] || SORTERS.cost);
  if (structured(flatten(records, 'session'), opts)) return;
  if (!rows.length) return console.log(note('No sessions matched.'));

  const shown = limitRows(rows, opts);
  console.log(heading('Spend by session'));
  console.log(
    table(
      [
        { header: 'SESSION', get: (r) => c.magenta(r.key.slice(0, 8)) },
        { header: 'PROJECT', get: (r) => shortPath(r.project, 28) },
        { header: 'COST', align: 'right', get: (r) => money(r.cost) },
        { header: 'TURNS', align: 'right', get: (r) => r.messages.toLocaleString() },
        { header: 'TOKENS', align: 'right', get: (r) => tokens(r.tokens) },
        { header: 'MODELS', get: (r) => truncate(r.modelBreakdown.map((m) => shortModel(m.model)).join(','), 22) },
        { header: 'STARTED', get: (r) => when(r.first) },
      ],
      shown
    )
  );
  if (opts.breakdown) for (const r of shown) {
    console.log(`\n  ${c.magenta(r.key)}\n${breakdownFor(r)}`);
  }
  console.log('\n' + summaryLine(records, shown.length));
  console.log(note('Full session id: ccmeter messages -s <prefix>'));
  warn({ unpricedModels });
}

const shortModel = (m) =>
  String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');

async function cmdMessages(opts) {
  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  if (structured(flatten(records, 'message'), opts)) return;
  if (!records.length) return console.log(note('No messages matched.'));

  const sorted = [...records].sort(
    opts.sort === 'time'
      ? (a, b) => b.at - a.at
      : opts.sort === 'tokens'
        ? (a, b) => b.tokens - a.tokens
        : (a, b) => b.cost - a.cost
  );
  const shown = limitRows(sorted, opts);

  console.log(heading('Per-message usage'));
  console.log(
    table(
      [
        { header: 'WHEN', get: (r) => when(r.at) },
        { header: 'TURN', align: 'right', get: (r) => String(r.turn) },
        { header: 'MODEL', get: (r) => shortModel(r.model) },
        { header: 'IN', align: 'right', get: (r) => tokens(r.usage.input) },
        { header: 'OUT', align: 'right', get: (r) => tokens(r.usage.output) },
        { header: 'CACHE W', align: 'right', get: (r) => tokens(r.usage.cacheWrite5m + r.usage.cacheWrite1h) },
        { header: 'CACHE R', align: 'right', get: (r) => tokens(r.usage.cacheRead) },
        { header: 'COST', align: 'right', get: (r) => (r.cost >= 0.5 ? c.yellow(money(r.cost)) : money(r.cost)) },
        { header: 'PROMPT', width: 42, get: (r) => c.gray(truncate(r.prompt || r.preview, 42)) },
      ],
      shown
    )
  );
  console.log('\n' + summaryLine(records, shown.length));
  warn({ unpricedModels });
}

async function cmdTree(opts) {
  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  const top = Number(opts.top ?? 5);
  const forest = tree(records, { messagesPerSession: top });
  if (structured(forest.map(stripDates), opts)) return;
  if (!forest.length) return console.log(note('Nothing to show.'));

  console.log(heading('Project → session → message'));
  for (const proj of limitRows(forest, opts, 5)) {
    console.log(
      `${c.cyan(c.bold(shortPath(proj.key, 60)))}  ${c.bold(money(proj.cost))} ` +
        note(`${proj.messages} turns · ${tokens(proj.tokens)} tokens · ${proj.sessions.length} sessions`)
    );
    for (const sess of proj.sessions.slice(0, Number(opts.sessions ?? 3))) {
      console.log(
        `  ${c.gray('└─')} ${c.magenta(sess.key.slice(0, 8))}  ${money(sess.cost).padStart(9)} ` +
          note(`${sess.messages} turns · ${when(sess.first)}`)
      );
      for (const rec of sess.records) {
        console.log(
          `     ${c.gray('·')} ${money(rec.cost).padStart(9)}  ${shortModel(rec.model).padEnd(18)} ` +
            c.gray(truncate(rec.prompt || rec.preview, 60))
        );
      }
      if (sess.truncated) {
        console.log(c.gray(`       … ${sess.messages - sess.records.length} more turns`));
      }
    }
    console.log('');
  }
  console.log(summaryLine(records, null));
  warn({ unpricedModels });
}

const stripDates = (node) => JSON.parse(JSON.stringify(node));

async function cmdDaily(opts) {
  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  const rows = byDay(records);
  if (structured(flatten(records, 'day'), opts)) return;
  if (!rows.length) return console.log(note('No usage in range.'));

  const peak = Math.max(...rows.map((r) => r.cost));
  console.log(heading('Daily spend'));
  console.log(
    table(
      [
        { header: 'DATE', get: (r) => r.key },
        { header: 'COST', align: 'right', get: (r) => money(r.cost) },
        { header: 'TURNS', align: 'right', get: (r) => r.messages.toLocaleString() },
        { header: 'TOKENS', align: 'right', get: (r) => tokens(r.tokens) },
        { header: '', get: (r) => bar(r.cost / peak, 28) },
      ],
      opts.all ? rows : rows.slice(-Number(opts.limit ?? 30))
    )
  );
  console.log('\n' + summaryLine(records, null));
  warn({ unpricedModels });
}

async function cmdModels(opts) {
  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  const rows = byModel(records);
  if (structured(flatten(records, 'model'), opts)) return;
  if (!rows.length) return console.log(note('No usage in range.'));

  console.log(heading('Spend by model'));
  console.log(
    table(
      [
        { header: 'MODEL', get: (r) => r.key || c.gray('(unknown)') },
        { header: 'COST', align: 'right', get: (r) => money(r.cost) },
        { header: 'TURNS', align: 'right', get: (r) => r.messages.toLocaleString() },
        { header: 'IN', align: 'right', get: (r) => tokens(r.usage.input) },
        { header: 'OUT', align: 'right', get: (r) => tokens(r.usage.output) },
        { header: 'CACHE R', align: 'right', get: (r) => tokens(r.usage.cacheRead) },
        { header: 'SAVED BY CACHE', align: 'right', get: (r) => c.green(money(r.saved)) },
      ],
      rows
    )
  );
  console.log('\n' + summaryLine(records, null));
  warn({ unpricedModels });
}

async function cmdBudget(opts) {
  const cfg = loadConfig();

  if (opts.set.length) {
    for (const expr of opts.set) applySetting(cfg, expr);
    const path = saveConfig(cfg);
    console.log(note(`saved ${path}`));
  }

  const { records } = await loadRecords(filtersFrom(opts));
  const rows = evaluate(records, cfg);

  if (opts.json) {
    emit(JSON.stringify({ config: { budgets: cfg.budgets, projects: cfg.projects }, rows }, null, 2), opts);
    return rows.some((r) => r.state === 'over') && opts.strict ? 1 : 0;
  }

  if (!rows.length) {
    console.log(heading('Budgets'));
    console.log(note('No limits set yet. For example:'));
    console.log('  ccmeter budget --set monthly=200');
    console.log('  ccmeter budget --set myapp.daily=5\n');
    return 0;
  }

  console.log(heading('Budgets'));
  for (const r of rows) {
    const scope = r.scope === 'all' ? 'all projects' : r.scope;
    const status =
      r.state === 'over' ? c.red('OVER') : r.state === 'warn' ? c.yellow('NEAR') : c.green('OK');
    console.log(
      `${status}  ${c.bold(r.label.padEnd(11))} ${truncate(scope, 22).padEnd(22)} ` +
        `${money(r.spent).padStart(9)} / ${money(r.limit).padEnd(9)} ` +
        `${bar(r.fraction)} ${String(Math.round(r.fraction * 100)).padStart(3)}%`
    );
  }
  console.log('\n' + note(`config: ${cfg.path}`));

  const over = rows.some((r) => r.state === 'over');
  if (over && opts.strict) {
    console.error(c.red('\nbudget exceeded'));
    return 1;
  }
  return 0;
}

async function cmdExport(opts) {
  const level = String(opts.level || 'message');
  const valid = ['message', 'session', 'project', 'model', 'day'];
  if (!valid.includes(level)) {
    console.error(`--level must be one of: ${valid.join(', ')}`);
    return 1;
  }
  const { records } = await loadRecords(filtersFrom(opts));
  const rows = flatten(records, level);
  const text = opts.json ? JSON.stringify(rows, null, 2) : toCsv(rows);
  emit(text, opts);
  if (!opts.out && !opts.quiet) return 0;
  if (opts.out) console.log(note(`${rows.length} ${level} rows`));
  return 0;
}

async function cmdDoctor(opts) {
  const roots = dataRoots(filtersFrom(opts));
  console.log(heading('ccmeter doctor'));
  if (!roots.length) {
    console.log(c.red('No Claude Code transcript directory found.'));
    console.log(note('Looked for projects/ under $CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude.'));
    console.log(note('Point at one explicitly with --dir /path/to/projects'));
    return 1;
  }
  for (const r of roots) console.log(`${c.green('found')}  ${r}`);

  const files = listTranscripts(filtersFrom(opts));
  console.log(`\n${files.length} transcript file(s) across ${new Set(files.map((f) => f.projectDir)).size} project folder(s)`);

  const { records, unpricedModels } = await loadRecords(filtersFrom(opts));
  const t = totals(records);
  console.log(`${t.messages.toLocaleString()} priced assistant turns, ${money(t.cost)} total`);
  if (t.first) console.log(note(`range: ${when(t.first)} → ${when(t.last)}`));

  console.log(heading('Known rates (USD per million tokens)'));
  console.log(
    table(
      [
        { header: 'MODEL FAMILY', get: (r) => r.label },
        { header: 'INPUT', align: 'right', get: (r) => '$' + r.rates.input },
        { header: 'CACHE W (5m)', align: 'right', get: (r) => '$' + r.rates.cacheWrite5m },
        { header: 'CACHE R', align: 'right', get: (r) => '$' + r.rates.cacheRead },
        { header: 'OUTPUT', align: 'right', get: (r) => '$' + r.rates.output },
      ],
      RATES
    )
  );
  warn({ unpricedModels });
  console.log('\n' + note(`overrides: ${configPath('pricing.json')}`));
  return 0;
}

async function cmdDashboard(opts) {
  const port = Number(opts.port || process.env.PORT || 3847);
  const host = typeof opts.host === 'string' ? opts.host : '127.0.0.1';
  console.log(heading('ccmeter dashboard'));
  console.log(note('Loading transcripts on each request…'));
  const { url } = await startDashboard({ port, host });
  console.log(`${c.green('listening')}  ${c.bold(url)}`);
  console.log(note('Views: Overview · Sessions · Conversation · Projects · Expensive turns'));
  console.log(note('Press Ctrl+C to stop'));

  // Keep process alive; never resolve so the CLI stays up.
  await new Promise(() => {});
  return 0;
}

// ---------------------------------------------------------------- entry

const COMMANDS = {
  projects: cmdProjects,
  project: cmdProjects,
  sessions: cmdSessions,
  session: cmdSessions,
  messages: cmdMessages,
  message: cmdMessages,
  turns: cmdMessages,
  tree: cmdTree,
  daily: cmdDaily,
  models: cmdModels,
  budget: cmdBudget,
  export: cmdExport,
  doctor: cmdDoctor,
  dashboard: cmdDashboard,
  dash: cmdDashboard,
  ui: cmdDashboard,
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];

  if (opts.version) {
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
    console.log(pkg.version);
    return 0;
  }
  if (!cmd || opts.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}\n`);
    console.log(HELP);
    return 1;
  }
  return (await fn(opts)) ?? 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(c.red('ccmeter: ') + (err?.message ?? err));
    if (process.env.CCMETER_DEBUG) console.error(err);
    process.exit(1);
  });
