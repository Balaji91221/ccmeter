# Skill: revamp

## Trigger
revamp, redesign, re-architecture, folder structure, project structure, overhaul, reorganize entire

## Purpose
Produce a deliberate redesign plan (and optional phased implementation). Stop undirected "update the plan" loops.

## Required brief fields
- goal (target state)
- scope_in / scope_out
- acceptance (plan completeness or implement milestones)
- deliverables (tree, migration, risks)

## Procedure
1. Explore: current map (modules, owners, entrypoints)
2. Design: target architecture + boundaries
3. Plan: migration phases, risks, rollback
4. Implement only if explicitly in scope (else stop at plan)
5. Verify plan against acceptance

## Anti-patterns
- "Continue" without acceptance criteria
- Rewriting everything in one session
- Plan that ignores migration / rollback
- Implementing before map + target agree

## Token hints
- Directory trees + READMEs first
- Full files only for hot modules listed in map
- Never keep multi-MB tool dumps across stages — pass `map` / `plan` packets only

## Done when
Deliverables exist and acceptance criteria are checkable; if implement was in scope, milestones verified.
