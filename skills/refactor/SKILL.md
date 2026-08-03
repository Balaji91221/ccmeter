# Skill: refactor

## Trigger
refactor, cleanup, restructure, extract, simplify, dedupe, rename module, split

## Purpose
Improve structure without changing external behavior. Safety first: invariants + tests.

## Required brief fields
- goal (structure outcome)
- constraints (behavior freeze)
- acceptance (tests still pass; no public API break unless stated)

## Procedure
1. Inventory current structure and invariants
2. Define target structure (small, incremental)
3. Move/extract with tests green after each step
4. Remove dead code only when proven unused
5. Summarize behavior-preserving guarantee

## Anti-patterns
- Mixing feature work into refactor
- Big-bang rewrite without checkpoints
- Changing public APIs "while here"
- Skipping tests because "it's just moves"

## Token hints
- Signatures + import graphs beat full bodies
- Full code only for modules being moved
- Keep test output errors; crush pass spam

## Done when
Structure matches goal; tests pass; public behavior unchanged (or explicit breaks listed).
