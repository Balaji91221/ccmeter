#!/usr/bin/env node
/**
 * Input Prompt Refiner — offline, skill-backed engineering briefs.
 *
 * Usage:
 *   node bin/refine.mjs "update the entire revamp plan"
 *   node bin/refine.mjs -p "fix login timeout" --skill debug --ask
 *   node bin/refine.mjs -p "..." -o out/ --json
 *   echo "add tests for auth" | node bin/refine.mjs --stdin
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { refine, listSkills, defaultSkillsRoot } from '../src/refiner/index.mjs';

const HELP = `
refine — turn a raw prompt into an Engineering Brief + token-spec (skill-backed)

USAGE
  refine <prompt...>
  refine -p|--prompt <text>
  refine --stdin
  refine --list-skills

OPTIONS
  -p, --prompt <text>   Prompt text
  -s, --skill <name>    Force skill: debug|feature|refactor|revamp|test
  -o, --out <dir|file>  Write brief.json + token-spec.json (+ agent.md if dir)
      --ask             Include up to 3 clarifying questions
      --repo <path>     Override context.repo
      --json            Print full JSON to stdout
      --agent           Print only the agent-ready message
      --stdin           Read prompt from stdin
      --skills-dir <d>  Skills root (default: ./skills)
  -h, --help            Help

EXAMPLES
  refine "update the entire revamp plan for backtest-engine"
  refine -p "fix null pointer in checkout" --skill debug -o ./out
  refine -p "add webhook retries" --json
`;

function parseArgs(argv) {
  const opts = { _: [], ask: false, json: false, agent: false, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--ask') opts.ask = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--agent') opts.agent = true;
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--list-skills') opts.listSkills = true;
    else if (a === '-p' || a === '--prompt') opts.prompt = argv[++i];
    else if (a === '-s' || a === '--skill') opts.skill = argv[++i];
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--skills-dir') opts.skillsRoot = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function writeOut(outPath, result) {
  const abs = resolve(outPath);
  const isDir = !abs.endsWith('.json') && !abs.endsWith('.md');
  if (isDir) {
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'brief.json'), JSON.stringify(result.brief, null, 2) + '\n');
    writeFileSync(join(abs, 'token-spec.json'), JSON.stringify(result.token_spec, null, 2) + '\n');
    writeFileSync(join(abs, 'agent.md'), result.agent_message + '\n');
    writeFileSync(join(abs, 'summary.txt'), result.human_summary + '\n');
    return abs;
  }
  // single file — write brief as json
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ brief: result.brief, token_spec: result.token_spec }, null, 2) + '\n');
  return abs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const skillsRoot = opts.skillsRoot ? resolve(opts.skillsRoot) : defaultSkillsRoot();

  if (opts.listSkills) {
    const skills = listSkills(skillsRoot);
    console.log(skills.length ? skills.join('\n') : '(no skills found)');
    console.log(`\nskills dir: ${skillsRoot}`);
    return 0;
  }

  let prompt = opts.prompt || opts._.join(' ').trim();
  if (opts.stdin || (!prompt && !process.stdin.isTTY)) {
    const s = await readStdin();
    if (s) prompt = s;
  }
  if (!prompt) {
    console.error('error: prompt required\n');
    console.log(HELP);
    return 1;
  }

  const result = refine(prompt, {
    skill: opts.skill,
    repo: opts.repo,
    ask: opts.ask,
    skillsRoot,
    cwd: process.cwd(),
  });

  if (opts.out) {
    const path = writeOut(opts.out, result);
    if (!opts.json && !opts.agent) {
      console.log(result.human_summary);
      console.log(`\nwrote ${path}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (opts.agent) {
    console.log(result.agent_message);
  } else if (!opts.out) {
    console.log(result.human_summary);
    console.log('\n── agent message ──\n');
    console.log(result.agent_message);
    console.log('\n── token-spec stages ──');
    console.log((result.token_spec.stages || []).map((s) => `  ${s.id}: ${s.intent || ''}`).join('\n') || '  (none)');
  }

  return 0;
}

main()
  .then((c) => process.exit(c ?? 0))
  .catch((err) => {
    console.error('refine:', err?.message || err);
    process.exit(1);
  });
