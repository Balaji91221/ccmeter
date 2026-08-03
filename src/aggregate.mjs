import { addUsage, zeroUsage, totalTokens } from './parse.mjs';

function blankBucket(key, extra = {}) {
  return {
    key,
    usage: zeroUsage(),
    cost: 0,
    uncachedCost: 0,
    messages: 0,
    models: new Map(),
    first: null,
    last: null,
    ...extra,
  };
}

function absorb(bucket, rec) {
  bucket.usage = addUsage(bucket.usage, rec.usage);
  bucket.cost += rec.cost;
  bucket.uncachedCost += rec.uncachedCost;
  bucket.messages += 1;
  const m = bucket.models.get(rec.model) || { cost: 0, tokens: 0, messages: 0 };
  m.cost += rec.cost;
  m.tokens += rec.tokens;
  m.messages += 1;
  bucket.models.set(rec.model, m);
  if (!bucket.first || rec.at < bucket.first) bucket.first = rec.at;
  if (!bucket.last || rec.at > bucket.last) bucket.last = rec.at;
  return bucket;
}

function finish(bucket) {
  bucket.tokens = totalTokens(bucket.usage);
  bucket.saved = bucket.uncachedCost - bucket.cost;
  bucket.modelBreakdown = [...bucket.models.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.cost - a.cost);
  delete bucket.models;
  return bucket;
}

function groupBy(records, keyFn, extraFn = () => ({})) {
  const map = new Map();
  for (const rec of records) {
    const key = keyFn(rec);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, blankBucket(key, extraFn(rec)));
    absorb(map.get(key), rec);
  }
  return [...map.values()].map(finish).sort((a, b) => b.cost - a.cost);
}

export const byProject = (records) =>
  groupBy(records, (r) => r.project, (r) => ({ name: r.projectName, dir: r.projectDir }));

export const bySession = (records) =>
  groupBy(records, (r) => r.sessionId, (r) => ({ project: r.project, name: r.projectName }));

export const byModel = (records) => groupBy(records, (r) => r.model);

export const byDay = (records) =>
  groupBy(records, (r) => r.at.toISOString().slice(0, 10)).sort((a, b) =>
    a.key < b.key ? -1 : 1
  );

/** Project -> sessions -> messages, the unified view. */
export function tree(records, { messagesPerSession = 0 } = {}) {
  const projects = new Map();
  for (const rec of records) {
    if (!projects.has(rec.project)) {
      projects.set(rec.project, { ...blankBucket(rec.project, { name: rec.projectName }), sessions: new Map() });
    }
    const p = projects.get(rec.project);
    absorb(p, rec);
    if (!p.sessions.has(rec.sessionId)) {
      p.sessions.set(rec.sessionId, { ...blankBucket(rec.sessionId), records: [] });
    }
    const s = p.sessions.get(rec.sessionId);
    absorb(s, rec);
    s.records.push(rec);
  }

  return [...projects.values()]
    .map((p) => {
      const sessions = [...p.sessions.values()]
        .map((s) => {
          const recs = [...s.records].sort((a, b) => b.cost - a.cost);
          const out = finish(s);
          out.records = messagesPerSession > 0 ? recs.slice(0, messagesPerSession) : recs;
          out.truncated = messagesPerSession > 0 && recs.length > messagesPerSession;
          return out;
        })
        .sort((a, b) => b.cost - a.cost);
      delete p.sessions;
      const out = finish(p);
      out.sessions = sessions;
      return out;
    })
    .sort((a, b) => b.cost - a.cost);
}

/** Totals across everything passed in. */
export function totals(records) {
  const bucket = blankBucket('total');
  for (const rec of records) absorb(bucket, rec);
  return finish(bucket);
}

/** Sum of cost within a rolling or calendar window ending now. */
export function costInWindow(records, { days = null, calendar = null, project = null } = {}) {
  const now = new Date();
  let start;
  if (calendar === 'day') start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (calendar === 'week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    start = d;
  } else if (calendar === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1);
  else start = new Date(now.getTime() - days * 86400000);

  let cost = 0;
  for (const rec of records) {
    if (rec.at < start) continue;
    if (project && !String(rec.project).toLowerCase().includes(project.toLowerCase())) continue;
    cost += rec.cost;
  }
  return { cost, start };
}
