# Skill: debug

## Trigger
fix, bug, broken, error, stacktrace, exception, crash, failing, not working, repro

## Purpose
Turn vague failure reports into a disciplined debug brief: reproduce → isolate → fix → verify.

## Required brief fields
- goal (what is broken + expected behavior)
- acceptance (repro passes / fails correctly)
- constraints (prod safety, no drive-by refactors)
- scope_in / scope_out

## Procedure (agent must follow)
1. Reproduce or state why repro is blocked
2. Isolate: file, function, input, recent change
3. Hypothesize 1–3 causes with evidence
4. Fix the root cause (minimal diff)
5. Verify with the failing path + adjacent regression check

## Anti-patterns
- Rewrite unrelated modules
- "Improve" code while debugging
- Silence errors without understanding
- Large refactors in the same PR as a hotfix

## Token hints
- Prefer stack traces + failing test output over whole log files
- Signatures-first on code; full file only for suspects
- Crush large JSON/log dumps; keep error lines always

## Done when
Failing path is fixed or root cause is documented with next step; no unexplained behavior change.
