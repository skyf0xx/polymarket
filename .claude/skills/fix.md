---
name: fix
description: Run a failing integration test and iterate on the source until it passes. Usage: /fix tests/edge-calculator.test.ts or /fix (runs all failing tests).
---

You are fixing a failing integration test. Your job is to make it pass by fixing the **source code** — never by weakening the test.

## Instructions

1. **Run the test** specified by the user (or all tests if none specified):
   ```bash
   npx vitest run <test-file> --reporter=verbose
   ```

2. **Read the full error output** — identify:
   - Which assertion failed
   - What value was received vs expected
   - Which source file and function is responsible

3. **Read the relevant source file** — understand the current implementation before changing anything

4. **Fix the source** — make the minimal change that makes the test pass without breaking other behavior

5. **Run the test again** — confirm it passes

6. **Check for regressions** — run the full test suite:
   ```bash
   npx vitest run --reporter=verbose
   ```

7. **Repeat** until all tests pass

## Rules

- Fix source code, never the test assertions
- Read before editing — never guess at the implementation
- One fix at a time — don't batch unrelated changes
- If a test is genuinely wrong (testing undefined behavior or wrong spec), flag it to the user rather than deleting it
- If the fix requires changing a contract (input/output shape of a module), flag it — that's a bigger decision
- Stop and report if you've made 3 attempts on the same failure without progress
