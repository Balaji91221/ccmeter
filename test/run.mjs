import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtures } from './fixtures.mjs';

const root = mkdtempSync(join(tmpdir(), 'ccmeter-test-'));
process.env.CCMETER_DIR = join(root, 'projects');
process.env.CCMETER_CONFIG_DIR = join(root, 'config');
makeFixtures(process.env.CCMETER_DIR);

const { loadRecords } = await import('../src/parse.mjs');
const { costOf, uncachedCostOf } = await import('../src/pricing.mjs');
const { byProject, bySession, totals } = await import('../src/aggregate.mjs');
const { toCsv, flatten } = await import('../src/export.mjs');
const { applySetting } = await import('../src/budget.mjs');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const MTok = 1_000_000;
const only = (u) => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...u });

console.log('\npricing');

await test('Opus 5 charges $5 per million input tokens', () => {
  const { cost } = costOf(only({ input: MTok }), 'claude-opus-5', new Date());
  assert.equal(cost, 5);
});

await test('Opus 5 charges $25 per million output tokens', () => {
  const { cost } = costOf(only({ output: MTok }), 'claude-opus-5', new Date());
  assert.equal(cost, 25);
});

await test('cache reads cost a tenth of base input', () => {
  const { cost } = costOf(only({ cacheRead: MTok }), 'claude-opus-5', new Date());
  assert.equal(cost, 0.5);
});

await test('5-minute cache writes cost 1.25x base input', () => {
  const { cost } = costOf(only({ cacheWrite5m: MTok }), 'claude-opus-5', new Date());
  assert.equal(cost, 6.25);
});

await test('Sonnet 5 uses introductory pricing before 2026-09-01', () => {
  const { cost } = costOf(only({ input: MTok }), 'claude-sonnet-5', new Date('2026-08-15'));
  assert.equal(cost, 2);
});

await test('Sonnet 5 switches to standard pricing from 2026-09-01', () => {
  const { cost } = costOf(only({ input: MTok }), 'claude-sonnet-5', new Date('2026-10-01'));
  assert.equal(cost, 3);
});

await test('dated model ids resolve (claude-haiku-4-5-20251001)', () => {
  const { cost } = costOf(only({ input: MTok }), 'claude-haiku-4-5-20251001', new Date());
  assert.equal(cost, 1);
});

await test('unknown models are flagged rather than silently free', () => {
  const r = costOf(only({ input: MTok }), 'claude-not-a-real-model', new Date());
  assert.equal(r.priced, false);
  assert.equal(r.cost, 0);
});

await test('uncached comparison bills cache tokens as plain input', () => {
  const usage = only({ input: 1000, cacheRead: MTok });
  assert.equal(uncachedCostOf(usage, 'claude-opus-5', new Date()), (1001000 * 5) / MTok);
});

console.log('\nparsing');

const { records } = await loadRecords({});

await test('records are found', () => assert.ok(records.length > 10));

await test('duplicate replayed turns are collapsed', () => {
  const keys = records.map((r) => `${r.messageId}:${r.requestId}`);
  assert.equal(new Set(keys).size, keys.length);
});

await test('truncated trailing lines do not throw', () => {
  assert.ok(records.every((r) => r.at instanceof Date));
});

await test('cwd is preferred over the encoded folder name', () => {
  assert.ok(records.every((r) => r.project.startsWith('/home/ada/')));
});

await test('granular cache_creation is used when present', () => {
  assert.ok(records.some((r) => r.usage.cacheWrite5m > 0));
  assert.ok(records.every((r) => r.usage.cacheWrite1h === 0));
});

await test('sidechain turns are detectable and filterable', async () => {
  assert.ok(records.some((r) => r.isSidechain));
  const { records: clean } = await loadRecords({ noSidechains: true });
  assert.ok(clean.length < records.length);
  assert.ok(clean.every((r) => !r.isSidechain));
});

await test('project filter narrows the set', async () => {
  const { records: sub } = await loadRecords({ project: 'checkout' });
  assert.ok(sub.length > 0 && sub.length < records.length);
  assert.ok(sub.every((r) => r.project.includes('checkout')));
});

await test('since filter narrows the set', async () => {
  const cutoff = new Date(Date.now() - 36 * 3600 * 1000);
  const { records: sub } = await loadRecords({ since: cutoff });
  assert.ok(sub.every((r) => r.at >= cutoff));
});

console.log('\naggregation');

await test('project totals sum to the grand total', () => {
  const grand = totals(records).cost;
  const sum = byProject(records).reduce((n, p) => n + p.cost, 0);
  assert.ok(Math.abs(grand - sum) < 1e-9);
});

await test('session totals sum to the grand total', () => {
  const grand = totals(records).cost;
  const sum = bySession(records).reduce((n, s) => n + s.cost, 0);
  assert.ok(Math.abs(grand - sum) < 1e-9);
});

await test('caching saving is never negative', () => {
  assert.ok(byProject(records).every((p) => p.saved >= -1e-9));
});

console.log('\nexport & config');

await test('csv escapes embedded commas and quotes', () => {
  const csv = toCsv([{ a: 'x,y', b: 'he said "hi"' }]);
  assert.equal(csv.trim(), 'a,b\n"x,y","he said ""hi"""');
});

await test('message export carries the turn lineage', () => {
  const rows = flatten(records, 'message');
  assert.ok(rows[0].uuid && 'parent_uuid' in rows[0] && rows[0].session_id);
});

await test('budget expressions parse global and per-project limits', () => {
  const cfg = { budgets: {}, projects: {} };
  applySetting(cfg, 'monthly=200');
  applySetting(cfg, 'myapp.daily=5');
  assert.equal(cfg.budgets.monthly, 200);
  assert.equal(cfg.projects.myapp.daily, 5);
});

await test('budget expressions reject nonsense', () => {
  assert.throws(() => applySetting({ budgets: {}, projects: {} }, 'yearly=3'));
});

console.log('\nprompt refiner');

const { refine, classify, listSkills, loadSkill, parseYamlReliable } = await import('../src/refiner/index.mjs');

await test('lists five MVP skills', () => {
  const skills = listSkills();
  for (const s of ['debug', 'feature', 'refactor', 'revamp', 'test']) {
    assert.ok(skills.includes(s), `missing skill ${s}`);
  }
});

await test('classifies revamp prompts', () => {
  const c = classify('update the entire revamp plan for backtest-engine folder structure');
  assert.equal(c.skill, 'revamp');
});

await test('classifies debug prompts', () => {
  const c = classify('fix null pointer exception in checkout');
  assert.equal(c.skill, 'debug');
});

await test('refine emits brief + token_spec + agent message', () => {
  const r = refine('update the entire revamp plan for /Users/me/trade/backtest-engine');
  assert.equal(r.brief.version, 1);
  assert.equal(r.brief.skill_primary, 'revamp');
  assert.ok(r.brief.acceptance.length >= 1);
  assert.ok(r.brief.refined_prompt.includes('Engineering task'));
  assert.ok(r.token_spec.stages?.length >= 1);
  assert.equal(r.token_spec.stages[0].id, 'explore');
  assert.ok(r.agent_message.includes(r.brief.skill_primary));
});

await test('force skill overrides classification', () => {
  const r = refine('please handle this', { skill: 'test' });
  assert.equal(r.brief.skill_primary, 'test');
});

await test('steward defaults yaml parses stages', () => {
  const sk = loadSkill('revamp');
  assert.ok(sk.defaults.stages?.length >= 2);
  assert.ok(sk.defaults.budgets?.context_tokens > 0);
  assert.equal(sk.defaults.stages[0].id, 'explore');
});

await test('yaml parser handles nested maps and arrays', () => {
  const y = parseYamlReliable(`
skill: demo
budgets:
  context_tokens: 100
stages:
  - id: a
    intent: first
  - id: b
    intent: second
always_keep:
  - errors
  - user_messages
`);
  assert.equal(y.skill, 'demo');
  assert.equal(y.budgets.context_tokens, 100);
  assert.equal(y.stages.length, 2);
  assert.equal(y.stages[0].id, 'a');
  assert.deepEqual(y.always_keep, ['errors', 'user_messages']);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}\n`);
