/**
 * Pricing table for Claude models, in USD per million tokens.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Verified: 2026-08-02. Prices change — override locally with
 * `~/.config/ccmeter/pricing.json` (same shape as RATES below) rather than
 * editing this file, so you keep upstream updates.
 *
 * Cache multipliers relative to base input, per the docs:
 *   5-minute cache write = 1.25x, 1-hour cache write = 2x, cache read = 0.1x
 * Those multipliers are already baked into the numbers below.
 */

import { readFileSync, existsSync } from 'node:fs';
import { configPath } from './paths.mjs';

const M = 1_000_000;

/**
 * Each entry: { match, label, rates: { input, cacheWrite5m, cacheWrite1h, cacheRead, output } }
 * `match` is tested against the lowercased model id. Order matters — the first
 * match wins, so keep specific patterns above generic ones.
 * `from` / `until` (ISO dates) let one model carry scheduled price changes.
 */
export const RATES = [
  // --- Current generation ---
  {
    match: /^claude-(fable|mythos)-5/,
    label: 'Fable / Mythos 5',
    rates: { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  },
  {
    match: /^claude-opus-(5|4-[5-8])/,
    label: 'Opus 5 / 4.5-4.8',
    rates: { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    // Fast mode (speed: "fast") on Opus 5 / 4.8 bills at $10/$50. The JSONL
    // transcripts do not record the speed flag, so fast-mode turns are
    // under-counted here. See README "Known gaps".
  },
  {
    match: /^claude-opus-4(-1)?(-|$)/,
    label: 'Opus 4 / 4.1 (deprecated)',
    rates: { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  },
  {
    match: /^claude-sonnet-5/,
    label: 'Sonnet 5 (introductory)',
    until: '2026-09-01',
    rates: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  },
  {
    match: /^claude-sonnet-5/,
    label: 'Sonnet 5',
    from: '2026-09-01',
    rates: { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  },
  {
    match: /^claude-sonnet-4(-[4-6])?(-|$)/,
    label: 'Sonnet 4 / 4.5 / 4.6',
    rates: { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  },
  {
    match: /^claude-haiku-4-5/,
    label: 'Haiku 4.5',
    rates: { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  },
  {
    match: /^claude-3-5-haiku|^claude-haiku-3-5/,
    label: 'Haiku 3.5 (retired)',
    rates: { input: 0.8, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, output: 4 },
  },
];

/** Models that legitimately have no cost and should not raise a warning. */
const FREE_MODELS = [/^<synthetic>$/, /^synthetic$/];

let userRates = null;

/** Load `~/.config/ccmeter/pricing.json` once; entries take precedence. */
function loadUserRates() {
  if (userRates !== null) return userRates;
  const p = configPath('pricing.json');
  if (!existsSync(p)) return (userRates = []);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    userRates = (Array.isArray(raw) ? raw : []).map((e) => ({
      ...e,
      match: new RegExp(e.match, 'i'),
      source: 'user',
    }));
  } catch (err) {
    process.emitWarning(`ccmeter: could not parse ${p}: ${err.message}`);
    userRates = [];
  }
  return userRates;
}

/**
 * Resolve rates for a model id at a point in time.
 * @param {string} model
 * @param {Date} [at] timestamp of the message, for scheduled price changes
 */
export function ratesFor(model, at = new Date()) {
  if (!model) return null;
  const id = String(model).toLowerCase();
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();

  for (const entry of [...loadUserRates(), ...RATES]) {
    if (!entry.match.test(id)) continue;
    if (entry.from && t < Date.parse(entry.from)) continue;
    if (entry.until && t >= Date.parse(entry.until)) continue;
    return entry;
  }
  return null;
}

export function isFreeModel(model) {
  const id = String(model ?? '').toLowerCase();
  return !id || FREE_MODELS.some((re) => re.test(id));
}

/**
 * Cost in USD for one usage block.
 * @param {{input:number,output:number,cacheWrite5m:number,cacheWrite1h:number,cacheRead:number}} usage
 * @param {string} model
 * @param {Date} at
 * @returns {{cost:number, priced:boolean, label:string|null}}
 */
export function costOf(usage, model, at) {
  const entry = ratesFor(model, at);
  if (!entry) return { cost: 0, priced: isFreeModel(model), label: null };
  const r = entry.rates;
  const cost =
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheWrite5m * r.cacheWrite5m +
      usage.cacheWrite1h * r.cacheWrite1h +
      usage.cacheRead * r.cacheRead) /
    M;
  return { cost, priced: true, label: entry.label };
}

/**
 * What the same tokens would have cost with no prompt caching at all:
 * every cache read and cache write billed as plain input. The delta against
 * the real cost is the caching saving.
 */
export function uncachedCostOf(usage, model, at) {
  const entry = ratesFor(model, at);
  if (!entry) return 0;
  const r = entry.rates;
  const inputish = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  return (inputish * r.input + usage.output * r.output) / M;
}
