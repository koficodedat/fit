# FIT — Proof-of-Concept Design Spec & Charter

**Version:** Draft 2 (Phase 1 amendments applied)
**Status:** Pre-implementation. Settled decisions are firm; open forks are explicit.
**Changes from Draft 1:** §3 amended (cleanup-at-consumption rule; O9 resolved-and-deferred);
§4 amended (lend inference rule corrected; frozen-signature decision added; early disposal
specified); §5 amended (O1 settled — explicit `select` projection); §7 amended (O2 settled —
named unions + implicit widening); §9 amended (O1, O2, O5, O9 closed). See amendment markers.

**Purpose of FIT:** determine whether a small, functional, capability-secure systems
language with compile-time resource safety and *opt-in compile-time protocol-state safety*
earns its keep as a distinct language — or whether it collapses into an existing one
(notably Austral).

> **How to use this document.** This is the single working reference. Companion test
> documents (the "evidence trail") back every decision with a hand-written program that
> proved or broke it; they are listed in the Appendix and kept as backing, not needed for
> daily work. When a decision here seems arbitrary, the named test doc shows why it isn't.

> **A discipline note carried from the session that produced this:** every decision below
> was reached by *writing a real program and trying to break it*, not by reasoning in the
> abstract. Maintain that. The failure mode to avoid is defending a feature by adding rules;
> when a test pushes back, first ask whether the feature should be *removed or demoted*, not
> patched. Three of this project's biggest improvements came from removing things.

---

## 1. Identity — what FIT is and is not

### 1.1 FIT is
A small **systems → server → data** language built on **one substructural core**: every
value has a use-discipline (unrestricted / affine / linear), and resources, capabilities,
protocol-state safety, and error handling are all that one idea applied to different
problems — plus a small, fixed set of composition rules.

The bet: **deterministic resource safety + capability security + opt-in compile-time
protocol-state safety, in a language you can read top-to-bottom**, with **no GC, no
exceptions, no ambient authority, and no borrow-lifetime algebra.**

### 1.2 FIT is not
- **Not frontend.** Different domain; explicitly out of scope.
- **Not object-oriented.** No methods, no inheritance, no dispatch, no `this`. Types declare
  *data + (for resources) destruction*; **all behavior is free functions.**
- **Not garbage-collected.** Cleanup is deterministic and declared.
- **Not exception-based.** Errors are values.
- **Not ambient-authority.** Importing code grants no power.
- **Not a borrow-checked language in the Rust sense.** It has lending, but lends cannot
  escape, so there are no lifetimes to track (see §4).
- **Not a constraint/logic/solver language.** (An early framing, since dropped.)

### 1.3 The honest positioning vs. Austral
FIT's *core thesis* (linear types + capabilities + no GC/exceptions/ambient + small &
readable) is, candidly, **convergent with Austral**, which already ships it. FIT is only
worth being its own language if its **distinctive choices** pay off:
1. **Opt-in compile-time protocol-state safety (typestate)** that Austral does not enforce.
2. **Lending as the default, sigil-free, non-escaping calling convention** (vs. Austral's
   explicit `borrow ... as ... in region` construct).
3. **Automatic, declared-at-type cleanup** (vs. Austral's explicit destructors).
4. **Capabilities as compile-time-resolved signature requirements** (vs. explicit value
   args).

The PoC exists to test whether (1)–(4) are genuinely better, or just different. If they are
merely different — or worse by FIT's own no-magic standard — the honest outcome is to
contribute to Austral or stop. **This possibility must remain live throughout.**

---

## 2. The substructural core

### 2.1 Memory modes (a property of the value/type)
| Mode | Use count | Droppable? | Copyable? | For |
|------|-----------|------------|-----------|-----|
| **unrestricted** | 0..∞ | yes (trivial) | yes | plain data — the default |
| **affine** | 0 or 1 | yes — **only if drop is a true no-op** | no | optional/speculative values whose abandonment is free |
| **linear** | exactly 1 | no — must be disposed | no | resources / obligations |

- **Default is unrestricted.** A value is affine/linear only if its type opts in. Tracking
  earns its cost only where there's a resource to release or duplication to forbid.
- **"Used once" ≠ linear.** Coincidental single use is still unrestricted; linear means the
  compiler *forbids* a second use.
- **"No-op drop" defined precisely:** memory is *always* reclaimed mechanically (scope exit /
  owner release). "No-op drop" means **no destructor logic runs** — nothing closed, flushed,
  released, zeroized. Affine is legal *only* for such values. If drop must *do* something,
  the type must be linear with cleanup.

### 2.2 Binding mode: `mut`
`mut` is **not** a fourth memory mode. It modifies a *name*: "rebind this name with each
result" (consume old value, bind new). Orthogonal to the three memory modes; composes with
all of them. For a linear value, the consuming step is what discharges the exactly-once duty.
Any in-place optimization must be unobservable (no aliasing) or it violates no-magic.

### 2.3 Resource classification (forced, not chosen)
**One question decides everything about a type: does it declare cleanup?**
- **Declares cleanup** → non-trivial drop → **resource** → **linear** (cleanup must run
  exactly once → exactly one owner → linearity). Cannot be affine or unrestricted.
- **No cleanup** → trivial drop → plain data → unrestricted (default) or affine.

`affine + cleanup` = compile error. "unrestricted resource" is a logical contradiction
(copies make "clean up exactly once" meaningless), so it does not exist. The classification
is per-*type*; signatures inherit it. A `resource` with empty cleanup is an error — "this
should be plain data."

### 2.4 Type-system keywords *(settled, was O5)*
- **Product types** (plain data, named fields): `record`
- **Sum types** (tagged unions): `enum`

These are the only two type-declaration keywords for data. `resource` is the keyword for
linear types that declare cleanup (§2.3). All three are reserved; rejected synonyms
(`data`, `struct`, `union`, `sum`) are also reserved to prevent future conflicts.

*(Evidence: O5 closed Phase 1. Keywords chosen for familiarity and clarity of intent.)*

### 2.5 Variant name resolution

Variant names need not be globally unique across enums. A bare variant name `V` resolves unambiguously if exactly one declared enum contains `V`; if multiple enums declare `V`, the use site must qualify using dot syntax: `EnumName.V`.

**Resolution rule (implemented, PoC 2026-05-29):**

1. Bare `V` at a use site (e.g. a match arm): resolve by scanning all declared enums. If exactly one declares `V`, use it. If zero declare it, emit `unknown variant 'V' in match pattern`. If two or more declare it, emit:
   ```
   ambiguous variant 'V' — declared by enums X, Y; use 'X.V' or 'Y.V' to disambiguate
   ```

2. Qualified `EnumName.V`: look up `EnumName` in declared enums. If not found:
   ```
   unknown enum 'EnumName'
   ```
   If found but `EnumName` does not declare `V`:
   ```
   enum 'EnumName' does not declare 'V'
   ```
   Otherwise resolve to the `V` declared by `EnumName`.

**Syntax:** Dot notation only — `IoError.NotFound`. No `::` (FIT is not Rust).

**Disambiguation against future field access:** The parser treats `Name.member` as a qualified access. Whether the left-hand side is a type name (variant qualification) or a value name (field access) is a semantic distinction deferred to the checker. Field access is not yet implemented.

**Deferred: mixed-qualification within one match.** Whether a match arm using `IoError.NotFound` can coexist with a bare `BadRequest` arm (where `BadRequest` is unambiguous) in the same match is an open design question. The current checker resolves each arm independently; mixed-qualification is permitted if all bare names are unambiguous.

*(Evidence: stdlib probe finding — enum variant name conflicts discovered when composing multiple resource domains (server.fit). Option B (dot syntax) implemented PoC 2026-05-28; payment.fit, smtp.fit, drain.fit, and all probe files (file.fit, tcp.fit, http.fit, server.fit) pass with natural, un-prefixed variant names.)*

---

## 3. Cleanup & disposal

- **Declared once, at the type.** A resource defines its cleanup in its own definition.
- **Automatic firing.** The compiler runs a resource's declared cleanup on every scope exit
  where the value is **still owned** — including early exits via `?`.
- **[AMENDED] Scope-exit enforcement.** A linear value owned at any scope exit (function body, branch, match arm, loop body) is a compile error if not consumed. This applies to all linear types (resources and linear enums).
- **Move-out skips cleanup.** If ownership leaves (the value is returned or consumed by
  another call), cleanup does **not** fire there (no double-free). Linearity's move-tracking
  already knows the value is gone.
- **[AMENDED] Cleanup at point of consumption.** When a value is consumed by a function
  that transfers it nowhere onward (returns nothing of it, stores it into nothing), cleanup
  fires at that point — not at scope exit. This is what makes explicit early disposal
  expressible: calling `drop(r)` on a resource mid-scope is an ordinary consuming call
  whose body transfers nothing onward; cleanup fires immediately. No special mechanism —
  this follows directly from "move-out skips cleanup" and "auto-fires for still-owned
  values."
  **[SETTLED — codegen spike 2026-05-26]** The rule is uniform: a resource moved into a
  function and not transferred onward is disposed by that function (at scope exit, or earlier
  via drop) — the same rule that governs locals. For bodied functions, the compiler enforces
  this by emitting the cleanup call at scope exit. For extern functions (no FIT body), this
  is the author's obligation: the hand-written implementation must call cleanup before
  returning on every path, success and failure alike. The compiler cannot insert the call but
  can verify the caller emits no cleanup (move-out-skips-cleanup holds on the caller side).
- **Cleanup must be infallible.** It cannot itself fail or there's no answer to "what cleans
  up the cleanup."
- **[AMENDED] Fallible teardown — two-phase pattern (O9, resolved-and-deferred).**
  Some resources have teardown that legitimately can fail (flushing a buffer, committing a
  transaction). The resolution: such a resource provides an explicit *consuming* fallible
  function (`flush_and_close`, `commit`, etc.) that returns `Result` — the programmer calls
  this for controlled teardown. The resource's *declared cleanup* is an infallible emergency
  fallback (force-close, rollback, discard) that fires only if the explicit path was not
  taken. Because the explicit path is an ordinary consuming call, move-out-skips-cleanup
  means the fallback never double-fires. A resource may mark its cleanup as
  **fallback-preferred**; the compiler then emits a warning at any scope exit where
  auto-cleanup fires without a prior explicit teardown. Resources whose fallback is
  genuinely safe (nothing lost on force-close) set no flag and warn-free. **Implementation
  deferred past PoC** — PoC uses only resources with trivially infallible cleanup.
- **Why this is magic-free:** the only thing that can fire implicitly is the *exact cleanup
  the type declared, visible in its definition.* There is no hidden *choice* — only a hidden
  *call-site* of an already-declared, already-visible behavior. (This is the deliberate
  divergence from Austral, which forbids implicit destructors entirely. The PoC must judge
  whether FIT's "declared-then-auto-fired" threads the no-magic needle or is just implicit
  destructors with a nicer story.)

*(Evidence: scoped-lending test §3–4; O9 resolved Phase 1 design session.)*

---

## 4. Lending (borrowing without lifetimes)

- **Lend = use without consuming.** A function that uses but does not take ownership of a
  resource borrows it for the **duration of the call only**.
- **No escape.** A lend may **not** be stored, returned, or captured to outlive the call.
  Because it cannot escape, the borrow begins and ends at the call boundary — **so there are
  no lifetimes to track.** This is the entire reason FIT avoids Rust's borrow-checker
  complexity: escape is what forces lifetime tracking, and FIT forbids escape.
- **[AMENDED] No sigil — correct inference rule.** Lend-vs-consume is inferred from the
  function body, not from the shape of the return type. The rule:
  - A parameter is a **move (consumes)** if the function body transfers it onward on any
    path — returns it (in any form or typestate), stores it into an aggregate, or passes it
    to another consuming function.
  - A parameter is a **lend (borrows)** if the function body only uses it — passes it to
    other lends, reads from it — and never transfers it onward. The caller retains ownership
    after the call returns.
  - This classification covers all cases: a read-only function (`read_data(conn) -> Data`)
    lends because the body never transfers `conn`; a state transition
    (`handshake(conn: Conn<Fresh>) -> Conn<Ready>`) consumes because it returns `conn` in a
    new state; and an ownership-into-aggregate call (`pool_add(pool, conn) -> Pool`) consumes
    `conn` because the body stores it into `pool`.
- **[AMENDED] Extern annotation for linear parameters.** Functions without bodies (externs,
  FFI declarations, abstract interfaces) cannot be inferred — the checker has no body to
  inspect. For any extern function with any linear parameter (resource or enum), the programmer must
  supply an explicit annotation between the colon and the type name:
  ```
  fn close(c: move SmtpConn<Closing>) -> Result<(), SessionError>
  fn send_message(c: lend SmtpConn<Ready>, msg: Message) -> Result<(), SessionError>
  ```
  An extern with any linear parameter and no annotation is a **compile error**.
  Non-linear parameters (plain types, aliases, records) never require annotation — the
  move/lend distinction is meaningless for unrestricted types, and the compiler accepts or
  ignores any annotation silently.
  Body-inspection still applies to **bodied** functions: an explicit annotation on a bodied
  function overrides inference; omitting it causes the compiler to infer from the body.
- **[AMENDED] Frozen published signature.** Move-vs-lend is inferred once per function from
  its body and then **frozen as part of the function's published type**. A subsequent body
  change that would flip a parameter from lend to move is a compile error at the signature
  boundary — not a silent change to callers. This prevents the fragility of body-based
  inference silently breaking call sites. The programmer writes no sigil; the compiler
  computes the property, freezes it, and displays it in signatures, hover, and docs.
- **[AMENDED] INT-X1 readability risk — reframed.** Because move-vs-lend is inferred and
  not written, a reader must understand the inference rule or consult the displayed signature
  to know if a call consumes its argument. The move/lend property is part of the function's
  published type and is **always displayed**, even though not hand-written. Whether display
  alone is sufficient — or whether readers consistently want a written marker — is exactly
  **PoC question 2**. If readers are consistently confused and the only fix is a written
  sigil, FIT's no-sigil differentiator is lost.

*(Evidence: scoped-lending test; borrow-vs-permits test; §4 rule corrected Phase 1 —
original text had the inference direction backwards.)*

---

## 5. Capabilities

- **Requirements, not arguments.** A function declares needed authority in its signature
  (`using Net`); it is callable only in a context that supplies it. Resolved at compile time,
  desugaring to threading (no-magic).
- **No ambient authority.** `main` declares its requirements; the **runtime** is the supplier
  and the sole root of physical authority. No `env` grab-bag. A capability absent from
  `main`'s requirements (and not minted downstream) is unreachable — visible in one signature.
- **Import gives code, never authority.** `import fs` brings functions/types; power comes
  only from a held capability. The supply-chain safety property: a dependency cannot touch
  the filesystem just by being imported.
- **Strict resolution.** Exactly one capability of a given type in scope, or compile error.
  Different types coexist freely; same-type duplicates must be scoped apart.
- **Two kinds.** *Authority-bearing* (root: runtime; e.g. `Fs`, `Net`, `Console`) and
  *permission* (root: a **mint** capability held by the designated issuer; e.g. `ChargeCard`).
  Permission caps are opaque and unforgeable — **not** no-ops.
- **Unforgeable ≠ linear.** `Console`/`Net` are unforgeable-but-unrestricted (reused freely);
  a one-shot token is linear. Forgeability and use-count are independent axes.
- **Composition = sets of atoms.** Atoms (`Read`, `Write`, `Net`…), **flat bundles**
  (`Fs = Read + Write + …`), and **projection** (narrow to a subset; can only remove). One
  mechanism (bundling) + its inverse (projection). **v1 guard: no lattice, no
  narrowing-of-bundles algebra.**
- **[AMENDED] Explicit projection with `select` (was O1).** Holding a bundle (`Fs`) does
  **not** auto-satisfy a member atom requirement (`using Read`). The programmer must
  explicitly project: `select Read from fs`. The `select` keyword extracts one or more atoms
  from a bundle, producing a narrowed capability. Implicit satisfaction is rejected because
  it violates strict resolution — the compiler cannot silently decide which bundle satisfies
  which atom when bundles overlap. `select` may extract multiple atoms in one expression:
  `select Read, Write from fs`.
- **Mint vs. typestate are different axes.** Mint = creation of a *new* value (minter
  persists). Typestate = transformation of *one* value (same identity, new state). They
  compose (a minted cap can be typestated).
- **`using` keyword:** used **only** for capability requirements. One keyword, one meaning.

*(Evidence: capabilities caused zero friction in the TCP and integration tests; O1 closed
Phase 1.)*

---

## 6. Typestate & protocol-state safety (the differentiator)

- **Typestate is core.** A resource's state can be encoded in its type (`Conn<Ready>`).
  Operations illegal in a state do not exist → calling them won't compile. This is the
  primary thing distinguishing FIT from Austral.
- **Straight-line transitions need no recursion.** A handshake (`Fresh → Greeted → Ready`)
  written as a sequence changes the value's type step by step in ordinary straight-line code.
- **Loop-across-transition requires recursion — and the compiler demands it.** A `loop` whose
  body changes the binding's typestate fails to type-check: the end-of-body type ≠ the
  loop-head type. The error tells the programmer to use recursion. **Recursion is never
  silently required; it is compiler-demanded exactly and only when a loop crosses a state
  boundary.**
- **Frequency:** in a representative transport protocol, recursion was forced in ~1 of 4
  components (~15% of lines), confined to the drain-across-transition case. Setup/teardown
  (straight-line) and data/keep-alive loops (no transition) stay plain. Heavily stateful
  negotiation protocols would hit it more often — not universal.
- **The intrinsic tradeoff (proven, not assumed):** *compile-time enforcement of state
  ordering* and *a plain loop across a state transition* are fundamentally in tension. Any
  mechanism that makes wrong-order-won't-compile must put state in a type; any type that
  changes on transition breaks `mut`-in-a-loop. Borrowing does **not** dissolve this. It is
  intrinsic (it's why session-typed languages use recursion). FIT's choice is to **accept the
  recursion idiom for the rare loop-across-transition**, with a compiler guardrail.
- **Decision recorded:** keep compile-time safety; handle recursion the few times it's
  required; rely on the compiler to detect-and-demand it.

*(Evidence: borrow-vs-permits test located the tradeoff and proved it intrinsic;
recursion-frequency count measured it at ~15%; the integration test exercised all three
cases — straight-line, plain-loop, recursive-drain — together.)*

---

## 7. Errors

- **Errors are values** (sum types, using `enum`). No exceptions, no unwinding.
- **Failures visible in the signature.** A function's error type is the **union** of its
  failure modes. "No `NetError` in the union → provably cannot fail by network," mirroring the
  capability audit surface.
- **Failed consuming operations + automatic cleanup.** A consuming op that fails must not
  strand its resource. With automatic cleanup (§3), an owned resource is disposed on the error
  exit; a consumed-then-failed resource must be cleaned **inside** the failing function (the
  caller no longer owns it). (Integration test INT-X3 flags this as a soundness obligation the
  implementation must honor.)
- **[AMENDED] Error aggregation — settled (was O2).** When a function calls multiple
  fallible operations, its error type is the **named transparent union** of those operations'
  error types. The `?` operator implicitly widens a member error to the enclosing function's
  declared error union — no manual wrapping. Type information is always preserved; no
  `anyhow`-style erasure hatch exists. The programmer declares the union explicitly:
  `type HttpError = ParseError | NetworkError | DbError`. Implicit widening works when the
  error is a member of the declared union; otherwise it is a compile error requiring an
  explicit conversion. **This is untested against real programs; if implicit widening proves
  ambiguous in practice, explicit wrapping at each `?` site is the fallback.**

**Implementation note (PoC, 2026-05-28):** The `?` compatibility rule is now enforced. `e?` is legal iff:

1. The error type of `e` equals the enclosing function's declared error type (same name), OR
2. The enclosing function's error type is a named union alias and the error type of `e` is a flat member of that alias (string-membership against `alias.members`).

Nested-alias expansion (where a member is itself an alias) is **not** implemented — it would require alias-resolution beyond the current flat-member model. Whether `?` widening should see through nested aliases is a deferred design question. All current programs use flat unions (leaf enums as members), so flat membership is correct and sufficient.

Error messages:
- `cannot propagate error type 'X' — not a member of 'Y' declared by '<fn-name>'`
- `'?' in a function that does not return Result`

---

## 8. Functional discipline (locked principle)

> **Types declare data and (for resources) destruction. All behavior is free functions.**

No methods, no inheritance, no dispatch, no `this`, no privacy levels. A `resource` body
contains exactly two kinds of things: **fields** (data it owns) and a single **cleanup**
(how it's destroyed — a destructor declaration, not a method). Functions like `send`/`recv`
take the resource as a parameter; they are not attached to it. This single principle
preempts the entire OO machinery and is the main lever keeping FIT's footprint small.

Method-call *sugar* (`c.send(b)` desugaring to `send(c, b)`) is **deferred and optional**
(O6) — cosmetic, decidable later, does not affect semantics.

---

## 9. Open forks

### Settled this phase
| ID | Question | Decision |
|----|----------|----------|
| **O1** | Bundle auto-satisfaction vs. explicit projection? | **Explicit `select`.** `select Read from fs` required; no implicit satisfaction. Multiple atoms allowed: `select Read, Write from fs`. |
| **O2** | Error-union aggregation mechanism? | **Named transparent unions + implicit widening at `?`.** Programmer declares union type explicitly; compiler widens implicitly; no erasure. Untested — explicit wrapping is the fallback if widening is ambiguous. |
| **O5** | Type-system keywords? | **`record` (product) + `enum` (sum).** Frozen. |
| **O9** | Cleanup that can fail? | **Two-phase pattern, resolved-and-deferred.** Explicit consuming teardown function (fallible) + infallible auto-cleanup fallback. Optional `fallback-preferred` flag on resource triggers compiler warning on silent fallback. PoC uses only trivially-infallible-cleanup resources. |

### Still open
| ID | Question | Lean |
|----|----------|------|
| **O3** | Regions for cyclic/aliased linear structures — untested against a real cyclic program. | — |
| **O4** | Async/concurrency. Intended direction: capability-gated suspension + concurrency-as-region, explicit yield points, no hidden scheduler. | deferred |
| **O6** | Method-call sugar (`c.send(b)`)? | deferred, cosmetic |
| **O7** | Cyclic resources / guaranteed ordered disposal on the error path. | wait for real need |
| **O8** | Does FIT's auto-cleanup genuinely satisfy no-magic, or is it implicit destructors renamed? | PoC must judge |

### Reserved keywords
`resource`, `capability`, `record`, `data`, `struct`, `type`, `error`, `enum`, `sum`,
`union`, `using`, `select`, `cleanup`, `mut`, `linear`, `affine`, `import`, `drop`.
(Rejected synonyms also reserved so a future programmer cannot claim a name we may need.)

### Contextual keywords
`move` and `lend` are **contextual keywords**: they are recognised only in the parameter-annotation position (`param: move Type`, `param: lend Type`) and remain valid identifiers in all other positions. They are not reserved. Tooling note (record, do not build): syntax highlighting must be position-aware to avoid false-positive keyword colouring on identifiers named `move` or `lend`.

---

## 10. The PoC charter — what we are actually testing

**The PoC is a viability test, not a language build.** It must answer exactly three
questions and resist scope creep into a full language project.

### The three questions
1. **Does the borrow-inference + automatic-cleanup + linearity checker actually work, and is
   it small?** Implement *only* the type/ownership checker for a minimal core. Austral's
   equivalent is ~600 lines. If FIT's is small and clean, the central simplicity claim is
   real; if it balloons, that's a finding.
2. **Does no-sigil lending confuse real readers?** The move/lend property is inferred,
   frozen in the function's published type, and always displayed — but not hand-written. Put
   real FIT code in front of people. If they consistently cannot tell when a value is
   consumed even with the displayed property, FIT may need a written marker after all
   (the `&` sigil from the scoped-lending companion doc is the known-working fallback).
3. **Is the typestate + recursion-guardrail experience tolerable?** Write 2–3 real protocols.
   Measure how often recursion is forced and whether the compiler's "use recursion here" error
   is helpful or irritating.

### Explicitly OUT of PoC scope
Capability resolution implementation, regions, async, full error-union aggregation testing,
a full type system, codegen/runtime, a standard library, package management, two-phase
cleanup, linear collections. Including them turns a viability test into a multi-year project.

### The kill criteria (keep these honest)
- If the checker is **not** meaningfully smaller/simpler than Austral's → FIT's simplicity
  edge is illusory → consider contributing to Austral instead.
- If no-sigil lending **consistently** confuses readers and the only fix is a written sigil →
  the no-magic-borrow differentiator is lost → reassess.
- If the recursion guardrail is **frequently** triggered or its errors are **routinely**
  unhelpful in real protocols → the typestate differentiator costs more than it's worth →
  fall back to typestate-as-opt-in-pattern (which is ~Austral) and reassess.

If two of three kill criteria fire, the honest conclusion is that FIT does not earn its keep
as a distinct language. That outcome is a *successful* PoC — it answers the question.

---

## 11. Execution path

1. **Phase 1 — Design (complete).** Settled O1, O2, O5, O9; corrected §4 lend inference
   rule; added frozen-signature and early-disposal rules to §3/§4. Output: this document.
2. **Build phase (Claude Code).** Implement the minimal checker (Q1), write the 2–3 protocols
   (Q3), gather reader feedback (Q2). The spec is the in-repo reference; the reasoning is
   already done here.
3. **Decision.** Evaluate against §10 kill criteria. Continue, pivot to typestate-as-pattern,
   contribute to Austral, or stop — on evidence.

**Model discipline:** reserve Opus for decisions that need *challenging*, not output
*produced* — genuine forks, coherence stress-tests, "is this just Austral" honesty checks.
Most PoC work is execution against this spec.

---

## Appendix — Evidence trail
Each is a hand-written program that proved or broke a decision:
1. `fit-error-model-and-first-syntax` — first capability/error model + syntax.
2. `fit-zp-handshake-stress-test` — broke the single-resource error assumption.
3. `fit-twobody-test` — corrected it (per-resource ownership; cross-domain check).
4. `fit-mut-and-disposal-tests` — `mut` orthogonality; disposal order.
5. `fit-memory-and-binding-model` — the 3×2 matrix.
6. `fit-typestate-affine-r4-tests` — TCP event-driven break; affine sharpening; R4/closure break.
7. `fit-rule-interaction-test` — EVT×mut conflict; recursion idiom located.
8. `fit-option1-typestate-demoted` — demotion experiment (proved typestate was the cascade root).
9. `fit-vs-austral` — the honest comparison and the differentiator question.
   Plus: `fit-scoped-lending-test`, `fit-borrow-typestate-vs-permits`,
   `fit-recursion-frequency-count`, `fit-settled-decisions-and-integration` (later rounds).

*End of spec.*
