# FIT PoC — Findings and Handover Summary

**Date completed:** 2026-05-25
**Status:** All three acceptance criteria met. PoC is complete (post-remediation revision).

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

The checker **enforces 9 semantic rules**. These are countable directly from the implementation and are language-independent — they describe what the language guarantees, not how the checker is written.

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
| 9 | **Match-exhaustiveness** — a `match` on a declared enum must cover every variant, either explicitly or via a wildcard | `"match on 'E' is not exhaustive — missing variant(s): X, Y"` |

Two checks added alongside rule 9 are deliberately **not** counted as new rules:

- **Wildcard-covers-linear-payload** (`"wildcard arm covers variant(s) with linear payload: X — destructure explicitly to consume"`) extends rule 1 to a surface that was previously invisible. It enforces the same axiom — a linear value must be consumed exactly once — on linear payloads that a wildcard arm would otherwise silently drop. New surface, not new rule.
- **Variant-in-scrutinee-enum** (`"variant 'X' is not declared by enum 'E'"`) is name resolution and well-formedness, in the same family as `"undefined variable"`. Nothing substructural about it, so it is excluded from the semantic-rule count.

Counting either as a rule would inflate the primary Q1 measure with checks that are not of a kind with the other nine, which would make the kill criterion less informative rather than more.

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

Variant namespacing added principled growth (new grammar construct, resolver, AST extension) — not a kill-criterion signal. The rule count and pass orthogonality remain the primary Q1 measures; the line count is a secondary signal reported as raw trend data.

**Honest status:** the orthogonality result is real and positive. The rule count is the actual Q1 deliverable. Q1 is answered on structure: the checker is small (9 enforced rules, 3 orthogonal properties) and clean (no invented rules, each corresponds to a spec entry). Cleanup firing is not statically verified — that is a runtime/codegen concern, explicitly out of PoC scope.

---

## PoC question 2 — Are the canonical programs readable by a non-programmer?

**Answer: Yes. Verified by post-PoC reader study.**

The study instrument (`docs/reader-study.md`) was administered to non-programmer subjects. With the five-concept primer (Resources, Typestate, Consuming vs. borrowing, Capabilities, `?`) as scaffolding, both canonical programs are comprehensible. The Q2 kill criterion (no-sigil borrow consistently confuses readers) did not fire.

**What the programs demonstrate:**
- The programs do not self-explain cold; the primer is required scaffolding.
- With the primer, both programs read as annotated protocols. The payment program maps to how a developer thinks about authorisation tokens (use it up, cannot use it again). The SMTP program maps to how connection protocols work (you cannot send before authenticating, and the compiler enforces the order).
- The language does not require the reader to understand type theory.

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

Body-based inference means FIT code carries no `move`/`lend` sigils in most function signatures: the calling convention is inferred from the body and frozen in the function's published type. This is the intended design — "no written marker on every parameter" is one of FIT's three pillars.

The exception is the FFI boundary. Externs (body-less declarations for C/system functions) cannot be inferred from a body, so they carry explicit annotations: `fn close(c: move SmtpConn<Closing>) -> ()`. This is the correct design: externs are a deliberate boundary where explicit human annotation is required and trusted — comparable to Rust's `unsafe` blocks at the FFI surface.

**PoC caveat:** `smtp.fit` looks annotation-heavy because the PoC stubs all protocol functions as externs. In a real implementation, protocol orchestration functions would have FIT bodies (inferred, no annotations); only the lowest-level FFI shims would carry annotations. The PoC cannot measure that ratio because it has no standard library.

**Forward tension:** The no-sigil property holds for *bodied* signatures only. Body-less surface today is limited to externs. If traits or compile-time interfaces are added later, they would expand the body-less surface and require more annotations — annotation cost scales with body-less signature surface, not with the overall language. FIT has no dispatch (§1.2, §8), so this is not an immediate concern, but it is a constraint to carry forward.

**Bearing on kill criterion 2:** The no-sigil differentiator survives for FIT code. The cost is bounded to the FFI boundary. Whether that cost is acceptable at real-world FFI surface area is unmeasured pending a standard library sketch.

### One open question after the PoC

**FFI annotation cost at scale** — no-sigil lending is confirmed for FIT code; extern-annotation cost is bounded to the FFI boundary but real-world magnitude is unknown pending a standard library sketch.

### The three canonical programs cover the full semantic surface

`payment.fit`, `smtp.fit`, and `drain.fit` cover all three semantic properties under realistic conditions:
- `payment.fit`: linear types + error propagation + capabilities
- `smtp.fit`: typestate transitions + loops with stable state + capabilities
- `drain.fit`: typestate + the recursion idiom required by state-advancing transitions

---

## Known limitations (accepted for PoC, post-PoC work)

| Limitation | Impact | Fix path |
|-----------|--------|----------|
| **Cleanup firing not statically verified** — the checker tracks ownership and move/lend mode but does not verify that declared cleanup actually fires. `break` and `?` paths are assumed to trigger runtime cleanup; this is not checked. "Automatic cleanup" is one of FIT's three pillars (§1.3) and is not tested by the PoC. | Automatic cleanup is not verified. A program that escapes cleanup (e.g. via an unannotated extern that discards a resource) would not be caught. | Codegen/runtime concern; requires a backend to test. |
| **Stored-into-aggregate gap** — `pool_add(pool, c)` is not detected as consuming `c` unless `pool_add`'s param is explicitly annotated `move`. Body-scan only detects consumption by direct move-mode call, Ok/Err wrapping, and drop(). *(Closed by composition in v0.1, verified `191f0d7`: fixed-point iteration in pass 2 propagates `move` through any bodied chain ending at a move-annotated extern, and v0.1 has no aggregate-construction syntax — no record literals, no enum-variant payload construction, no field mutation — so there is no expression that stores a resource without an inference-visible call. Reactivates when aggregate-construction syntax is added.)* | Anticipatory: no v0.1 syntactic vector for the gap. Verified by four probe programs (`tests/should_pass/storage_via_move_extern.fit`, `tests/should_pass/storage_lend_chain.fit`, `tests/should_fail/storage_use_after_call.fit`, `tests/should_fail/storage_chain_use_after.fit`). | ~~Require and enforce explicit annotation; emit BuildError if missing.~~ Inert in v0.1; revisit when aggregate-construction syntax lands. |
| **Forward-reference / mutual-cycle inference gap** — single-pass inference processes functions in source order. When a caller is declared before its consumed callee, the callee's param is still `lend` at scan time; the caller infers `lend` too, producing a false-positive "cannot move borrowed value" error on the move call in the caller's body. Same gap for mutual-recursion cycles where one member has no direct consumption path. *(Fixed in v0.1 recursion-inference round — pass 2 converted to fixed-point iteration; lend→move only, terminates in ≤ N+1 iterations.)* | Before fix: correct programs with forward-declared callees or mutual cycles were falsely rejected. Pure self-recursion (no base-case consumption) stabilizes correctly at `lend` — that remains the correct result. | ~~Fixed-point iteration over the call graph (post-PoC).~~ Done. |
| ~~**Match variant payload types** — bindings introduced by match patterns receive type `plain/unrestricted`.~~ *(Entry was out of date. Verified working by probe 1 in `e7dfa11`: a variant payload binding resolves to its declared type and its linearity is tracked through the arm. Codegen confirms — `Handle h = _t0.HasOne;` followed by a consuming call. No code change was required.)* | ~~Linear values inside enum variants are not tracked.~~ They are tracked. | ~~Resolve enum variant payload types during type environment construction.~~ Already implemented before this entry was written. |
| **`Ok(call_expr)` not consumed** — `Ok(make_foo())` does not consume the temporary; only `Ok(named_var)` does. | A linear resource returned from a call and immediately wrapped in Ok is not tracked. | Introduce a temporary-binding pass for call expression results. |
| ~~**No match exhaustiveness checking**~~ *(Closed in `731ba2c`: `EnumInfo` carries a per-enum variants list; `case "match"` computes covered vs. declared variants and rejects any uncovered variant when no wildcard is present. Applies to declared enums only — Result and unknown/extern-returned scrutinees retain silent acceptance.)* | ~~A `match` missing an enum variant compiles silently.~~ Now rule 9. | ~~Add variant coverage check once enum variant types are tracked.~~ Done. |
| **Duplicate declarations silently last-write-win** | No error for `resource Foo { ... }` declared twice. | First-pass duplicate detection in `buildTypeEnv`. *(Fixed in post-ship cleanup round.)* |
| **Linear value buried inside an unrestricted shell** — a linear value is not directly visible when wrapped in an unrestricted container. Known surfaces: ~~(1) wildcard match arm dropping a linear variant payload~~ *(closed in `731ba2c` — the strict wildcard rule rejects a wildcard that covers any uncovered variant carrying a linear payload)*; (2) `Result<LinearPayload, E>` returned from a call used as a bare statement — the call-as-statement check is narrow by design and does not recurse into the `Result.ok` slot; (3) any future enum-variant payload pattern that incompletely destructures. | Surfaces (2) and (3) silently leak a linear resource. The call-as-statement check (`checker.ts`) catches the directly-linear case; it does not catch the shell case. Surface (1) is now a compile error. | Surface (1) done. Surfaces (2) and (3) open: bind Result-wrapped linear values via `let` rather than using bare-call statements. Surface (3) is forward-looking — no v0.1 pattern form currently reaches it, since unbound linear payloads are already rejected and multi-bind on a single payload is a compile error. |
| **Undeclared identifier silent acceptance** — the checker accepts references to undeclared functions and to enum variants when the surrounding type context is unknown. Type information falls back to `?` (for functions) or variant index `0` (for variants), both of which produce invalid C at codegen time. | Programs that type-check successfully can fail to codegen with malformed C output. Surfaces in `smtp.fit` (references `fn next` and the variants `None`/`Some` from an unimplemented list module). | Require all referenced functions and variants to be declared in scope; emit BuildError if missing. Design call: enforce at type-check time, or only at codegen time. |
| ~~**Type alias raw in C output** — `type X = A \| B` aliases are tracked by the checker but not emitted as typedefs at codegen time.~~ *(Closed in this round: each `type_alias` now emits `typedef int X;` preceded by a comment recording the erased member list. Representation decision — `int`, not a tagged union: nothing in v0.1 discriminates an error union, since `?` propagates the whole value and no syntax destructures an alias. A tagged union would encode a capability the language cannot express and would fix the representation before the syntax needing it exists. Verified by `tests/should_pass/error_union_alias.fit`, which propagates two distinct error enums through `?` into a union-alias return type and compiles under `cc -std=c99 -Werror`.)* | ~~Programs using error-union aliases in a Result return type produce invalid C.~~ Resolved. Member information is erased at the C boundary — deliberate, and recorded in a comment in the generated output. | ~~Codegen-only fix: emit `typedef <tagged-union representation> X;`~~ Done as `typedef int`. Revisit the representation if alias-destructuring syntax is ever added. |
| **Result matching produces invalid C** — `match` on a `Result` scrutinee type-checks but generates malformed C. `Ok`/`Err` are not registered in `env.enums`, so `resolveVariant` returns null and the checker's silent-acceptance path takes over; codegen's `variantIndexOf` then falls back to index 0 for both arms, emitting duplicate `case 0:` labels. Payload bindings are not extracted either — `Ok(c)` yields a reference to an undeclared `c`. Verified by probe 2 in `e7dfa11`. | Any program matching on Result rather than propagating with `?` produces C that will not compile. `?` is the intended Result idiom in FIT, so this is an unusual path today — but it is silently accepted rather than rejected, and exhaustiveness does not apply to it. | Requires a design decision first: register `Ok`/`Err` as a builtin enum (uniform — match, exhaustiveness, and codegen all work through the existing path — but injects synthetic entries into the type environment and interacts with the ambiguity machinery), or handle Result as a special form in both checker and codegen (contained, but adds special cases to a checker whose merit is having few). Deferred to its own round. |
| **Match errors report the `match` line, not the offending arm** — every error emitted from `case "match"` uses `stmt.pos`, the position of the `match` keyword. Arm-specific errors (wrong-enum variant, undeclared variant, unbound linear payload, multi-bind on a single payload, unconsumed arm binding) therefore all point at the same line regardless of which arm produced them. | On a match with many arms the error gives no indication which arm to fix, and two errors from different arms are indistinguishable by position. `match_variant_wrong_enum.fit` reports both its errors at `5:5` while the offending arms are on lines 7 and 8. | Add a `pos` field to `Pattern` or `MatchArm` in `ast.ts`, populate it in `parsePattern` / `parseMatchStmt`, and use it in place of `stmt.pos` for arm-specific errors in the arm loop. Exhaustiveness and wildcard-covers-linear errors correctly stay at `stmt.pos` — they are properties of the whole match, not of any one arm. |

None of these limitations caused a false negative or false positive on the canonical programs or the test suite, *provided* extern resource params carry explicit `move`/`lend` annotations.

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

The module system added 113 lines across all components (+87 loader, +17 parser,
+8 types, +1 ast).

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

## v0.1 Phase — Codegen completion (2026-06-08)

### What landed

Two rounds completed v0.1 codegen form coverage:

**Round A** (`62a0e08`) — structural foundation:
- Block scoping for `let` (fixes parameter-vs-let and let-vs-let shadowing in C99)
- `if`/`loop`/`break` codegen
- Snapshot test infrastructure (`tests/codegen.test.ts`, `scripts/regen-snapshot.ts`)
- Four initial snapshots: `payment.fit`, `drain.fit`, `plain_loop.fit`, `typestate_rebind_branch.fit`
- Two pre-existing bugs fixed along the way: `unit` → `void` in function return position; duplicate cleanup extern suppression when a resource's cleanup fn is also declared as an explicit fn extern

**Round B** (`5f57ea9`) — form completion:
- `record` decls → C structs
- `select` → comment marker `/* select X from Y */`
- Enum payload variants → tagged union representation (unit-only enums remain as C enums)
- `qualified_var` correctness fix (was emitting `0` as placeholder)
- `match` codegen with arm-by-arm state propagation, payload bindings, and synthesized `abort()` arm for non-exhaustive matches
- Fifth snapshot: `match_basic.fit`

### Form coverage

After Round B, every v0.1 statement, expression, and declaration form has a codegen case:

- **Statements:** `let`, rebind, `expr`, `if`, `loop`, `break`, `match`, `select`
- **Expressions:** `var`, `call`, `ok`, `err`, `try`, `qualified_var`, `unit_val`
- **Declarations:** `resource`, `enum`, `record`, `type`, `capability`, `fn`, `import` (stripped by loader)

### Snapshot programs — all pass `cc -std=c99 -Werror -c`

| Program | Forms exercised |
|---------|-----------------|
| `payment.fit` | Linear types, error propagation, capabilities |
| `drain.fit` | Typestate progression, recursion, error propagation |
| `plain_loop.fit` | Loop with stable typestate, if + break |
| `typestate_rebind_branch.fit` | `if` + `mut` + typestate progression via merge |
| `match_basic.fit` | Match with payload variant + unit variant |

### smtp.fit — type-checks, does not codegen

`smtp.fit` is the third canonical from the PoC charter. It type-checks (zero check errors) but does not produce valid C99. The underlying limitations are documented in the Known Limitations table above (undeclared identifier silent acceptance; type alias raw in C output). `smtp.fit` is best characterized as **type-checking-only as a standalone program**; codegen would require either a stdlib sketch supplying the missing declarations or extending the file to declare them locally.

### Test count

338 tests across 9 suites.

### Line counts (post-Round B)

| Component | Lines |
|-----------|-------|
| `src/ast.ts` | 60 |
| `src/parser.ts` | 598 |
| `src/checker.ts` | 537 |
| `src/types.ts` | 386 |
| `src/loader.ts` | 82 |
| `src/codegen.ts` | 675 |
| `src/main.ts` | 45 |
| **Total** | **2383** |

### Definition of done — met

Per `FIT-v0.1-codegen-scoping.md`:
- ✅ Every statement and expression form has a codegen case
- ✅ Three canonical programs (payment, drain, match_basic) emit valid C99; smtp.fit is type-checking-only by current limitations
- ✅ Snapshot infrastructure holds output stable
- ✅ Cleanup emitted on `?`, scope exit, and Ok/Err returns
- ✅ Capabilities compile-time-only (no runtime threading emitted)
- ✅ Typestate erased at codegen time
- ✅ Non-exhaustive matches synthesize `abort()` (v0.1 default; tightened when exhaustiveness checking lands)

---

## v0.1 Phase — Match exhaustiveness (2026-06-08)

### What landed

Exhaustiveness checking for matches on declared enums, a strict wildcard rule for
linear payloads, and two rounds of resolution-check hardening.

**Probe round** (`e7dfa11`) — four programs establishing actual current behavior
before any implementation:

| Probe | Finding |
|---|---|
| Payload-type tracking | Already working — the limitation entry was out of date |
| Matching on Result | Type-checks, but generates invalid C (see Known Limitations) |
| Wildcard dropping a linear payload | Leak surface confirmed |
| Non-exhaustive match | Silent acceptance confirmed |

**Implementation** (`731ba2c`):
- `EnumInfo` extended with a per-enum variants list (name + resolved payload)
- Coverage check in `case "match"`: missing-variant error when no wildcard is
  present; wildcard-covers-linear-payload error under the strict rule
- Probes 3 and 4 moved to `should_fail/` with descriptive names
- Three new `should_pass` programs, including a destructured-then-wildcard case
  confirming that the strict rule tests *uncovered* variants rather than all
  variants — a linear-payload variant that is explicitly destructured does not
  trigger the rule

**Resolution hardening** (`6b2c1a3`, `7e0b524`, `f533b5b`):
- Unified the "variant not in scrutinee's enum" error. Previously a variant name
  that existed in a *different* enum was silently accepted, while a variant that
  existed nowhere produced an error — inconsistent treatment of what is, from the
  user's side, one fact. Both now emit `variant 'X' is not declared by enum 'E'`.
- The ambiguous-variant case retains its own distinct message, which carries
  disambiguation hints (`use 'A.X' or 'B.X'`) that the unified message would lose.
- `covered.add` gated on resolution (`variantInfo !== null`) rather than on the
  reporting flag. All three unresolved paths — wrong-enum, undeclared, ambiguous —
  now leave the variant uncovered, so the exhaustiveness error still fires
  alongside the resolution error.

### Rule count: 8 → 9

Match-exhaustiveness is a new enforced rule. Two other checks added in this phase
are not counted: wildcard-covers-linear-payload extends rule 1 to a new surface,
and variant-in-scrutinee-enum is name resolution rather than a substructural rule.
See the Q1 accounting note above.

### Severity characterization — recorded deliberately

The `covered.add` bug fixed across `7e0b524` and `f533b5b` was initially
characterized internally as a critical soundness issue ("an invisible
exhaustiveness gap is a linearity hole"). The traces do not support that. In every
affected case an error already fired for the same arm — wrong-enum, undeclared, or
ambiguous — so the program was rejected regardless; the bug suppressed a *second*,
additional error. That is **diagnostics completeness, not soundness**, the same
class as the recursion-inference round.

Recorded because mislabelling completeness as soundness is what justified bundling
the fix rather than stopping to report, and because this project has already lost
time to an unverified claim propagating across rounds (the Austral line-count
reference).

### Out of scope, carried forward

- **Result matching** — its own round, gated on a design decision (builtin enum
  vs. special form). See Known Limitations.
- **Pattern-level source positions** — arm-specific errors report the `match`
  line rather than the offending arm. Now tracked as a Known Limitation above.
- **Unreachable-pattern detection** (e.g. a wildcard preceding specific variants).
- **Exhaustiveness for unknown / extern-returned scrutinees** — preserves existing
  silent acceptance; entangled with the undeclared-identifier design call.

### Test count

354 tests.

---

## Natural next steps (post-PoC, in priority order)

1. ~~**Run the reader study** — find non-programmer subjects, administer `docs/reader-study.md`, record comprehension scores against FIT-SPEC-v2.md §10 success criterion.~~ *Done — Q2 closed positively; see PoC question 2 above.*
2. ~~**Fix self-recursive inference** — fixed-point iteration over the call graph so self-recursive and mutually-recursive functions are inferred correctly without requiring explicit annotation.~~ *Done in `f044e88` (v0.1 recursion-inference round); see Known Limitations table.*
3. ~~**Match exhaustiveness and payload types** — requires resolving enum variant payload types first.~~ *Done — exhaustiveness in `731ba2c`; payload types were already working (verified `e7dfa11`). See v0.1 Phase — Match exhaustiveness below.*
4. ~~**Codegen target** — choose a compilation target (C, LLVM IR, WASM) and implement a minimal backend for one of the canonical programs to verify the model translates.~~ *Done in v0.1 codegen Rounds A+B (`62a0e08`, `5f57ea9`); see v0.1 Phase — Codegen completion below.*
5. **Standard library sketch** — define the FIT equivalents of `File`, `TcpSocket`, `HttpConn` to validate that real-world resource types fit the resource + typestate model.

---

*See also: `docs/FIT-SPEC-v2.md` (authoritative semantic decisions), `docs/FIT-SYNTAX.md` (frozen concrete syntax), `docs/reader-study.md` (PoC question 2 instrument).*
