import { totalTokens } from './parse.mjs';
import { byProject, bySession, byModel, byDay } from './aggregate.mjs';

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set())];
  return [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n') + '\n';
}

const round = (n) => Math.round(n * 1e6) / 1e6;

function bucketRow(b, extra = {}) {
  return {
    ...extra,
    messages: b.messages,
    input_tokens: b.usage.input,
    output_tokens: b.usage.output,
    cache_write_tokens: b.usage.cacheWrite5m + b.usage.cacheWrite1h,
    cache_read_tokens: b.usage.cacheRead,
    total_tokens: b.tokens,
    cost_usd: round(b.cost),
    cost_without_cache_usd: round(b.uncachedCost),
    cache_saving_usd: round(b.saved),
    models: b.modelBreakdown.map((m) => m.model).join('|'),
    first_seen: b.first?.toISOString() ?? '',
    last_seen: b.last?.toISOString() ?? '',
  };
}

/** Flat, spreadsheet-friendly rows for a given level. */
export function flatten(records, level) {
  switch (level) {
    case 'project':
      return byProject(records).map((b) => bucketRow(b, { project: b.key, name: b.name }));
    case 'session':
      return bySession(records).map((b) =>
        bucketRow(b, { session_id: b.key, project: b.project })
      );
    case 'model':
      return byModel(records).map((b) => bucketRow(b, { model: b.key }));
    case 'day':
      return byDay(records).map((b) => bucketRow(b, { date: b.key }));
    case 'message':
    default:
      return records.map((r) => ({
        timestamp: r.at.toISOString(),
        project: r.project,
        session_id: r.sessionId,
        turn: r.turn,
        uuid: r.uuid,
        parent_uuid: r.parentUuid ?? '',
        message_id: r.messageId ?? '',
        request_id: r.requestId ?? '',
        model: r.model,
        is_sidechain: r.isSidechain,
        input_tokens: r.usage.input,
        output_tokens: r.usage.output,
        cache_write_5m_tokens: r.usage.cacheWrite5m,
        cache_write_1h_tokens: r.usage.cacheWrite1h,
        cache_read_tokens: r.usage.cacheRead,
        total_tokens: totalTokens(r.usage),
        cost_usd: round(r.cost),
        cost_without_cache_usd: round(r.uncachedCost),
        priced: r.priced,
        prompt: r.prompt,
        preview: r.preview,
      }));
  }
}
