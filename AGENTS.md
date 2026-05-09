- use `pnpm` as a package manager
- use `bun` to run typescript files, especially on the CLI during investigatory sampling
  - check types with `bunx tsc`

We are seeking mathematical rigor, correctness, beauty, and elegance in our design. NEVER support backwards compatibility, or deprecating code. This project is experimental and fluid--always delete old code, always take the elegant path even if it means extra effort and/or refactoring.

If you catch yourself saying, "But this is a bigger refactor" and dismiss an instruction, or "Let me be pragmatic..." and then simplify or ignore part of the plan, re-read the plan. Follow the instructions. Big refactors are ok. Pragmatism does not trump elegance.

If you notice a "pre-existing" problem or error that has nothing to do with the current plan, FIX IT! You are fully responsible for the code health of the entire project. If something was "missed" in the last run, it doesn't matter that it is now pre-existing: it's up to you to bring it up for discussion, build it correctly, or fix it.

Do NOT use non-null assertions, even in tests.

