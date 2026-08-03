# Skill: feature

## Trigger
add, implement, build, create, new feature, support, endpoint, capability

## Purpose
Ship a scoped feature with clear acceptance, API surface, and tests — not an open-ended build.

## Required brief fields
- goal (user-visible outcome)
- acceptance (testable)
- deliverables
- constraints (compat, security)

## Procedure
1. Clarify user story + non-goals
2. Design minimal interface (API / CLI / UI contract)
3. Implement in thin vertical slices
4. Tests for happy path + one failure path
5. Document usage briefly

## Anti-patterns
- Building three designs at once
- Skipping tests "for later"
- Expanding scope mid-flight without updating brief
- Giant PR with no slice checkpoints

## Token hints
- Don't load entire monorepo; start from entrypoints
- Prefer interface files + call sites over full implementations
- Crush fixture dumps; keep schema samples

## Done when
Acceptance criteria pass; deliverables exist; no unscoped extras.
