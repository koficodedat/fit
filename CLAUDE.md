# CLAUDE.md — FIT PoC Build Handoff

**You are implementing a viability test, not a language.**
Read this entire document before writing any code. The spec and syntax reference are the
source of truth. Do not invent, extend, or improve anything not listed here — scope creep
is the primary failure mode.

---

## What you are building

A **linearity + ownership checker** for a minimal subset of FIT, implemented in
**TypeScript**. The checker reads FIT source files and either accepts them (prints nothing)
or rejects them with a clear, located error message. No codegen. No runtime. No interpreter.

The checker is the answer to **PoC question 1**: is it small and clean?
Austral's equivalent checker is ~600 lines. That is the reference. If FIT's grows
significantly beyond that, flag it — that is a finding, not a problem to engineer around.

---

## Reference documents

| Document | Purpose |
|----------|---------|
| `FIT-SPEC-v2.md` | Authoritative semantic decisions. When in doubt, this wins. |
| `FIT-SYNTAX.md` | Frozen concrete syntax. Implement exactly this, nothing more. |
| `CLAUDE.md` | This file. Build instructions and escalation rules. |

---

## Repository layout

```
/
├── CLAUDE.md
├── FIT-SPEC-v2.md
├── FIT-SYNTAX.md
├── src/
│   ├── parser.ts       // hand-written recursive descent; produces AST
│   ├── ast.ts          // AST type definitions
│   ├── checker.ts      // linearity + ownership + capability checker
│   ├── types.ts        // FIT type representations
│   └── main.ts         // CLI entry: fit check <file>
├── tests/
│   ├── payment.fit     // canonical test program 1 (from FIT-SYNTAX.md §10)
│   ├── smtp.fit        // canonical test program 2 (from FIT-SYNTAX.md §10)
│   ├── should_pass/    // programs the checker must accept
│   └── should_fail/    // programs the checker must reject with correct errors
├── package.json
└── tsconfig.json
```

---

## Build order

Work strictly in this order. Do not start step N+1 until step N passes its tests.

### Step 1 — AST and parser
Parse the syntax from FIT-SYNTAX.md into an AST. Cover:
- `record`, `enum`, `resource` declarations
- `type` union aliases
- `fn` signatures (params, return type, `using` clause)
- `fn` bodies: `let`, `let mut`, rebind, `match`, `loop`, `if/else`, `?`, `drop`, `select`
- `Ok(...)`, `Err(...)`, `Result<T,E>`

The parser does not need to be production quality. Panicking on malformed input is
acceptable for the PoC. The two canonical programs in FIT-SYNTAX.md §10 must parse
without error.

### Step 2 — Type representation
Represent FIT's type system:
- Memory modes: `Unrestricted | Affine | Linear`
- Resource types with optional typestate parameter
- Inferred `Lend | Move` per function parameter (computed from body, frozen)
- Capability sets on functions
- Result types and error union aliases

### Step 3 — Linearity checker
This is the core of the PoC. Check:

1. **Linear values used exactly once.** After a move, the binding is unavailable. Any
   subsequent use is an error: `"value 'conn' has already been moved"`.

2. **Lend-vs-move inference.** For each function, compute whether each parameter is lent
   or consumed, per the rule in FIT-SYNTAX.md §3.5. Freeze this as part of the function's
   type. Changing a body in a way that flips lend→move is an error at the signature
   boundary (for the PoC, flag this as a warning — full enforcement is post-PoC).

3. **Cleanup fires for still-owned values.** On every exit path from a scope — normal
   return, early `?` return, `break` — any linear value still owned must have its cleanup
   recorded as firing. The checker does not execute cleanup; it verifies no linear value
   escapes a scope unaccounted for.

4. **Move-skips-cleanup.** A value that has been moved out does not fire cleanup at the
   enclosing scope exit.

5. **Typestate transitions.** A function call that consumes `Conn<Fresh>` and returns
   `Conn<Ready>` must be reflected in the binding's type after the call. Calls that require
   a specific typestate variant must verify the binding is in that state.

6. **Loop typestate invariant.** A `loop` body that would change any binding's typestate
   is a compile error: `"loop body changes typestate of 'c' from Ready to Closing; use
   recursion instead"`.

7. **Linear values in branches.** A linear value live at an `if` or `match` must be
   consumed on every branch. Missing consumption on any branch is an error.

### Step 4 — Capability checker
Check:
1. Every `using Cap` requirement in a function signature is satisfied at each call site.
2. Strict resolution: exactly one capability of each required type in scope, or error.
3. `select Read from Fs` produces `Read` in scope; `Fs` is not consumed (capabilities are
   unrestricted unless declared linear).
4. A function with no `using` clause provably cannot call any function that has one.

### Step 5 — Test suite
Write `should_pass` and `should_fail` test cases covering at minimum:

**Should pass:**
- `payment.fit` and `smtp.fit` (the canonical programs — these are the primary success criteria)
- A function that lends a resource and the caller uses it after
- Straight-line typestate transitions
- Plain loop with no typestate change
- Error propagation with `?` triggering cleanup of owned values

**Should fail:**
- Use of a linear value after move
- Use of a linear value after `?` return on error path
- Loop that crosses a typestate boundary
- Missing capability at call site
- Linear value not consumed on one branch of a `match`
- Calling a function requiring `Conn<Ready>` when binding is `Conn<Fresh>`

---

## Acceptance criteria

The PoC is complete when:

1. `payment.fit` and `smtp.fit` both pass the checker with no errors.
2. All `should_fail` cases produce the correct, located error message.
3. The checker implementation (parser + checker, excluding tests and types) is measured
   and recorded — this is the line-count answer to PoC question 1.
4. The two canonical programs are readable by a non-programmer — print them formatted
   for the reader study (PoC question 2).

### PoC status: mechanism complete; viability questions partially answered (2026-05-25)

- **Q1 (small/clean checker):** answered on structure — 8 enforced rules, 3 orthogonal properties. Cleanup firing not statically verified (runtime/codegen concern, out of PoC scope).
- **Q2 (no-sigil readability):** ⚠️ **unverified** — `docs/reader-study.md` instrument written; study not yet conducted.
- **Q3 (typestate/recursion guardrail):** answered — `drain.fit` exercises the recursion idiom; `drain_loop.fit` is correctly rejected.

**Test suite:** 292 tests across 7 suites (unit, integration, edge cases, should_pass/should_fail, § error-type compatibility), all passing.
**Canonical programs:** `payment.fit`, `smtp.fit`, `drain.fit` — all pass, 0 errors.
**Line count:** parser: 544 · checker: 336 · types: 290 · ast: 56 · **total: 1226** (2× Austral reflects TypeScript vs. OCaml verbosity; see `docs/poc-findings.md`).

See `docs/poc-findings.md` for the full assessment.

**Test suite:** 292 tests across 7 suites (unit, integration, edge cases, should_pass/should_fail, § error-type compatibility).

**Post-remediation changes (2026-05-25):**
- Replaced return-type name-matching heuristic with body-based move inference (spec §4)
- Added explicit `move`/`lend` annotations to all extern resource params across all `.fit` files
- Added `drain.fit` (third canonical program) + `drain_loop.fit` (should_fail, loop-typestate)
- Added `BuildError` for extern resource params missing annotation
- Corrected Q1/Q2/Q3 findings in `docs/poc-findings.md`
- Added §4 extern annotation rule to `docs/FIT-SPEC-v2.md`

---

## Escalation rules

**Make a local call (do not escalate) for:**
- Parser implementation details
- TypeScript data structure choices
- Test case wording
- File layout within the above structure

**Escalate to the design session (stop and flag) if:**
- The checker requires a rule not present in FIT-SPEC-v2.md or FIT-SYNTAX.md
- The lend-vs-move inference produces ambiguous results on a real program
- The line count is tracking significantly above 600 lines before Step 4 is complete
- A `should_fail` case cannot be rejected without adding a new semantic rule
- Anything in the canonical test programs appears unsound or requires syntax not in
  FIT-SYNTAX.md

Do not invent a solution to an escalation-worthy problem. Flag it and stop.

---

## What is explicitly out of scope

Do not implement, design, or prototype any of the following:

- Codegen or a runtime
- A full type inference engine
- Generics beyond single typestate parameter `<S>`
- Closures or higher-order functions
- Modules or visibility
- Method-call sugar
- Async or concurrency
- Two-phase cleanup / `fallback-preferred` warning
- Error union implicit widening (use explicit union types in test programs)
- Linear collections (List<T> where T is linear)
- Regions

If a test program requires one of these, the test program is wrong — escalate rather
than implement.

---

## Tone note

The PoC has kill criteria (FIT-SPEC-v2.md §10). If the checker is ballooning, or a rule
keeps requiring patches to work, say so directly. "FIT doesn't earn its keep" is a valid
finding. An honest small failure is more valuable than a large success built on scope creep.

*End of CLAUDE.md*
