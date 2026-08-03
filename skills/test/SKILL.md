# Skill: test

## Trigger
test, unit test, e2e, coverage, assert, jest, pytest, spec, fixture, flaky

## Purpose
Add or fix tests with clear scope, fixtures, and flaky policy — not random coverage chasing.

## Required brief fields
- goal (what behavior is protected)
- acceptance (tests pass; named cases)
- scope_in (modules / flows)

## Procedure
1. Inventory existing tests and gaps
2. Define cases: happy, edge, failure
3. Add minimal fixtures
4. Run targeted suite; fix flakes only if in scope
5. Report coverage of the *risk*, not vanity %

## Anti-patterns
- Snapshot everything
- Testing implementation details only
- Massive fixtures no one can read
- Ignoring flaky tests

## Token hints
- Prefer failing test output snippets over full suite logs
- Crush large fixture JSON; keep schema + 1–2 examples
- Full source only for units under test

## Done when
Named acceptance cases pass; residual gaps listed if any.
