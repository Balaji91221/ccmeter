import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecords } from './parse.mjs';
import { byProject, bySession, byModel, byDay, totals } from './aggregate.mjs';
import { loadConversation } from './conversation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(__dirname, 'dashboard', 'index.html');

function parseDate(input, { end = false } = {}) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(h|d|w|m)$/i.exec(s);
  if (rel) {
    const mult = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 }[rel[2].toLowerCase()];
    return new Date(Date.now() - Number(rel[1]) * mult);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function filtersFrom(query) {
  return {
    project: query.project || null,
    session: query.session || null,
    model: query.model || null,
    since: parseDate(query.since),
    until: parseDate(query.until, { end: true }),
    noSidechains: query.noSidechains === '1' || query.noSidechains === 'true',
    dir: query.dir || null,
  };
}

function serializeBucket(b, extra = {}) {
  return {
    key: b.key,
    name: b.name ?? null,
    project: b.project ?? null,
    messages: b.messages,
    cost: round(b.cost),
    uncachedCost: round(b.uncachedCost),
    saved: round(b.saved),
    tokens: b.tokens,
    usage: b.usage,
    models: (b.modelBreakdown || []).map((m) => ({
      model: m.model,
      cost: round(m.cost),
      tokens: m.tokens,
      messages: m.messages,
    })),
    first: b.first?.toISOString?.() ?? b.first ?? null,
    last: b.last?.toISOString?.() ?? b.last ?? null,
    ...extra,
  };
}

const round = (n) => Math.round((n || 0) * 1e6) / 1e6;

function serializeRecord(r) {
  return {
    uuid: r.uuid,
    sessionId: r.sessionId,
    project: r.project,
    projectName: r.projectName,
    at: r.at?.toISOString?.() ?? r.at,
    turn: r.turn,
    model: r.model,
    cost: round(r.cost),
    tokens: r.tokens,
    usage: r.usage,
    prompt: r.prompt || '',
    preview: r.preview || '',
    isSidechain: r.isSidechain,
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseUrl(req) {
  const u = new URL(req.url || '/', 'http://localhost');
  const query = Object.fromEntries(u.searchParams.entries());
  return { path: u.pathname, query };
}

async function handleApi(path, query) {
  // Conversation history for a session (full user + assistant timeline)
  if (path === '/api/conversation' || path.startsWith('/api/conversation/')) {
    const session =
      query.session ||
      (path.startsWith('/api/conversation/') ? decodeURIComponent(path.slice('/api/conversation/'.length)) : null);
    if (!session) return { status: 400, body: { error: 'session query param required' } };
    const data = await loadConversation(session, { dir: query.dir || null });
    return { status: 200, body: data };
  }

  const filters = filtersFrom(query);
  const { records, unpricedModels, fileCount } = await loadRecords(filters);
  const t = totals(records);

  if (path === '/api/summary') {
    return {
      status: 200,
      body: {
        cost: round(t.cost),
        uncachedCost: round(t.uncachedCost),
        saved: round(t.saved),
        messages: t.messages,
        tokens: t.tokens,
        usage: t.usage,
        first: t.first?.toISOString?.() ?? null,
        last: t.last?.toISOString?.() ?? null,
        projects: byProject(records).length,
        sessions: bySession(records).length,
        fileCount,
        unpricedModels: Object.fromEntries(unpricedModels),
        filters: {
          project: filters.project,
          session: filters.session,
          model: filters.model,
          since: filters.since?.toISOString?.() ?? null,
          until: filters.until?.toISOString?.() ?? null,
        },
      },
    };
  }

  if (path === '/api/projects') {
    const rows = byProject(records).map((b) =>
      serializeBucket(b, {
        project: b.key,
        name: b.name,
        share: t.cost > 0 ? round((100 * b.cost) / t.cost) : 0,
      })
    );
    return { status: 200, body: { total: rows.length, rows } };
  }

  if (path === '/api/sessions') {
    const limit = Math.max(0, Number(query.limit || 200));
    let rows = bySession(records).map((b) =>
      serializeBucket(b, {
        sessionId: b.key,
        project: b.project,
        name: b.name,
      })
    );
    const sort = query.sort || 'cost';
    if (sort === 'time') rows.sort((a, b) => new Date(b.last || 0) - new Date(a.last || 0));
    else if (sort === 'messages') rows.sort((a, b) => b.messages - a.messages);
    else rows.sort((a, b) => b.cost - a.cost);
    if (limit > 0) rows = rows.slice(0, limit);
    return { status: 200, body: { total: bySession(records).length, rows } };
  }

  if (path === '/api/messages') {
    const limit = Math.max(0, Number(query.limit || 100));
    const sort = query.sort || 'cost';
    let rows = records.map(serializeRecord);
    if (sort === 'time') rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    else if (sort === 'tokens') rows.sort((a, b) => b.tokens - a.tokens);
    else rows.sort((a, b) => b.cost - a.cost);
    const total = rows.length;
    if (limit > 0) rows = rows.slice(0, limit);
    return { status: 200, body: { total, rows } };
  }

  if (path === '/api/daily') {
    const rows = byDay(records).map((b) => serializeBucket(b, { date: b.key }));
    return { status: 200, body: { total: rows.length, rows } };
  }

  if (path === '/api/models') {
    const rows = byModel(records).map((b) => serializeBucket(b, { model: b.key }));
    return { status: 200, body: { total: rows.length, rows } };
  }

  if (path === '/api/health') {
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: 'not found', path } };
}

export function startDashboard({ port = 3847, host = '127.0.0.1', open = false } = {}) {
  if (!existsSync(UI_PATH)) {
    throw new Error(`dashboard UI missing at ${UI_PATH}`);
  }
  const ui = readFileSync(UI_PATH, 'utf8');

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }

      const { path, query } = parseUrl(req);

      if (path === '/' || path === '/index.html') {
        return html(res, 200, ui);
      }

      if (path.startsWith('/api/')) {
        const result = await handleApi(path, query);
        return json(res, result.status, result.body);
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err?.message || String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolve({ server, url, port, host });
    });
  });
}
