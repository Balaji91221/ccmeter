import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { listTranscripts } from './paths.mjs';
import { costOf, uncachedCostOf, isFreeModel } from './pricing.mjs';
import { totalTokens } from './parse.mjs';

/**
 * Load full conversation history for one or more sessions.
 * Includes user + assistant turns (cost-bearing assistants priced as usual).
 */
export async function loadConversation(sessionId, opts = {}) {
  if (!sessionId) throw new Error('session id required');
  const prefix = String(sessionId);
  const files = listTranscripts(opts).filter((f) => f.sessionId.startsWith(prefix));
  if (!files.length) return { sessionId: prefix, events: [], files: [] };

  const events = [];
  const seen = new Set();

  for (const meta of files) {
    const rl = createInterface({
      input: createReadStream(meta.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let turn = 0;
    let lineNo = 0;

    for await (const line of rl) {
      lineNo++;
      const s = line.trim();
      if (!s || s[0] !== '{') continue;

      let row;
      try {
        row = JSON.parse(s);
      } catch {
        continue;
      }

      const type = row.type;
      if (type !== 'user' && type !== 'assistant') continue;

      const message = row.message;
      if (!message) continue;

      const at = row.timestamp ? new Date(row.timestamp) : new Date(0);
      const text = extractText(message);
      const tools = extractTools(message);

      if (type === 'user') {
        turn++;
        // Skip pure tool-result-only user rows if they have no readable text
        // (still keep them if they carry tool results — useful context).
        const key = row.uuid || `user:${meta.sessionId}:${lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);

        events.push({
          role: 'user',
          uuid: row.uuid ?? key,
          parentUuid: row.parentUuid ?? null,
          sessionId: row.sessionId || meta.sessionId,
          project: row.cwd || meta.projectGuess,
          at: at.toISOString(),
          turn,
          text,
          tools,
          isToolResult: tools.some((t) => t.kind === 'tool_result') && !text,
          isSidechain: Boolean(row.isSidechain),
          cost: 0,
          tokens: 0,
          model: null,
          usage: null,
        });
        continue;
      }

      // assistant
      const usage = normalizeUsage(message.usage);
      if (!usage) {
        // assistant without usage (e.g. error) — still show text if any
        if (!text && !tools.length) continue;
        const key = row.uuid || `asst:${meta.sessionId}:${lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          role: 'assistant',
          uuid: row.uuid ?? key,
          parentUuid: row.parentUuid ?? null,
          sessionId: row.sessionId || meta.sessionId,
          project: row.cwd || meta.projectGuess,
          at: at.toISOString(),
          turn,
          text,
          tools,
          isToolResult: false,
          isSidechain: Boolean(row.isSidechain),
          cost: 0,
          tokens: 0,
          model: message.model || row.model || null,
          usage: null,
        });
        continue;
      }

      const model = message.model || row.model || '';
      const { cost, priced } = costOf(usage, model, at);
      const key =
        message.id && row.requestId
          ? `${message.id}:${row.requestId}`
          : message.id || row.uuid || `asst:${meta.sessionId}:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);

      events.push({
        role: 'assistant',
        uuid: row.uuid ?? key,
        parentUuid: row.parentUuid ?? null,
        messageId: message.id ?? null,
        requestId: row.requestId ?? null,
        sessionId: row.sessionId || meta.sessionId,
        project: row.cwd || meta.projectGuess,
        at: at.toISOString(),
        turn,
        text,
        tools,
        isToolResult: false,
        isSidechain: Boolean(row.isSidechain),
        cost,
        tokens: totalTokens(usage),
        model,
        priced: priced || isFreeModel(model),
        uncachedCost: uncachedCostOf(usage, model, at),
        usage: {
          input: usage.input,
          output: usage.output,
          cacheWrite: usage.cacheWrite5m + usage.cacheWrite1h,
          cacheRead: usage.cacheRead,
        },
      });
    }
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const cost = events.reduce((s, e) => s + (e.cost || 0), 0);
  const tokens = events.reduce((s, e) => s + (e.tokens || 0), 0);
  const assistants = events.filter((e) => e.role === 'assistant' && e.usage);
  const models = [...new Set(assistants.map((e) => e.model).filter(Boolean))];
  const projects = [...new Set(events.map((e) => e.project).filter(Boolean))];

  return {
    sessionId: files[0]?.sessionId || prefix,
    files: files.map((f) => f.file),
    first: events[0]?.at ?? null,
    last: events[events.length - 1]?.at ?? null,
    cost,
    tokens,
    messages: events.length,
    assistantTurns: assistants.length,
    models,
    projects,
    events,
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const legacyWrite = num(u.cache_creation_input_tokens);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheWrite5m: cc ? write5m : legacyWrite,
    cacheWrite1h: cc ? write1h : 0,
    cacheRead: num(u.cache_read_input_tokens),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function extractText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const block of c) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function extractTools(message) {
  if (!message || !Array.isArray(message.content)) return [];
  const tools = [];
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      tools.push({
        kind: 'tool_use',
        name: block.name || 'tool',
        id: block.id || null,
        inputPreview: previewJson(block.input, 200),
      });
    } else if (block.type === 'tool_result') {
      const content =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((x) => (x && x.type === 'text' ? x.text : ''))
                .join('\n')
            : previewJson(block.content, 200);
      tools.push({
        kind: 'tool_result',
        name: 'tool_result',
        id: block.tool_use_id || block.id || null,
        inputPreview: String(content || '').slice(0, 200),
      });
    } else if (block.type === 'thinking') {
      tools.push({ kind: 'thinking', name: 'thinking', id: null, inputPreview: '' });
    }
  }
  return tools;
}

function previewJson(v, max = 200) {
  if (v == null) return '';
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    return String(v).slice(0, max);
  }
}
