# ccmeter

Per-message, per-session and per-project cost analysis for Claude Code, read straight from the raw JSONL transcripts.

`ccusage` already answers "what did this project cost" and "what did this session cost". `ccmeter` answers the question it doesn't: **which individual turn cost that much, and why**. Everything rolls up from the same message-level records, so project totals, session totals, budgets and exports are all views over one dataset rather than separate code paths.

Zero runtime dependencies. Node 18+.

---

## Install

```bash
# run it without installing
npx ccmeter projects

# or clone and link
git clone <your-repo> ccmeter && cd ccmeter
npm link
ccmeter doctor
```

`ccmeter doctor` is the first thing to run — it prints which transcript directories were found, how many turns were parsed, and the pricing table in effect.

---

## Commands

| Command | What it shows |
| --- | --- |
| `ccmeter projects` | Spend by project, with each project's share of the total |
| `ccmeter sessions` | Spend by session, with the models used in each |
| `ccmeter messages` | Every assistant turn, individually priced |
| `ccmeter tree` | Project → session → message in one view |
| `ccmeter daily` | Spend per calendar day, with a sparkline |
| `ccmeter models` | Spend by model, plus what prompt caching saved |
| `ccmeter budget` | Spend against your configured limits |
| `ccmeter export` | CSV or JSON at any level |
| `ccmeter doctor` | Where the data came from and how it's being priced |
| `ccmeter dashboard` | Local web UI for sessions & full conversation history |

### Dashboard

```bash
npm start
# or
node bin/ccmeter.mjs dashboard
# open http://127.0.0.1:3847
```

Browse **Overview** (spend charts), **Sessions**, **Conversation** (full user ↔ assistant timeline with per-turn cost), **Projects**, and **Expensive turns**. Filter by project, date (`7d`, `2026-07-01`), or model. Click any session to open its conversation history.

### Prompt refiner (engineering skills)

Turn a vague request into a structured brief + stage token-spec (offline, no API):

```bash
npm run refine -- "update the entire revamp plan for backtest-engine"
npm run refine -- -p "fix login timeout" --skill debug -o ./out
# writes out/brief.json out/token-spec.json out/agent.md
```

Skills live under `skills/` (`debug`, `feature`, `refactor`, `revamp`, `test`). Full design plan: `docs/full-plan-prompt-refiner-headroom.html`.

Filters work on every command: `-p/--project`, `-s/--session`, `-m/--model`, `--since`, `--until`, `--no-sidechains`, `--dir`.

Dates accept `2026-07-01`, a full ISO timestamp, or a relative span: `24h`, `7d`, `2w`, `3m`.

```bash
ccmeter projects --since 30d
ccmeter sessions -p checkout-api --breakdown
ccmeter messages -s 4f2a --sort cost -n 10
ccmeter tree -p checkout-api --top 3 --sessions 2
ccmeter daily --since 14d
```

### The expensive-turn view

```
$ ccmeter messages --sort cost -n 5

WHEN              TURN  MODEL   IN   OUT  CACHE W  CACHE R   COST  PROMPT
────────────────────────────────────────────────────────────────────────────────────
2026-07-31 12:39     6  opus-5  36  3.0k     2.9k      44k  $0.12  write migration for…
2026-07-31 10:18     3  opus-5  12  2.8k     2.8k      47k  $0.11  write migration for…
```

Each row is one assistant response. `PROMPT` is the user message that triggered it, so an expensive turn is traceable back to what you asked for. `--sort` takes `cost`, `tokens` or `time`.

### Budgets

```bash
ccmeter budget --set monthly=200
ccmeter budget --set daily=10
ccmeter budget --set checkout-api.monthly=50   # per-project limit
ccmeter budget
```

`--strict` exits `1` when any limit is exceeded, which makes it usable as a shell guard or a Claude Code `SessionStart` hook:

```bash
ccmeter budget --strict --quiet || echo "over budget — maybe switch to Haiku today"
```

Limits are calendar-based (today, this ISO week, this month), and the bar turns yellow at 80% by default (`warnAt` in the config).

### Export

```bash
ccmeter export --level message --csv -o usage.csv
ccmeter export --level session --json -o sessions.json
ccmeter export --level day --csv
```

Levels: `message`, `session`, `project`, `model`, `day`. Message rows carry `uuid` and `parent_uuid`, so the turn tree can be rebuilt in whatever tool you load them into.

Any command also takes `--json` / `--csv` directly if you'd rather not use `export`.

---

## How it reads the data

Transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (also checked: `$CLAUDE_CONFIG_DIR`, `~/.config/claude`). One JSON object per line. Only `type: "assistant"` lines carry a `usage` block:

```json
{
  "input_tokens": 4,
  "output_tokens": 812,
  "cache_creation_input_tokens": 1200,
  "cache_read_input_tokens": 38000,
  "cache_creation": { "ephemeral_5m_input_tokens": 1200, "ephemeral_1h_input_tokens": 0 }
}
```

Four things that trip up a naive `jq` pipeline, all handled here:

- **Duplicate turns.** Resumed sessions and `--continue` replay history, so the same response can appear on several lines. Records are de-duplicated on `message.id` + `requestId`.
- **Truncated tails.** A live session's last line is often half-written. Unparseable lines are skipped, not fatal.
- **Cache write tiers.** 5-minute and 1-hour writes bill at 1.25x and 2x base input. When only the legacy `cache_creation_input_tokens` field is present, everything is billed at the 5-minute rate, which is what Claude Code uses by default.
- **Project identity.** The folder name is a lossy encoding of the working directory (`/` and `.` both become `-`), so the real `cwd` from inside the transcript is preferred, with the folder name as fallback.

Files are streamed line by line, so a large history never gets loaded into memory at once.

---

## Pricing

Rates are in `src/pricing.mjs`, in USD per million tokens, taken from Anthropic's pricing page (verified 2026-08-02):
<https://platform.claude.com/docs/en/about-claude/pricing>

Cache multipliers are baked in per the docs: 5-minute write 1.25x base input, 1-hour write 2x, cache read 0.1x.

Scheduled price changes are supported — Sonnet 5's introductory $2/$10 rate applies to turns before 2026-09-01 and $3/$15 after, priced by each message's own timestamp rather than by today's date.

Rather than editing the table, drop overrides in `~/.config/ccmeter/pricing.json`:

```json
[
  {
    "match": "^claude-my-model",
    "label": "Custom",
    "rates": { "input": 4, "cacheWrite5m": 5, "cacheWrite1h": 8, "cacheRead": 0.4, "output": 20 }
  }
]
```

User entries are checked before the built-ins, so this also works to correct a stale rate.

### Known gaps

Costs are estimates reconstructed from the transcripts, not billing records. Reconcile against the Console before anything financial depends on them.

- **Fast mode** (`speed: "fast"` on Opus 5 / 4.8, billed $10/$50) isn't recorded in the transcripts, so those turns are under-counted.
- **US-only inference** (`inference_geo: "us"`, a 1.1x multiplier) likewise isn't recorded.
- **Server-side tool charges** — web search is $10 per 1,000 searches on top of tokens — are not in the per-message usage block.
- **Subscription users** (Pro/Max) aren't billed per token at all. The numbers still tell you where your usage is concentrated, but they're the API-equivalent cost, not a bill.

---

## Config

`~/.config/ccmeter/config.json`:

```json
{
  "budgets": { "daily": 10, "weekly": 50, "monthly": 200 },
  "projects": { "checkout-api": { "monthly": 50 } },
  "warnAt": 0.8
}
```

Environment: `CCMETER_DIR` (a specific `projects/` directory), `CCMETER_CONFIG_DIR`, `NO_COLOR`, `CCMETER_DEBUG=1` for stack traces.

---

## Use as a library

```js
import { loadRecords, byProject, tree } from 'ccmeter';

const { records } = await loadRecords({ since: new Date('2026-07-01') });
for (const p of byProject(records)) {
  console.log(p.key, p.cost.toFixed(2), p.saved.toFixed(2));
}
```

---

## Tests

```bash
npm test
```

The suite generates synthetic transcripts that deliberately include a replayed duplicate turn, a truncated final line, a sidechain turn and an unknown model, then asserts on pricing maths, de-duplication, filters, and that project and session totals both reconcile to the grand total.
