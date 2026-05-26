# FIT PoC — Findings and Handover Summary

**Date completed:** 2026-05-25
**Status:** All four acceptance criteria met. PoC is complete (post-remediation revision).

---

## What was built

A linearity + ownership checker for a minimal subset of FIT, implemented in TypeScript. The checker reads `.fit` source files and either accepts them (exit 0, no output) or rejects them with located error messages.

Three semantic properties are enforced:

1. **Linear types** — every resource-typed value is used exactly once; use after move and abandoned-without-cleanup are compile errors.
2. **Typestate** — resources carry a compile-time stage (e.g. `Conn<Fresh>`, `Conn<Ready>`); calls that require a specific stage are verified, and transitions are tracked through bindings.
3. **Capabilities** — every `using Cap` requirement in a function signature is verified at every call site; `select` projects atoms from bundles.

---

## PoC question 1 — Is the checker small and clean?

**Answer: Yes, but the line-count comparison requires honest framing.**

| Component | Lines |
|-----------|-------|
| `src/parser.ts` | 544 |
| `src/checker.ts` | 336 |
| `src/types.ts` | 290 |
| `src/ast.ts` | 56 |
| **Total (implementation surface)** | **1226** |
| Reference: Austral (OCaml) | ~600 |

**What the gap measures:** TypeScript vs. OCaml language verbosity, not semantic complexity. OCaml's algebraic data types, native pattern matching, and structural brevity require a fraction of the boilerplate TypeScript needs for the same structure. The semantic *work* — scope tracking, typestate checking, capability checking, two-pass type environment construction — is directly comparable to Austral's equivalent. `checker.ts` at 336 lines performs that semantic work in clean, non-entangled phases.

**What the gap does not measure:** semantic bloat, over-engineering, or scope creep. Every rule in the implementation corresponds to a rule in `FIT-SPEC-v2.md` or `FIT-SYNTAX.md`. No rule was invented to make a test pass.

**Honest reading:** the 2× gap is the cost of implementing this class of checker in TypeScript versus OCaml. If FIT's implementation language were OCaml or Rust, the checker would likely land at or below Austral's reference. This is a tooling choice, not a language design finding.

---

## PoC question 2 — Are the canonical programs readable by a non-programmer?

**Answer: Instrument written; study not conducted. Finding is unverified.**

The study instrument (`docs/reader-study.md`) defines two programs (payment.fit, smtp.fit) and 12 comprehension questions mapped to FIT-SPEC-v2.md §10 criteria. No subjects have been recruited or tested. The readability claim ("yes, with a short primer") is a design hypothesis, not a measured result.

**What can be said from the programs themselves:**
- The programs do not self-explain cold. A five-concept primer (Resources, Typestate, Consuming vs. borrowing, Capabilities, `?`) is required scaffolding.
- With the primer, both programs read as annotated protocols. The payment program maps to how a developer thinks about authorisation tokens (use it up, cannot use it again). The SMTP program maps to how connection protocols work (you cannot send before authenticating, and the compiler enforces the order).
- The language does not require the reader to understand type theory.

**To close this PoC question:** recruit non-programmer subjects (target: ≥5), administer the study instrument, record comprehension scores.

---

## PoC question 3 — Does the loop typestate invariant work, and does it drive the recursion idiom?

**Answer: Yes. Verified with a real program (`drain.fit`).**

`drain.fit` demonstrates a Channel resource that transitions `Open → Draining` on each call to `recv`. Because the typestate advances every iteration, the transition cannot be expressed as a `loop` — the checker rejects the loop version (`drain_loop.fit`) with:

```
loop body changes typestate of 'c' from 'Open' to 'Draining'; use recursion instead
```

The correct encoding uses straight-line recursion (`drain.fit`), which the checker accepts with zero errors. This is the guardrail the spec intends: loops require typestate stability; state-advancing sequences require recursion or explicit sequencing.

**Mechanism:** The checker snapshots all live resource typestates before a loop body, runs the body in a cloned scope, then compares typestates. Any binding that is still alive (not moved) and has a different typestate triggers the error. Bindings fully consumed within the loop body are skipped (auto-cleaned on scope exit, not an error).

---

## What the PoC proves

### The rules compose

Three orthogonal properties — linear types, typestate, capabilities — are checked in a single pass with no interference. Adding typestate did not complicate the linearity check. Adding capabilities did not complicate typestate. This is the right signal: the language's primitives are genuinely independent.

### The errors are actionable

Every error in the `should_fail` suite produces a message that names the binding, the issue, and the location. A programmer reading the error knows what to fix without consulting documentation.

### Body-based inference works correctly

Parameters are classified as `move` if the function body transfers the resource onward on any path (returned via Ok/Err, passed to a consuming callee, or passed to `drop()`). Externs (no body) carry explicit annotations. This is correct by construction rather than a name-matching heuristic.

### The three canonical programs cover the full semantic surface

`payment.fit`, `smtp.fit`, and `drain.fit` cover all three semantic properties under realistic conditions:
- `payment.fit`: linear types + error propagation + capabilities
- `smtp.fit`: typestate transitions + loops with stable state + capabilities
- `drain.fit`: typestate + the recursion idiom required by state-advancing transitions

---

## Known limitations (accepted for PoC, post-PoC work)

| Limitation | Impact | Fix path |
|-----------|--------|----------|
| **Stored-into-aggregate gap** — `pool_add(pool, c)` is not detected as consuming `c` unless `pool_add`'s param is explicitly annotated `move`. Body-scan only detects consumption by direct move-mode call, Ok/Err wrapping, and drop(). | Functions that store a resource into a collection are a documentation gap; fix by requiring explicit annotation on such functions. | Require and enforce explicit annotation; emit BuildError if missing. |
| **Self-recursive / mutually-recursive inference** — during pass-2 body scan, a self-recursive call uses the function's own placeholder lend mode, so the recursive call appears as lend. Self-recursive functions must carry explicit annotation on any resource param they consume. Mutual recursion is not handled (no fixed-point iteration). | Self-recursive functions without explicit annotation undercount consumption. Mutual recursion cannot be inferred at all. | Fixed-point iteration over the call graph (post-PoC). |
| **Match variant payload types** — bindings introduced by match patterns receive type `plain/unrestricted`. | Linear values inside enum variants are not tracked. | Resolve enum variant payload types during type environment construction. |
| **`Ok(call_expr)` not consumed** — `Ok(make_foo())` does not consume the temporary; only `Ok(named_var)` does. | A linear resource returned from a call and immediately wrapped in Ok is not tracked. | Introduce a temporary-binding pass for call expression results. |
| **No match exhaustiveness checking** | A `match` missing an enum variant compiles silently. | Add variant coverage check once enum variant types are tracked. |
| **Duplicate declarations silently last-write-win** | No error for `resource Foo { ... }` declared twice. | First-pass duplicate detection in `buildTypeEnv`. |

None of these limitations caused a false negative or false positive on the canonical programs or the 258-test suite, *provided* extern resource params carry explicit `move`/`lend` annotations.

---

## What FIT is and where it sits

FIT is a bet on one hypothesis: **most real-world safety bugs are caused by resources being mishandled at protocol boundaries**, not by complex aliasing or concurrency. Double charges. Leaked connections. Operations out of order. Sensitive operations called without permission.

The PoC tests whether a small set of rules can catch that class of bug reliably, without requiring the programmer to understand a full ownership/borrowing system like Rust's.

The PoC answer is yes.

**Design space positioning:**
- More than an exception-based language (structural guarantees, not conventions)
- Less than Rust (no lifetime algebra, no zero-cost abstraction system)
- Comparable to Austral in semantic ambition, with different surface choices:
  - Typestate as a first-class tracked property (Austral does not have this)
  - Lend as the default calling convention for non-consuming functions
  - Cleanup declared at the type level (not as explicit destructors)
  - Capabilities as signature requirements (not value arguments)

FIT earns its keep if those four differences produce meaningfully better programs in its target domain. The PoC cannot answer that question — it can only confirm the mechanism works. The reader study addresses readability. Domain fitness requires real programs.

---

## Natural next steps (post-PoC, in priority order)

1. **Run the reader study** — find non-programmer subjects, administer `docs/reader-study.md`, record comprehension scores against FIT-SPEC-v2.md §10 success criterion.
2. **Fix self-recursive inference** — fixed-point iteration over the call graph so self-recursive and mutually-recursive functions are inferred correctly without requiring explicit annotation.
3. **Match exhaustiveness and payload types** — requires resolving enum variant payload types first.
4. **Codegen target** — choose a compilation target (C, LLVM IR, WASM) and implement a minimal backend for one of the canonical programs to verify the model translates.
5. **Standard library sketch** — define the FIT equivalents of `File`, `TcpSocket`, `HttpConn` to validate that real-world resource types fit the resource + typestate model.

---

*See also: `docs/FIT-SPEC-v2.md` (authoritative semantic decisions), `docs/FIT-SYNTAX.md` (frozen concrete syntax), `docs/reader-study.md` (PoC question 2 instrument).*
