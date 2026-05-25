# FIT — Consolidated Model (after 4 rounds of falsification testing)

> **What this is:** the single reference that supersedes the scattered test docs. Every
> claim here is tagged with its evidence status. **Verified** = survived a hand-written
> test against a real or realistic program. **Reasoned** = follows from verified parts but
> lacks its own test. **Open** = an unresolved fork or known gap.
>
> **What this is not:** a spec, a tutorial, or syntax-final. Surface syntax is illustrative
> throughout. This is the *semantic model* and its evidence.
>
> **Companion docs (the test record):** handshake stress test, two-body test,
> mut/disposal tests, typestate/affine/R4 tests, rule-interaction test. This consolidates
> their conclusions.

---

## 0. What FIT is, in one paragraph

FIT is a small systems→server→data language (explicitly **not** frontend) built on **one
substructural core**: values have a *use discipline* (unrestricted / affine / linear), and
everything else — resources, capabilities, state machines, regions, error handling — is
that one idea applied to different problems, plus **a small fixed set of composition rules**
that govern how those applications combine. The bet: deterministic resource safety and
capability security, with a model a strong beginner can *read*, without a borrow checker, a
GC, exceptions, or ambient authority.

**Honest revision of the original pitch:** early sessions claimed "one mechanism, several
hats." After four test rounds the accurate claim is **"one core mechanism + a small fixed
set of composition rules + one idiom (recursion for state machines)."** Still small by
systems-language standards; no longer literally "just one thing."

---

## 1. The substructural core *(verified)*

### 1.1 Memory modes — a spectrum of obligation
```
unrestricted  ─────  affine  ─────  linear
 (no duty)         (may consume)   (must consume)
 use 0..∞          use 0 or 1      use exactly 1
 copy freely       no copy         no copy
 drop freely       drop = no-op*   must dispose
```
`*` **AFN rule (verified, Test D):** affine is legal **only if its drop is observationally
a no-op.** If dropping must *do* something (release a lock, close a handle, zeroize a
secret), the type must be **linear with a `cleanup`**, not affine. Affine is for values
whose abandonment is genuinely free (speculative hints, optional leases the system
reclaims). **This must be compiler-enforced, not conventional** (hardened by Test F:
event-driven code creates many implicit drop points).

### 1.2 Default: unrestricted *(verified reasoning)*
A value is unrestricted unless its type opts into affine/linear. Tracking earns its cost
only where there's a resource to release or a duplication to forbid. **Used-once ≠ linear:**
a value used once by coincidence of control flow is still unrestricted; linear means the
compiler *forbids* a second use.

### 1.3 Binding modes — orthogonal to memory modes *(verified, Test A)*
`mut` is **not** a fourth memory mode. It modifies a *name*: "rebind with each result"
(consume old value, bind new). It composes with all three memory modes (the 3×2 matrix).
For linear values, the consuming step is what discharges the exactly-once duty.
**R5:** `mut` is only ever semantically consume-and-rebind; any in-place optimization must
be unobservable (no aliasing), or it would violate no-magic.

---

## 2. Resources, cleanup, and the disposal rules *(verified)*

- **R1 — disposal required:** every linear value, on every exit path, is consumed,
  `cleanup`-disposed, or threaded out (incl. in the error). Leak = compile error.
- **R2 — caller-owned linear arguments:** a linear value passed into a *fallible* function
  must be owned by a `using` binding (or threaded back out), so its error-path disposal is
  guaranteed. A bare linear argument to a fallible function = compile error. *(This is the
  corrected, generalized form of the original "§7.2" concern — the issue was never the
  count of resources, only whether each has an owner.)*
- **R3 — cleanup fires only for still-owned values:** moved/explicitly-closed values are
  removed from the cleanup set (no double-free). Enables R6.
- **R6 — LIFO disposal, override by explicit close:** multiple `using` bindings dispose in
  reverse acquisition order. When required order is decoupled from acquisition (rare, esp.
  across function boundaries), close explicitly in-body; R3 handles the remainder.
  **Open residue:** no *guaranteed ordered* disposal if an error interrupts the manual
  sequence — deferred until a real program needs it (condition precisely characterized in
  the disposal test).
- **R4 (restated, Tests A+E):** *on `?`, every live linear binding — at its **current**
  value — must have an exit disposition.* Generalizes across N bindings and conditionals.
  **Affine bindings are exempt** (may be dropped on early exit, per AFN). **Closure capture
  is the exception — see CLO below.**

---

## 3. Capabilities *(verified, Test C confirmed zero friction)*

- **Requirements, not arguments:** functions declare needed authority in the signature
  (`using Fs`); callable only in a context that supplies it; satisfied by `with`. Resolved
  at compile time, desugaring to threading (no-magic).
- **No ambient authority; no `env` grab-bag:** `main` declares its requirements; the
  **runtime** is the supplier and the sole root of physical authority. A capability absent
  from `main`'s requirements (and not minted downstream) is unreachable — visible in one
  signature.
- **Strict resolution (Option A):** exactly one capability of a type per scope, or compile
  error. Different types coexist; same-type duplicates must be scoped apart.
- **Import gives code, never authority:** `import fs` brings functions/types; power comes
  only from a held capability. The supply-chain property.
- **Two kinds:** *authority-bearing* (root: runtime; e.g. `Fs`, `Net`) and *permission*
  (root: a **mint** capability held by the designated issuer; e.g. `ChargeCard`).
  Permission caps are opaque and unforgeable, **not** no-ops.
- **Composition = sets of atoms:** atoms (`Read`, `Write`, `Net`…), **bundles** (`Fs = Read
  + Write + …`), and **projection** (keep a subset; can only remove). One mechanism + its
  inverse. **v1 guard:** atoms + flat bundles + projection only; no lattice.
- **Mint vs. typestate are different axes:** mint = *creation of a new value* (minter
  persists); typestate = *transformation of one value* (same identity, new state). They
  compose (a minted cap can be typestated).
- **Open fork (§5.5):** does holding a bundle (`Fs`) auto-satisfy a member requirement
  (`using Read`), or must you `project` first? Leaning explicit (project first).

---

## 4. Typestate and event-driven state *(verified for local calls; model extended by Test C)*

- **Local-call transitions (verified):** a value's state is part of its type; operations
  illegal in a state don't exist. `send` on `Tcp<SynSent>` won't compile. The headline
  demo.
- **EVT rule (Test C — the major addition):** transitions whose outcome depends on **remote
  events or races** cannot be expressed by a call signature (the outcome isn't known at
  compile time). They return a **sum type over the possible next-state typed handles**, and
  the caller **must `match`** to obtain a usable handle. Typestate governs *legality within
  a state*; sum-over-states governs *event-driven movement between states*. No new machinery
  (sum types exist) — but the **combination rule** is core and load-bearing. Real protocols
  are event-driven, so this is the common case, not a corner.

---

## 5. Closures over linear values *(Test E3 — known hard intersection)*

- **CLO rule:** capturing a linear value is **`FnOnce`-style** — consumed at most once — and
  **moves** the binding, which therefore cannot be rebound afterward. A `mut` linear binding
  **cannot** be captured and remain live for further rebinding. *(This is the linear +
  mutation + closures intersection that every substructural language must constrain; FIT's
  answer is the FnOnce-move rule.)*

---

## 6. The one real interaction conflict, and its resolution *(Test F)*

**EVT × mut-linear conflict:** a `mut` binding rebinds within *one* type; an event-driven
transition changes the *type* (state). So a **loop that continues across a state change is
not expressible with `mut`.** Pairwise, CLO×EVT and AFN×EVT compose cleanly; this is the
sole conflict.

**Resolution (recommended): the recursion idiom.** Model stateful protocols as
**tail-recursive functions, one per state**, each taking the precisely-typed handle. The
"loop" becomes the call graph; no type-changing `mut` needed. This is the textbook typed
state-machine encoding, needs **no new core machinery**, and dissolves the conflict.

**Honest consequence for FIT's identity:**
> **Loops iterate data (unrestricted values); recursion advances state machines
> (type-changing handles).** A clean division — but it must be taught explicitly, and it
> dents the "beginners just write loops" intuition for the protocol domain FIT most wants.

**Open fork:** accept the recursion idiom (recommended, lean) vs. invest in
*state-polymorphic loops* (a value typed as a sum of states, matched each iteration — more
power, heavier core). **This is the next genuine design decision.**

---

## 7. Error model *(verified)*

- Errors are values (sum types); no exceptions.
- A function's error type is the **union** of its failure modes — visible in the signature
  (the audit surface, applied to failure).
- A failed **consuming** operation returns its resource in a **declared failure typestate**
  carried in the error (e.g. `Tcp<Failed>`), so cleanup is always possible and visible. *(No
  flat opaque `Poisoned`; the failure state carries what cleanup needs — but per Test D's
  lesson, disposal cost lives in the type, e.g. a secret's `cleanup` is "zeroize," declared
  once.)*
- **Aggregation (reasoned, §7.1 — needs its own test):** named **transparent** union
  aliases + implicit widening, never erasure. No `anyhow`-style hatch.

---

## 8. Deferred / out of scope

- **Async & concurrency:** deferred past v1. Intended direction: capability-gated suspension
  + concurrency-as-region; explicit yield points (no hidden scheduler). Not designed.
- **Regions for cyclic/aliased linear structures:** the bounded relaxation that permits
  internal aliasing, consumed as a unit. Principle settled (distinct, no-runtime-magic);
  detailed semantics not yet tested against a real cyclic program (e.g. a connection pool
  with mutual references).
- **Frontend:** not a target. Different domain.
- **Constraint/logic solving (original Category 1):** set aside; FIT is the pragmatic
  systems language.

---

## 9. Evidence ledger

**Verified by hand-written test against real/realistic programs:**
core memory modes; unrestricted & linear (file copy); cross-domain generality (server,
pipeline); `mut` orthogonality + `mut`×linear (Test A); R1, R2, R3, R6; capability
ergonomics (TCP, zero friction); local-call typestate (TCP); EVT necessity (TCP); AFN
sharpening (Test D); R4 generalization (Test E); CLO break (Test E3); rule interactions
(Test F: EVT×mut break, CLO×EVT pass, AFN×EVT conditional pass).

**Reasoned, not yet keyboard-tested:**
affine cells beyond the lease example; error-union aggregation (§7.1); region detailed
semantics; the recursion idiom against a *full* multi-state protocol (only argued, not
written end-to-end).

**Open forks (decisions, not gaps):**
1. Bundle membership auto-satisfies a requirement, or must `project` first? (lean: project)
2. Recursion idiom vs. state-polymorphic loops for stateful protocols? (lean: recursion)
3. `using` overloaded (resource binding vs. capability requirement) — keep or disambiguate?
4. Async model (deferred, direction noted).
5. Ordered disposal on the error path (deferred until a real program needs it).

---

## 10. The honest meta-status

Four rounds. The **core never broke** — every memory-mode, capability, and disposal claim
held or was sharpened. What testing did was **discover what the core doesn't yet cover**:
event-driven state, closure capture, affine soundness, and one real rule-interaction
conflict — all resolved **without new core machinery**, via composition rules and one idiom.

The cost of honesty: the simplicity pitch evolved from "one mechanism, several hats" to
**"one core + a small fixed rule set + the recursion idiom."** That is the true claim. It is
still a small, coherent language — but anyone evaluating FIT should weigh it against that
accurate description, not the original slogan.

**The single most valuable thing still undone:** write **one complete, multi-state real
protocol end-to-end** (TCP or HTTP/1.1 keep-alive) using the recursion idiom + EVT + the
full error model, and see whether the *whole* thing reads cleanly or whether the pieces,
correct individually, are unpleasant in combination. Every prior round tested a slice; the
integration test is the one that hasn't been run.
