import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { configDir, configPath } from './paths.mjs';
import { costInWindow } from './aggregate.mjs';

const DEFAULTS = {
  budgets: { daily: null, weekly: null, monthly: null },
  projects: {},
  warnAt: 0.8,
};

export function loadConfig() {
  const p = configPath('config.json');
  if (!existsSync(p)) return { ...DEFAULTS, path: p, exists: false };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      budgets: { ...DEFAULTS.budgets, ...(raw.budgets || {}) },
      projects: { ...(raw.projects || {}) },
      path: p,
      exists: true,
    };
  } catch (err) {
    throw new Error(`could not read ${p}: ${err.message}`);
  }
}

export function saveConfig(cfg) {
  const { path, exists, ...rest } = cfg;
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath('config.json'), JSON.stringify(rest, null, 2) + '\n');
  return configPath('config.json');
}

const PERIODS = {
  daily: { calendar: 'day', label: 'Today' },
  weekly: { calendar: 'week', label: 'This week' },
  monthly: { calendar: 'month', label: 'This month' },
};

/**
 * Evaluate every configured limit against the records.
 * @returns {Array<{scope,period,label,limit,spent,fraction,state}>}
 */
export function evaluate(records, cfg) {
  const rows = [];

  const push = (scope, period, limit, project) => {
    if (!limit || limit <= 0) return;
    const { cost } = costInWindow(records, { calendar: PERIODS[period].calendar, project });
    const fraction = cost / limit;
    rows.push({
      scope,
      period,
      label: PERIODS[period].label,
      limit,
      spent: cost,
      fraction,
      state: fraction >= 1 ? 'over' : fraction >= (cfg.warnAt ?? 0.8) ? 'warn' : 'ok',
    });
  };

  for (const period of Object.keys(PERIODS)) push('all', period, cfg.budgets?.[period], null);
  for (const [name, limits] of Object.entries(cfg.projects || {})) {
    for (const period of Object.keys(PERIODS)) push(name, period, limits?.[period], name);
  }
  return rows;
}

/** Parse `monthly=200` / `myproj.daily=5` into a config mutation. */
export function applySetting(cfg, expr) {
  const m = /^(?:(.+)\.)?(daily|weekly|monthly)=(.*)$/.exec(expr.trim());
  if (!m) throw new Error(`cannot parse "${expr}" — expected [project.]daily|weekly|monthly=AMOUNT`);
  const [, project, period, rawValue] = m;
  const value = rawValue === '' || rawValue === 'off' ? null : Number(rawValue);
  if (value !== null && !Number.isFinite(value)) throw new Error(`"${rawValue}" is not a number`);

  if (project) {
    cfg.projects[project] = cfg.projects[project] || {};
    cfg.projects[project][period] = value;
    if (Object.values(cfg.projects[project]).every((v) => v == null)) delete cfg.projects[project];
  } else {
    cfg.budgets[period] = value;
  }
  return cfg;
}
