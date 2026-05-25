# FIT (typestate-demoted) vs. Austral — Honest Side-by-Side

> **Grounding:** Austral details below are from its current spec, tutorial, and Borretti's
> articles (austral-lang.org, borretti.me), verified at time of writing — not from memory.
> FIT is the post-Option-1 design (typestate demoted to an opt-in pattern).
>
> **Why this comparison is uncomfortable:** several things we believed we *designed* for FIT
> turn out to be Austral's exact, already-shipped decisions. A few are genuinely different.
> The goal is to find whether the *differences* justify a new language, or whether FIT
> (demoted) is a re-derivation of Austral. Brutal honesty is the point.

---

## 1. The overlap nobody can wave away

These are FIT tenets we developed across this session that are **already Austral, shipped**:

| Concept | FIT (what we "designed") | Austral (what exists) |
|---------|--------------------------|------------------------|
| Linear types as the core | unrestricted default; linear opt-in for resources | **Identical** — "free universe" (unrestricted) vs "linear universe"; linear = use exactly once |
| Capabilities = linear/unforgeable values | unforgeable, granted-never-conjured, passed explicitly | **Identical** — "unforgeable proof of permission… cannot be acquired out of thin air… must be passed by the client" |
| No ambient authority / supply-chain safety | import gives code not authority | **Identical** — capabilities constrain third-party deps against supply-chain attacks |
| No GC | by tenet | **Identical** — no GC, memory safe without runtime overhead |
| No exceptions; errors as values | sum-type errors, failures in signature | **Identical** — Austral rejects exceptions explicitly; linear types force result-code checking |
| "Read it and know what it does" | readable-without-comments tenet | **Identical** — "a programmer should be able to say exactly what it does… down to the assembly" |
| Small core, fits in your head | a stated goal | **Identical, and SHIPPED** — 100-page spec, <600-line linearity checker |
| No implicit anything | no-magic tenet | **Austral is MORE extreme** — no implicit conversions, no operator precedence, no implicit calls |

**This is not partial overlap. On the core thesis, FIT-demoted ≈ Austral.** The "visible
authority + visible disposal + no GC/exceptions/ambient, small and readable" pitch is, line
for line, Austral's published pitch from 2022.

---

## 2. Where FIT and Austral genuinely DIFFER

Now the differences that actually exist — and whether they're improvements, regressions, or
just different trades.

### 2.1 Memory mode: linear-only (Austral) vs. linear + affine + unrestricted (FIT)
- **Austral:** *plain linear* with **explicit destructors**. Deliberately **rejected affine
  types** because affine is "use at most once" → values silently discarded → compiler
  auto-inserts destructor calls = an **implicit function call**, which Austral forbids on
  principle. Austral's stance: linear forces you to handle things; affine lets you forget.
- **FIT:** we made **affine a first-class mode** and even leaned on it (the "relief valve").
- **Verdict:** this is a **real difference, but Austral has the stronger principled
  position.** Our affine mode reintroduces exactly the implicit-destructor behavior
  (Test D's "drop must be a no-op") that Austral rejects to keep "no implicit calls" pure.
  **Austral's choice is more consistent with our OWN no-magic tenet than our choice was.**
  This is a place we were *less* rigorous than the existing language. Uncomfortable, but true.

### 2.2 Borrowing: present (Austral) vs. absent (FIT)
- **Austral:** **has borrowing** — a simplified, lexical-region version of Rust's, ~part of
  the 600-line checker, via an explicit `borrow x as ref in R` construct. It exists to
  *recover ergonomics* (read-only / mutable refs, permission degradation) without giving up
  linearity.
- **FIT:** we **dropped borrowing** early, deliberately, to stay simple — and then spent
  multiple rounds re-deriving its *benefits* badly (threading sugar, the `using c = c` wart,
  the disposal-order problem). **Austral already solved the thing our no-borrow stance kept
  re-breaking.**
- **Verdict:** **Austral is ahead here, and our omission caused real pain.** Our entire
  "thread the resource through every call" verbosity — and the cleanup warts — are *exactly*
  the problem borrowing exists to solve. We rejected the solution and then suffered the
  problem. This is the most damning single finding in the comparison.

### 2.3 Typestate: opt-in pattern (both, effectively) — and the thing we just KILLED
- **Austral:** no built-in typestate. You model protocols with linear types + distinct
  structs (the same "pattern" we landed on in Option 1). Borretti has *written about*
  typestate-style encodings but the language does not enforce them as a core feature.
- **FIT (now):** identical — typestate demoted to "make distinct structs."
- **Verdict:** **after demotion, FIT and Austral are the SAME here too.** The one thing that
  made FIT feel distinctive — *typestate as a first-class, compiler-enforced pillar* — is the
  thing we removed because it generated every contradiction. So FIT's distinctiveness died
  with it. **This is the crux of your "is it just Austral" worry, and the answer is: with
  typestate demoted, largely yes.**

### 2.4 Error model nuance: FIT's "failure-state-in-the-error" vs. Austral's plain linear results
- **Austral:** linear types force you to consume/check a `Result`-like value; if a resource
  is in flight when an op fails, you thread it back (the verbosity Austral openly accepts).
- **FIT:** we added "a failed consuming op returns its resource in a declared failure state
  carried in the error." With typestate demoted, this **collapses back toward Austral's
  model** (the resource just comes back in the error tuple; no rich failure typestate).
- **Verdict:** **post-demotion, near-identical.** Our nuance was a typestate feature; without
  typestate-as-core it mostly dissolves.

### 2.5 Capabilities: composition model (a possible FIT delta)
- **Austral:** capabilities are linear values, passed explicitly as **arguments** (consumed
  by being passed). Fine-grained (per-host, per-socket, read/write).
- **FIT:** we designed capabilities as **signature requirements** (`using Fs`) resolved at
  compile time, with **bundles + projection** (atoms compose into `Fs`, project to narrow),
  and **strict same-type resolution**. This is a genuinely different *ergonomic surface*
  over the same underlying idea.
- **Verdict:** **this is FIT's most plausible real difference.** Austral passes capabilities
  as explicit value arguments (more verbose, more visible); FIT's "declare as requirement,
  compiler threads it" is a real ergonomic alternative — *if* it holds up (and we flagged
  open forks: bundle-membership resolution, the `using` keyword overload). BUT: note that
  "compiler threads the capability for you" is an **implicit function call / implicit
  argument** — the exact thing Austral forbids and we claimed to forbid. So FIT's one
  distinctive capability idea **may violate FIT's own no-magic tenet**, the same way affine
  did. Needs scrutiny, not celebration.

---

## 3. Austral's anti-features list vs. FIT's

Austral publishes an explicit anti-features list. Comparing it to FIT's implicit one is
revealing:

| Austral says NO to | FIT's stance |
|--------------------|--------------|
| GC | same (no) |
| Destructors | **FIT says YES** (intrinsic cleanup) — divergence, and Austral would call ours an implicit call |
| Exceptions / surprise control flow | same (no) |
| Implicit function calls | **FIT violates this twice** (affine drop, capability auto-threading) |
| Implicit conversions | same (no) |
| Global state | same (no) |
| Subtyping | same (no) — though our capability bundles flirt with it |
| Type inference (bidirectional only) | **FIT leaned on more inference/sugar** — divergence toward more magic |
| First-class async | both defer/avoid |

**Pattern:** every place FIT diverges from Austral, FIT diverges **toward more implicit
behavior** — destructors, affine auto-drop, capability auto-threading, more sugar. Given
that **no-magic was FIT's loudest tenet**, this is the single most important finding in the
whole document: *FIT's differences from Austral are concentrated in exactly the area FIT
claimed to care most about, and they make FIT worse by its own standard.*

---

## 4. Pros and cons, as each stands today

### Austral — PROS
- Shipped, implemented, spec complete, compiler exists (<600-line checker proves the
  simplicity claim is *real*, not aspirational).
- Internally consistent: the anti-features list is principled and held to.
- Borrowing solves the ergonomics our no-borrow stance kept re-breaking.
- Battle-tested reasoning (public critique, HN/Lobsters review, years of refinement).

### Austral — CONS
- Verbose by *explicit design* ("we sacrifice terseness for simplicity") — threading linear
  values is acknowledged as tedious.
- No typestate enforcement — protocol-ordering safety is opt-in pattern, not guaranteed.
- Lexical-region borrowing is less expressive than Rust (some valid programs rejected).
- Small ecosystem, niche adoption.

### FIT (typestate-demoted) — PROS
- The capability-as-requirement + bundle/projection model is a **genuinely different
  ergonomic surface** (less verbose than Austral's argument-passing) — *the one real
  candidate for novelty.*
- Intrinsic per-type cleanup is more ergonomic than Austral's explicit destructors at every
  site (INT-2 fix) — *if* we accept the implicit-call cost Austral rejects.
- We could choose to KEEP affine for ergonomics where Austral refused — a deliberate
  different trade.

### FIT (typestate-demoted) — CONS
- **Not implemented. Zero lines exist.** Austral is the same idea, shipped.
- Every divergence from Austral pushes toward *more magic*, contradicting FIT's core tenet.
- We re-derived (badly) several things Austral already solved (borrowing's benefits).
- With typestate demoted, **the distinctive thesis is gone**; what remains is "Austral with
  a different capability syntax and more implicit behavior."

---

## 5. The honest bottom line

**Is FIT-demoted just Austral?** For the *core* (linear + capabilities + no-GC/exceptions/
ambient + small/readable): **yes, substantially.** We independently re-derived Austral's
exact thesis. That's not embarrassing — it's *convergent validation* that the thesis is
sound — but it means FIT-demoted is **not a new language, it's a re-implementation of an
existing one with different ergonomic choices**, and those choices mostly trend toward the
"magic" FIT swore off.

**What's genuinely left as potential FIT novelty, post-demotion:**
1. The **capability-as-requirement + bundle/projection** ergonomic model (vs. Austral's
   explicit value-passing) — real, but needs to survive the no-magic test it currently fails.
2. **Intrinsic cleanup** — real ergonomic win, but it's "destructors," which Austral rejected
   on principle. So it's a *trade*, not a clear improvement.

**Two things are simultaneously true:**
- Demoting typestate *fixed FIT's coherence* (Option 1 worked).
- Demoting typestate *also removed FIT's reason to exist as distinct from Austral.*

**Which lands us exactly at your instinct.** The typestate-first state machine was the blow,
and it was *the* differentiator. So the real fork is now stark and clear:

- **Path A — Resurrect typestate WITHOUT the baggage.** The only path where FIT is a *new*
  language rather than an Austral variant. The question (yours, and worth attempting): can
  typestate be compiler-enforced without dragging in EVT-as-a-rule, the recursion mandate,
  TCO, and the cleanup warts? If yes, FIT has a genuine reason to exist that Austral does
  *not* occupy. If provably no, then —
- **Path B — Accept that FIT-demoted is Austral, and either contribute to Austral or stop.**
  Intellectually honest, and not a failure: we'd have learned the design space deeply and
  confirmed Austral occupies the good local optimum.

**My read:** the comparison makes Path A the *only* justification for FIT continuing as its
own language. Everything else we "designed" already exists, often done more rigorously. So
the next move should be a focused, honest attempt at Path A — *typestate as a compile-time
guarantee without the control-flow baggage* — with a hard willingness to conclude Path B if
it can't be done. That attempt is worth making precisely because, if it succeeds, it's the
one thing here that Austral isn't.
