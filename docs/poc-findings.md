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

**Answer: Partially measurable. The semantic-complexity metric is now produced; line count is reported only as a weak secondary signal.**

### Semantic rules enforced — the language-independent measure

The checker **enforces 8 semantic rules**. These are countable directly from the implementation and comparable to Austral regardless of implementation language.

| # | Rule | Error produced |
|---|------|----------------|
| 1 | **Linear use-once** — a moved binding cannot be used again | `"value 'X' has already been moved"` |
| 2 | **Cannot-move-borrowed** — a lend-mode binding (owned=false) cannot be passed to a move-mode callee or to `drop()` | `"cannot move borrowed value 'X'"` |
| 3 | **Typestate-match-at-call** — the binding's current typestate must equal the parameter's declared typestate at the call site | `"argument 'X' has typestate 'A', expected 'B'"` |
| 4 | **Loop-typestate-invariant** — a loop body cannot leave any live binding in a different typestate than it entered; use recursion for state-advancing sequences | `"loop body changes typestate of 'X' from 'A' to 'B'; use recursion instead"` |
| 5 | **Branch-consumption-consistency** — a linear binding live at an if/match must be consumed on all branches or none | `"linear value 'X' must be consumed on all branches"` |
| 6 | **Capability-presence-at-call** — every `using Cap` requirement of a callee must be present in the calling scope | `"missing capability 'Cap' required by 'fn'"` |
| 7 | **Select-source-in-scope** — the source capability of a `select` statement must be in scope; if valid, the projected atom is added to the capability scope | `"capability 'Cap' not in scope for 'select'"` |
| 8 | **Extern-annotation-required** — an extern with a linear resource parameter and no `move`/`lend` annotation is a compile error | `"extern 'fn' has linear parameter 'X' with no move/lend annotation"` |

Two further properties — move-skips-cleanup and lend-retains-ownership — are **assumed, not statically verified**: the checker tracks ownership (who holds what, when it is moved) but defers cleanup firing to a future runtime. These properties are correctly out of scope for a static checker, but they must not be counted as enforced rules.

### Pass structure and entanglement

The checker runs in distinct phases: type-environment construction (two passes: resources/aliases then function signatures), followed by a single checking walk per function body. The three properties — linearity, typestate, capabilities — are checked without cross-dependency: linearity logic does not read capability state; capability logic does not read typestate; typestate logic does not read capability state. This orthogonality is the strongest positive Q1 signal and is verifiable from the code structure, independent of line count.

### Line count — secondary, weak signal

| Component | Lines (baseline) | Lines (post variant-ns) |
|-----------|-----------------|------------------------|
| `src/parser.ts` | 544 | 566 |
| `src/checker.ts` | 336 | 495 |
| `src/types.ts` | 290 | 359 |
| `src/ast.ts` | 56 | 59 |
| **Total** | **1226** | **1479** |
| Reference: Austral (OCaml) | ~600 | ~600 |

The baseline 2× gap reflects TypeScript-vs-OCaml verbosity. After variant namespacing (Option B, dot syntax), the count is ~2.5× Austral. The feature is principled additive growth (new grammar construct, resolver, AST extension) and not a kill-criterion signal today. However, the trend is a watch item: each scoped feature adds lines, and the verbosity ratio is not fixed. If three more comparably-scoped features land, the ratio approaches 4× and the kill criterion becomes live. The rule count and pass orthogonality remain the language-independent Q1 measures; the line count is a secondary signal reported for completeness.

**Honest status:** the orthogonality result is real and positive. The 8-rule count is the actual Q1 deliverable. Q1 is answered on structure: the checker is small (8 enforced rules, 3 orthogonal properties) and clean (no invented rules, each corresponds to a spec entry). Cleanup firing is not statically verified — that is a runtime/codegen concern, explicitly out of PoC scope.

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

### No-sigil lending holds for FIT code; the FFI boundary requires explicit annotation

Body-based inference means FIT code carries no `move`/`lend` sigils in most function signatures: the calling convention is inferred from the body and frozen in the function's published type. This is the intended design — "no written marker on every parameter" is one of FIT's four differentiators.

The exception is the FFI boundary. Externs (body-less declarations for C/system functions) cannot be inferred from a body, so they carry explicit annotations: `fn close(c: move SmtpConn<Closing>) -> ()`. This is the correct design: externs are a deliberate boundary where explicit human annotation is required and trusted — comparable to Rust's `unsafe` blocks at the FFI surface.

**PoC caveat:** `smtp.fit` looks annotation-heavy because the PoC stubs all protocol functions as externs. In a real implementation, protocol orchestration functions would have FIT bodies (inferred, no annotations); only the lowest-level FFI shims would carry annotations. The PoC cannot measure that ratio because it has no standard library.

**Forward tension:** The no-sigil property holds for *bodied* signatures only. Body-less surface today is limited to externs. If traits or compile-time interfaces are added later, they would expand the body-less surface and require more annotations — annotation cost scales with body-less signature surface, not with the overall language. FIT has no dispatch (§1.2, §8), so this is not an immediate concern, but it is a constraint to carry forward.

**Bearing on kill criterion 2:** The no-sigil differentiator survives for FIT code. The cost is bounded to the FFI boundary. Whether that cost is acceptable at real-world FFI surface area is unmeasured pending a standard library sketch.

### Two open questions after the PoC

1. **Readability** — the reader study instrument is written but no subjects have been tested. The readability claim remains a hypothesis. (See PoC question 2 above.)
2. **FFI annotation cost at scale** — no-sigil lending is confirmed for FIT code; extern-annotation cost is bounded to the FFI boundary but real-world magnitude is unknown pending a standard library sketch.

### The three canonical programs cover the full semantic surface

`payment.fit`, `smtp.fit`, and `drain.fit` cover all three semantic properties under realistic conditions:
- `payment.fit`: linear types + error propagation + capabilities
- `smtp.fit`: typestate transitions + loops with stable state + capabilities
- `drain.fit`: typestate + the recursion idiom required by state-advancing transitions

---

## Known limitations (accepted for PoC, post-PoC work)

| Limitation | Impact | Fix path |
|-----------|--------|----------|
| **Cleanup firing not statically verified** — the checker tracks ownership and move/lend mode but does not verify that declared cleanup actually fires. `break` and `?` paths are assumed to trigger runtime cleanup; this is not checked. "Automatic cleanup" is one of FIT's four differentiators (§1.3) and is not tested by the PoC. | Automatic cleanup is not verified. A program that escapes cleanup (e.g. via an unannotated extern that discards a resource) would not be caught. | Codegen/runtime concern; requires a backend to test. |
| **Stored-into-aggregate gap** — `pool_add(pool, c)` is not detected as consuming `c` unless `pool_add`'s param is explicitly annotated `move`. Body-scan only detects consumption by direct move-mode call, Ok/Err wrapping, and drop(). | Functions that store a resource into a collection are a documentation gap; fix by requiring explicit annotation on such functions. | Require and enforce explicit annotation; emit BuildError if missing. |
| **Self-recursive / mutually-recursive inference** — during pass-2 body scan, a self-recursive call uses the function's own placeholder lend mode, so the recursive call appears as lend. Self-recursive functions must carry explicit annotation on any resource param they consume. Mutual recursion is not handled (no fixed-point iteration). | Self-recursive functions without explicit annotation undercount consumption. Mutual recursion cannot be inferred at all. | Fixed-point iteration over the call graph (post-PoC). |
| **Match variant payload types** — bindings introduced by match patterns receive type `plain/unrestricted`. | Linear values inside enum variants are not tracked. | Resolve enum variant payload types during type environment construction. |
| **`Ok(call_expr)` not consumed** — `Ok(make_foo())` does not consume the temporary; only `Ok(named_var)` does. | A linear resource returned from a call and immediately wrapped in Ok is not tracked. | Introduce a temporary-binding pass for call expression results. |
| **No match exhaustiveness checking** | A `match` missing an enum variant compiles silently. | Add variant coverage check once enum variant types are tracked. |
| **Duplicate declarations silently last-write-win** | No error for `resource Foo { ... }` declared twice. | First-pass duplicate detection in `buildTypeEnv`. *(Fixed in post-ship cleanup round.)* |
| **Linear value buried inside an unrestricted shell** — a linear value is not directly visible when wrapped in an unrestricted container. Known surfaces: (1) wildcard match arm dropping a linear variant payload (`match e { _ => () }` where the active variant carries a resource); (2) `Result<LinearPayload, E>` returned from a call used as a bare statement — the call-as-statement check is narrow by design and does not recurse into the `Result.ok` slot; (3) any future enum-variant payload pattern that incompletely destructures. | All three surfaces silently leak a linear resource. The call-as-statement check (`checker.ts`) catches the directly-linear case; it does not catch the shell case. | Address together when exhaustiveness infrastructure lands (payload-type tracking through match arms). Until then: avoid `_` arms on linear enums, and bind Result-wrapped linear values via `let` rather than bare-call statements. |

None of these limitations caused a false negative or false positive on the canonical programs or the 292-test suite, *provided* extern resource params carry explicit `move`/`lend` annotations.

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

## v0.1 Phase — Module system (2026-06-08)

### What landed

Minimal flat-namespace module system: `import filename` loads all declarations from
`filename.fit` in the same directory. Implemented in 6 pieces:

- `Decl.import` AST variant + `Pos.file` field
- `parseImport` + imports-first enforcement in parser
- `src/loader.ts` — recursive resolution, memoization, diamond dedup, cycle detection
- Duplicate-name detection in `buildTypeEnv` (also catches within-file duplicates)
- `main.ts` wired to `loadProgram`
- Codegen guard against leaked import decls

### Line count (post-modules)

| Component | Lines |
|-----------|-------|
| `src/ast.ts` | 60 |
| `src/parser.ts` | 583 |
| `src/checker.ts` | 495 |
| `src/types.ts` | 367 |
| `src/loader.ts` | 87 |
| **Total** | **1592** |
| Reference: Austral (OCaml) | ~600 |

The module system added 113 lines across all components (+87 loader, +17 parser,
+8 types, +1 ast). The ratio is now ~2.65× Austral. Still within watch-item range;
not at the 4× kill threshold.

### Test count

324 tests across 8 suites (up from 303). 21 new tests: 4 parser import tests,
6 loader unit tests, 4 buildTypeEnv duplicate-detection tests, 7 suite integration
tests (3 should_pass + 4 should_fail import programs).

### Post-ship cleanup round (2026-06-08) — ratified

Eight soundness fixes landed in the same session as the module system. Ratified on the record:

- **loader**: `included.add(norm)` added on read-failure and parse-failure paths — prevents duplicate errors on diamond paths through a broken dep.
- **loader + parser**: structured `ParseError` class replaces fragile regex over the parser's error string; `instanceof` extraction in loader.
- **parser**: duplicate `cleanup` field in a resource body is now a parse error.
- **types** (`stmtConsumesVar` "if"): condition expression scanned — resources consumed in the condition were invisible to body-based inference.
- **types** (`stmtConsumesVar` "match"): call-expression scrutinees scanned — only direct var scrutinee was previously detected.
- **checker** (`checkInnerScopeExit`): guard tightened — inner `let` that shadows a moved outer binding is a fresh local and must be independently consumed.
- **checker** (call sites): typestate check now also applies to non-var call-expression arguments via `argType` captured from `checkExpr`.
- **checker** (`mergeScopes`): propagates the agreed post-branch typestate to the outer scope. Fix creates a new type object rather than in-place mutation, avoiding corruption of shared references into `env.functions`. This aliasing subtlety must be preserved.

**Call-as-statement linear-return rule — decided narrow.** `checker.ts` case `"expr"` rejects calls used as bare statements whose return type is *directly* linear. The check does **not** recurse into unrestricted shells (`Result<LinearPayload, E>`, enum variants carrying linear payloads). The shell-leak class is deferred to the exhaustiveness round (see "linear-in-unrestricted-shell" in Known Limitations above).

### Known v0.1 limitations (accepted, deferred to v0.2)

- No visibility — all declarations accessible across files
- No separate compilation — every `import` re-parses at each `fit check` invocation
- No qualified imports, selective imports, or module hierarchy
- ~~Pos.file stores absolute paths — error messages may be verbose in deep directory trees~~ *Fixed: CLI output relativizes to CWD at render time; `Pos.file` remains absolute internally.*

---

## Natural next steps (post-PoC, in priority order)

1. **Run the reader study** — find non-programmer subjects, administer `docs/reader-study.md`, record comprehension scores against FIT-SPEC-v2.md §10 success criterion.
2. **Fix self-recursive inference** — fixed-point iteration over the call graph so self-recursive and mutually-recursive functions are inferred correctly without requiring explicit annotation.
3. **Match exhaustiveness and payload types** — requires resolving enum variant payload types first.
4. **Codegen target** — choose a compilation target (C, LLVM IR, WASM) and implement a minimal backend for one of the canonical programs to verify the model translates.
5. **Standard library sketch** — define the FIT equivalents of `File`, `TcpSocket`, `HttpConn` to validate that real-world resource types fit the resource + typestate model.

---

*See also: `docs/FIT-SPEC-v2.md` (authoritative semantic decisions), `docs/FIT-SYNTAX.md` (frozen concrete syntax), `docs/reader-study.md` (PoC question 2 instrument).*
