#!/usr/bin/env node
/**
 * End-to-end test for the Input Prompt Refiner.
 * Run: node test/e2e-refine.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refine, classify, listSkills, loadSkill } from '../src/refiner/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REFINE_BIN = join(ROOT, 'bin/refine.mjs');

let passed = 0;
let failed = 0;
const results = [];

function ok(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✓  ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, ok: false, error: err.message });
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
}

// ── cases ──────────────────────────────────────────────────────────
const CASES = [
  {
    name: 'revamp — expensive real prompt',
    prompt: 'update the entire revamp plan for backtest-engine',
    expectSkill: 'revamp',
    expectStages: ['explore', 'design', 'verify'],
    minAcceptance: 3,
  },
  {
    name: 'debug — null pointer',
    prompt: 'fix null pointer exception in checkout flow when cart is empty',
    expectSkill: 'debug',
    expectStages: ['repro', 'isolate', 'fix', 'verify'],
    minAcceptance: 3,
  },
  {
    name: 'feature — webhook',
    prompt: 'add webhook retries with exponential backoff for payment events',
    expectSkill: 'feature',
    expectStages: ['design', 'implement', 'verify'],
    minAcceptance: 2,
  },
  {
    name: 'refactor — extract module',
    prompt: 'refactor auth middleware: extract token validation into its own module without changing behavior',
    expectSkill: 'refactor',
    expectStages: ['map', 'extract', 'verify'],
    minAcceptance: 2,
  },
  {
    name: 'test — coverage',
    prompt: 'write unit tests for the pricing calculator edge cases',
    expectSkill: 'test',
    expectStages: ['inventory', 'add_tests', 'verify'],
    minAcceptance: 2,
  },
  {
    name: 'forced skill override',
    prompt: 'please handle this carefully',
    skill: 'revamp',
    expectSkill: 'revamp',
    expectStages: ['explore', 'design', 'verify'],
    minAcceptance: 3,
  },
];

const work = mkdtempSync(join(tmpdir(), 'refine-e2e-'));
console.log(`\nE2E Prompt Refiner`);
console.log(`workdir: ${work}`);
console.log(`repo:    ${ROOT}`);

// ── 1. skills catalog ──────────────────────────────────────────────
section('1. Skills catalog');

ok('lists exactly the 5 MVP skills', () => {
  const skills = listSkills();
  assert.deepEqual(skills.sort(), ['debug', 'feature', 'refactor', 'revamp', 'test']);
});

for (const name of listSkills()) {
  ok(`skill pack complete: ${name}`, () => {
    const sk = loadSkill(name);
    assert.ok(sk.skillMd.includes('# Skill:'), 'SKILL.md');
    assert.ok(sk.template.includes('{{goal}}'), 'template');
    assert.ok(sk.defaults.stages?.length >= 1, 'stages');
    assert.ok(sk.defaults.budgets?.context_tokens > 0, 'budgets');
    assert.ok(sk.triggers.length >= 1, 'triggers');
  });
}

// ── 2. library refine path ─────────────────────────────────────────
section('2. Library refine() for each skill');

for (const c of CASES) {
  ok(c.name, () => {
    const r = refine(c.prompt, { skill: c.skill, repo: '/tmp/demo-app', ask: true });

    assert.equal(r.brief.version, 1);
    assert.equal(r.brief.skill_primary, c.expectSkill);
    assert.ok(r.brief.goal.length >= 8, 'goal');
    assert.ok(r.brief.scope_in.length >= 1, 'scope_in');
    assert.ok(r.brief.acceptance.length >= c.minAcceptance, 'acceptance');
    assert.ok(r.brief.deliverables.length >= 1, 'deliverables');
    assert.ok(r.brief.definition_of_done.length >= 8, 'dod');
    assert.equal(r.brief.raw_user_prompt, c.prompt);
    assert.ok(r.brief.refined_prompt.includes('Engineering task'), 'refined_prompt');
    assert.ok(['S', 'M', 'L', 'XL'].includes(r.brief.complexity));
    assert.ok(r.brief.suggested_model);

    const stageIds = (r.token_spec.stages || []).map((s) => s.id);
    assert.deepEqual(stageIds, c.expectStages, `stages got ${stageIds.join(',')}`);

    assert.ok(r.token_spec.budgets.context_tokens >= 10000);
    assert.ok(r.token_spec.always_keep.includes('errors'));
    assert.ok(r.agent_message.includes('Follow the Engineering Brief'));
    assert.ok(r.human_summary.includes(`Skill: ${c.expectSkill}`));

    // persist for inspection
    const dir = join(work, c.expectSkill + (c.skill ? '-forced' : ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'brief.json'), JSON.stringify(r.brief, null, 2));
    writeFileSync(join(dir, 'token-spec.json'), JSON.stringify(r.token_spec, null, 2));
    writeFileSync(join(dir, 'agent.md'), r.agent_message);
  });
}

// ── 3. classification matrix ───────────────────────────────────────
section('3. Classification matrix');

const CLASSIFY = [
  ['the app crashed with stacktrace on deploy', 'debug'],
  ['implement OAuth login for the dashboard', 'feature'],
  ['cleanup duplicate helpers in utils', 'refactor'],
  ['redesign folder structure for monorepo', 'revamp'],
  ['add e2e coverage for checkout', 'test'],
];

for (const [prompt, skill] of CLASSIFY) {
  ok(`classify → ${skill}: ${prompt.slice(0, 40)}…`, () => {
    const c = classify(prompt);
    assert.equal(c.skill, skill);
  });
}

// ── 4. CLI end-to-end ──────────────────────────────────────────────
section('4. CLI end-to-end');

ok('CLI --list-skills', () => {
  const r = spawnSync(process.execPath, [REFINE_BIN, '--list-skills'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('revamp'));
  assert.ok(r.stdout.includes('debug'));
});

ok('CLI positional prompt prints summary + agent message', () => {
  const r = spawnSync(
    process.execPath,
    [REFINE_BIN, 'update the entire revamp plan for backtest-engine'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Skill: revamp'));
  assert.ok(r.stdout.includes('explore'));
  assert.ok(r.stdout.includes('Engineering task: Revamp'));
});

ok('CLI --json returns parseable full result', () => {
  const r = spawnSync(
    process.execPath,
    [REFINE_BIN, '-p', 'fix timeout in API gateway', '--json'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.brief.skill_primary, 'debug');
  assert.ok(j.token_spec.stages.length >= 3);
  assert.ok(j.agent_message);
  assert.ok(j.human_summary);
});

ok('CLI --agent prints only agent message', () => {
  const r = spawnSync(
    process.execPath,
    [REFINE_BIN, '-p', 'add rate limiting', '--agent'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Engineering task'));
  assert.ok(!r.stdout.includes('── agent message ──'));
});

ok('CLI -o dir writes brief.json token-spec.json agent.md summary.txt', () => {
  const out = join(work, 'cli-out');
  const r = spawnSync(
    process.execPath,
    [
      REFINE_BIN,
      '-p', 'update the entire revamp plan for /Users/demo/trade/backtest-engine',
      '-o', out,
      '--ask',
    ],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['brief.json', 'token-spec.json', 'agent.md', 'summary.txt']) {
    assert.ok(existsSync(join(out, f)), `missing ${f}`);
  }
  const brief = JSON.parse(readFileSync(join(out, 'brief.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(join(out, 'token-spec.json'), 'utf8'));
  assert.equal(brief.skill_primary, 'revamp');
  assert.ok(brief.context.repo.includes('backtest-engine') || brief.goal.includes('backtest-engine'));
  assert.deepEqual(spec.stages.map((s) => s.id), ['explore', 'design', 'verify']);
  assert.ok(spec.budgets.context_tokens === 80000);
  const agent = readFileSync(join(out, 'agent.md'), 'utf8');
  assert.ok(agent.includes('Original user request'));
  assert.ok(agent.includes('Acceptance criteria'));
});

ok('CLI --stdin works', () => {
  const r = spawnSync(process.execPath, [REFINE_BIN, '--stdin', '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
    input: 'write unit tests for invoice total rounding\n',
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.brief.skill_primary, 'test');
});

ok('CLI empty prompt exits non-zero', () => {
  const r = spawnSync(process.execPath, [REFINE_BIN], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.notEqual(r.status, 0);
});

// ── 5. agent message quality (paste-ready) ─────────────────────────
section('5. Agent message quality (paste into Claude Code)');

ok('agent message has all required sections for revamp', () => {
  const r = refine('update the entire revamp plan for backtest-engine', {
    repo: '/Users/demo/trade/backtest-engine',
  });
  const m = r.agent_message;
  for (const section of [
    '# Engineering task: Revamp',
    '## Goal',
    '## Scope (in)',
    '## Scope (out)',
    '## Constraints',
    '## Acceptance criteria',
    '## Deliverables',
    '## Definition of done',
    '## Working procedure',
    '## Original user request',
    'Do not expand scope_out',
  ]) {
    assert.ok(m.includes(section), `missing section: ${section}`);
  }
  // Should not be the vague original alone
  assert.ok(m.length > 400, 'message too short to be useful');
  assert.ok(!/^update the entire revamp plan/i.test(m.trim()), 'should not start with raw only');
});

// ── 6. token-spec steward contract ─────────────────────────────────
section('6. Token-spec steward contract');

ok('every stage has id, intent, pass_to_next', () => {
  for (const name of listSkills()) {
    const r = refine(`do a ${name} on module X`, { skill: name });
    for (const st of r.token_spec.stages) {
      assert.ok(st.id, `${name} stage id`);
      assert.ok(st.intent || st.pass_to_next, `${name} stage ${st.id} metadata`);
      if (st.pass_to_next) {
        assert.ok(st.pass_to_next.type, `${name}/${st.id} pass type`);
        assert.ok(st.pass_to_next.max_tokens > 0, `${name}/${st.id} max_tokens`);
      }
    }
    assert.ok(r.token_spec.fail_closed?.if_over_budget);
  }
});

// ── 7. schema-ish validation ───────────────────────────────────────
section('7. Brief required fields (schema contract)');

ok('all required brief fields present and typed', () => {
  const required = [
    'version', 'title', 'skill_primary', 'goal', 'scope_in', 'scope_out',
    'constraints', 'acceptance', 'deliverables', 'definition_of_done',
    'complexity', 'raw_user_prompt',
  ];
  const r = refine('implement feature flags for checkout');
  for (const k of required) {
    assert.ok(r.brief[k] != null && r.brief[k] !== '', `missing ${k}`);
  }
  assert.equal(r.brief.version, 1);
  assert.ok(Array.isArray(r.brief.scope_in));
  assert.ok(Array.isArray(r.brief.acceptance));
  assert.ok(['S', 'M', 'L', 'XL'].includes(r.brief.complexity));
});

// ── 8. npm test suite still green ──────────────────────────────────
section('8. Full unit test suite');

ok('npm test (unit suite) exits 0', () => {
  const r = spawnSync('npm', ['test'], {
    encoding: 'utf8',
    cwd: ROOT,
    env: process.env,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(/passed/.test(r.stdout));
});

// ── summary ────────────────────────────────────────────────────────
section('Summary');

const report = {
  at: new Date().toISOString(),
  workdir: work,
  passed,
  failed,
  total: passed + failed,
  results,
};
writeFileSync(join(work, 'e2e-report.json'), JSON.stringify(report, null, 2));

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Report: ${join(work, 'e2e-report.json')}`);
console.log(`Artifacts: ${work}`);

if (failed) {
  console.error('\nE2E FAILED\n');
  process.exit(1);
}
console.log('\nE2E PASSED — prompt refiner end-to-end OK\n');
process.exit(0);
