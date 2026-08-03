# Engineering skills (Prompt Refiner)

Skill packs used by `bin/refine.mjs` to turn raw prompts into structured **Engineering Briefs** and **token-spec** stage plans.

## Skills (MVP)

| Skill | When |
|-------|------|
| `debug` | fix, bug, crash, exception |
| `feature` | add, implement, build |
| `refactor` | cleanup, restructure (behavior-preserving) |
| `revamp` | redesign, folder structure, overhaul plan |
| `test` | unit/e2e/coverage |

## Layout

```
skills/
  brief.schema.json
  <skill>/
    SKILL.md                 # triggers, procedure, anti-patterns
    prompt.template.md       # agent-facing brief template
    steward.defaults.yaml    # stages + token budgets
```

## Usage

```bash
npm run refine -- "update the entire revamp plan for backtest-engine"
npm run refine -- -p "fix null pointer in checkout" --skill debug -o ./out
npm run refine -- --list-skills
```

Outputs:

- **human summary** — skill, complexity, stages
- **agent message** — paste into Claude Code / Codex
- **brief.json** + **token-spec.json** when using `-o <dir>`
