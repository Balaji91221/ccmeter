import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

const PROMPTS = [
  'refactor the auth middleware',
  'why is this test flaky?',
  'add pagination to the users endpoint',
  'explain this stack trace',
  'write migration for the orders table',
];

function rand(n) {
  return Math.floor(Math.random() * n);
}

/**
 * Writes a fake ~/.claude/projects tree with a few projects, sessions and turns.
 * Deliberately includes the things that break naive parsers: a duplicated
 * assistant line (resumed session), a truncated final line, a sidechain turn,
 * and an unknown model.
 */
export function makeFixtures(root, { seedDate = new Date(Date.now() - 3 * 86400000) } = {}) {
  rmSync(root, { recursive: true, force: true });

  const projects = [
    { cwd: '/home/ada/dev/checkout-api', sessions: 3 },
    { cwd: '/home/ada/dev/marketing-site', sessions: 2 },
    { cwd: '/home/ada/scratch', sessions: 1 },
  ];

  // Spread sessions across the window so daily/budget views have real shape.
  const totalSessions = projects.reduce((n, p) => n + p.sessions, 0);
  const span = Date.now() - seedDate.getTime();
  let sessionIndex = 0;
  let clock = seedDate.getTime();

  for (const proj of projects) {
    const encoded = proj.cwd.replace(/[/.]/g, '-');
    const dir = join(root, encoded);
    mkdirSync(dir, { recursive: true });

    for (let s = 0; s < proj.sessions; s++) {
      const sessionId = randomUUID();
      clock = seedDate.getTime() + Math.floor((span * sessionIndex) / totalSessions);
      sessionIndex++;
      const lines = [];
      let parent = null;
      const turns = 4 + rand(6);

      for (let t = 0; t < turns; t++) {
        clock += (30 + rand(600)) * 1000;
        const userUuid = randomUUID();
        lines.push(
          JSON.stringify({
            type: 'user',
            uuid: userUuid,
            parentUuid: parent,
            sessionId,
            cwd: proj.cwd,
            version: '2.1.0',
            timestamp: new Date(clock).toISOString(),
            message: { role: 'user', content: PROMPTS[rand(PROMPTS.length)] },
          })
        );

        clock += (5 + rand(90)) * 1000;
        const assistantUuid = randomUUID();
        const model = MODELS[rand(MODELS.length)];
        const cacheRead = t === 0 ? 0 : 20000 + rand(60000);
        const line = {
          type: 'assistant',
          uuid: assistantUuid,
          parentUuid: userUuid,
          sessionId,
          requestId: 'req_' + randomUUID().slice(0, 12),
          cwd: proj.cwd,
          version: '2.1.0',
          isSidechain: t === 2 && s === 0,
          timestamp: new Date(clock).toISOString(),
          message: {
            id: 'msg_' + randomUUID().slice(0, 12),
            role: 'assistant',
            model,
            content: [
              { type: 'text', text: 'Here is what I changed and why it should fix the issue.' },
              ...(rand(2) ? [{ type: 'tool_use', name: 'Edit', input: {} }] : []),
            ],
            usage: {
              input_tokens: 3 + rand(40),
              output_tokens: 200 + rand(3000),
              cache_creation_input_tokens: rand(4000),
              cache_read_input_tokens: cacheRead,
              cache_creation: {
                ephemeral_5m_input_tokens: rand(4000),
                ephemeral_1h_input_tokens: 0,
              },
            },
          },
        };
        lines.push(JSON.stringify(line));

        // Resumed sessions replay a turn verbatim — must be de-duplicated.
        if (t === 1) lines.push(JSON.stringify(line));

        parent = assistantUuid;
      }

      // An unpriced model, to exercise the warning path.
      if (s === 0) {
        lines.push(
          JSON.stringify({
            type: 'assistant',
            uuid: randomUUID(),
            sessionId,
            cwd: proj.cwd,
            timestamp: new Date(clock + 1000).toISOString(),
            message: {
              id: 'msg_' + randomUUID().slice(0, 12),
              model: 'claude-experimental-9',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 10, output_tokens: 10 },
            },
          })
        );
      }

      // A half-written final line, as happens mid-session.
      lines.push('{"type":"assistant","uuid":"trunc');

      writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
    }
  }
  return root;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || '/tmp/ccmeter-fixtures/projects';
  makeFixtures(target);
  console.log(`fixtures written to ${target}`);
}
