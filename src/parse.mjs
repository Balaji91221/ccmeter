import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { listTranscripts } from './paths.mjs';
import { costOf, uncachedCostOf, isFreeModel } from './pricing.mjs';

/**
 * A transcript line looks roughly like:
 * {
 *   "type": "assistant", "uuid": "...", "parentUuid": "...",
 *   "sessionId": "...", "requestId": "req_...", "timestamp": "2026-…Z",
 *   "cwd": "/Users/ada/dev/app", "version": "2.0.1", "isSidechain": false,
 *   "message": { "id": "msg_...", "model": "claude-opus-5",
 *                "content": [...],
 *                "usage": { "input_tokens": 4, "output_tokens": 812,
 *                           "cache_creation_input_tokens": 1200,
 *                           "cache_read_input_tokens": 38000,
 *                           "cache_creation": { "ephemeral_5m_input_tokens": 1200,
 *                                               "ephemeral_1h_input_tokens": 0 } } }
 * }
 * Only assistant lines carry `usage`. Everything else (user turns, tool
 * results, summaries, hooks) is free, but we keep user lines so a turn can be
 * paired with the prompt that caused it.
 */

const EMPTY_USAGE = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const legacyWrite = num(u.cache_creation_input_tokens);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    // When the granular breakdown is absent, bill all cache writes at the
    // 5-minute rate — that is what Claude Code uses by default.
    cacheWrite5m: cc ? write5m : legacyWrite,
    cacheWrite1h: cc ? write1h : 0,
    cacheRead: num(u.cache_read_input_tokens),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const totalTokens = (u) =>
  u.input + u.output + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;

export function addUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

export const zeroUsage = () => ({ ...EMPTY_USAGE });

/** First ~120 chars of human-readable text in a message, for context in tables. */
function preview(message) {
  if (!message) return '';
  const c = message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const block of c) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) text += block.text + ' ';
      else if (block.type === 'thinking') text += '[thinking] ';
      else if (block.type === 'tool_use') text += `[tool:${block.name}] `;
      else if (block.type === 'tool_result') text += '[tool_result] ';
      else if (block.type === 'image') text += '[image] ';
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Read one transcript file and yield normalized records.
 * Streams line by line so a multi-hundred-MB history never lands in memory.
 */
export async function* readTranscript(meta) {
  const rl = createInterface({
    input: createReadStream(meta.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let turn = 0;
  let lastUserPreview = '';
  let lineNo = 0;

  for await (const line of rl) {
    lineNo++;
    const s = line.trim();
    if (!s || s[0] !== '{') continue;

    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue; // partial write at the tail of a live session
    }

    const type = row.type;
    if (type === 'user') {
      turn++;
      lastUserPreview = preview(row.message);
      continue;
    }
    if (type !== 'assistant' || !row.message) continue;

    const usage = normalizeUsage(row.message.usage);
    if (!usage) continue;

    const at = row.timestamp ? new Date(row.timestamp) : new Date(0);
    const model = row.message.model || row.model || '';
    const { cost, priced, label } = costOf(usage, model, at);

    yield {
      uuid: row.uuid ?? `${meta.sessionId}:${lineNo}`,
      parentUuid: row.parentUuid ?? null,
      messageId: row.message.id ?? null,
      requestId: row.requestId ?? null,
      sessionId: row.sessionId || meta.sessionId,
      project: row.cwd || meta.projectGuess,
      projectDir: meta.projectDir,
      projectName: row.cwd ? basename(row.cwd) : meta.projectShort,
      file: meta.file,
      at,
      turn,
      model,
      modelLabel: label,
      usage,
      tokens: totalTokens(usage),
      cost,
      uncachedCost: uncachedCostOf(usage, model, at),
      priced: priced || isFreeModel(model),
      isSidechain: Boolean(row.isSidechain),
      version: row.version ?? null,
      prompt: lastUserPreview,
      preview: preview(row.message),
    };
  }
}

/**
 * Read every transcript (optionally filtered), de-duplicated.
 *
 * A single API response can appear on more than one line — streaming chunks,
 * resumed sessions, and `--continue` all replay history. Anthropic's own
 * usage tooling keys on message id + request id; we do the same, and fall
 * back to the line uuid when either is missing.
 */
export async function loadRecords(opts = {}) {
  const seen = new Set();
  const records = [];
  const warnings = new Map();

  let files = listTranscripts(opts);
  if (opts.project) files = files.filter((f) => matchesProject(f, opts.project));
  if (opts.session) files = files.filter((f) => f.sessionId.startsWith(opts.session));

  for (const meta of files) {
    for await (const rec of readTranscript(meta)) {
      const key =
        rec.messageId && rec.requestId
          ? `${rec.messageId}:${rec.requestId}`
          : rec.messageId || rec.uuid;
      if (seen.has(key)) continue;
      seen.add(key);

      if (opts.since && rec.at < opts.since) continue;
      if (opts.until && rec.at > opts.until) continue;
      if (opts.project && !matchesProject(rec, opts.project)) continue;
      if (opts.model && !rec.model.toLowerCase().includes(opts.model.toLowerCase())) continue;
      if (opts.noSidechains && rec.isSidechain) continue;

      if (!rec.priced && rec.tokens > 0) {
        warnings.set(rec.model, (warnings.get(rec.model) || 0) + 1);
      }
      records.push(rec);
    }
  }

  records.sort((a, b) => a.at - b.at);
  return { records, unpricedModels: warnings, fileCount: files.length };
}

function matchesProject(rec, needle) {
  const n = needle.toLowerCase();
  return [rec.project, rec.projectDir, rec.projectName, rec.projectGuess, rec.projectShort]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(n));
}
