# FIT — Error & Capability Model, First Syntax (Draft 1)

> **Status:** Exploratory. Session-derived, not final. This is the first time FIT has
> been written as concrete code rather than described abstractly. Syntax shown is
> **illustrative** — we are designing *principles* now; surface syntax is explicitly
> deferred. Two findings emerged from writing code: §3 (a refinement) and §7.2 (an edge
> that is now resolved in principle but untested against real code).
>
> **Changes from Draft 0:** capabilities are no longer value-threaded arguments — they
> are **signature requirements** (§5). The `env` grab-bag is **gone** (§5.4). The §7.2
> "total by faith" stopgap is **replaced** by declared failure-typestates (§7.2). New
> capability-model section added (§6: mint vs. typestate, composition rules).

---

## 1. The problem the error model exists to solve

A **linear** value is in flight — you hold it, mid-pipeline — and an operation fails.

- Linearity says the value must be consumed **exactly once**.
- An error means the normal consuming path **didn't complete**.
- The value is now in limbo: not consumed (leak / linearity violation) and not validly
  advanced (the operation failed).

No borrows (FIT dropped them) and no silent drop (linearity forbids it). So: **where
does the value go?** Every error decision below is downstream of that one question.

---

## 2. Locked tenets feeding this

- **One substructural core.** Unrestricted values by default; `linear` / `resource` /
  `capability` are opt-in properties of a type.
- **No ambient authority.** All authority — physical or organizational — is *granted,
  never conjured*. (The single invariant that never bends.)
- **Typestate.** A value's type changes as its state changes; operations illegal in a
  given state do not exist (won't compile).
- **Errors are values.** Sum types, no exceptions.
- **No runtime magic.** Nothing executes at runtime that isn't visible in source. Sugar
  (compile-time desugaring, zero runtime cost) is allowed; hidden runtime behaviour is
  not. **Test:** sugar may eliminate *plumbing*; it may never eliminate a *cost* or a
  *decision*.
- **Regions.** A bounded, named relaxation permitting internal aliasing (for cyclic
  linear structures), consumed as a unit at block exit.
- **Readable without comments.** You should be able to follow a program by reading it.

---

## 3. Refinement: **unforgeable ≠ linear**

Hello-world forced this. You write to stdout *many times*, so the console capability
**cannot be linear** (use-once) — yet it must still be **unforgeable**. So "capability"
splits into two independent properties:

| Property        | Meaning                                           | Example                          |
|-----------------|---------------------------------------------------|----------------------------------|
| **Unforgeable** | No public constructor; only granted, never conjured | `Console`, `Fs`, `Net`        |
| **Linear**      | Must be consumed exactly once                     | `File`, `Connection<S>` (resources) |

Consequence: `Console`, `Fs`, `Net` are **unforgeable but unrestricted** (reusable,
freely available in-context). A `File` is a **linear resource** *minted by* `Fs`. The
authority to open is reusable; the opened handle is use-once.

---

## 4. The error model

### 4.1 Failures visible in the signature (audit surface)
A function's error type is the **union** of how it can fail. The capability
audit-surface idea applied to failure: *read the type, know every way it breaks.*

```fit
fn read_config(path: String) using Fs
    -> Result<Config, OpenError | ReadError | ParseError>
```

No `NetError` in the union → provably cannot fail by network. Mirrors "no `Net` in the
requirements → provably can't touch the network."

### 4.2 Scoped, declared cleanup (`using … cleanup …`)
Cleanup is named **at acquisition**, in source. The compiler enforces it runs **exactly
once on every exit path**. This is the no-magic form of RAII: you *wrote* `close`, so
it's not hidden; the compiler only guarantees execution.

> Note: `using` is used in two distinct roles in FIT — a **resource binding**
> (`using file = open(...) cleanup close { }`, this section) and a **capability
> requirement** in a signature (`fn f() using Fs`, §5). Same keyword, related spirit
> ("operating with X"); final syntax may disambiguate. Flagged, not yet resolved.

### 4.3 The propagation rule (the freshman-legible heart)
> **You cannot leave a scope while still holding something you haven't said how to put down.**

An early error-return (`?`) is permitted only when every in-scope linear value either
has a declared `cleanup` or is threaded into the returned error. "Early-return while
holding an undisposed linear value" does not compile. That one sentence is the entire
linearity-meets-errors rule.

### 4.4 Implicit threading — **sugar, not magic**
With no borrows, a consuming op must hand its resource back to keep it usable. Writing
that by hand is the verbosity tax. Inside a `using` block, FIT lets you write as if the
resource survives and **desugars** to explicit re-threading at compile time — zero
runtime cost, mechanical, inspectable (§8.2 shows the desugaring). Passes the no-magic
test: eliminates plumbing, not a decision.

---

## 5. The capability model — requirements, not arguments

### 5.1 Capabilities are signature *requirements*
A function does **not** take capabilities as positional value arguments. It **declares
the authority it needs**, and may only be called in a context that supplies it. (Closest
prior art: Scala `using`/`given`, effect rows — but resolved at compile time, see 5.3.)

```fit
fn save_log(line: String) using Fs {
    fs.write("log.txt", line)?     // needs Fs; we're in an Fs context; satisfied
}
```

No token is named or passed. A callee needing the same capability is satisfied by the
caller's context automatically — requirements **propagate**.

### 5.2 `with` supplies a capability to a scope
```fit
with disk {                 // bring an Fs capability into context
    save_log("started")     // its `using Fs` is now satisfied
}
```
`with` does **not** create authority — it moves into context something you already hold.
You cannot `with` your way to power you were never granted.

### 5.3 Strict resolution (Option A — locked)
Resolution is **compile-time** and desugars to threading (no-magic; same category as
§4.4). The rule: **exactly one capability of a given type in scope, or it does not
compile.** No silent precedence, no dynamic handler lookup.

- Multiple capabilities of **different** types coexist freely (`Fs` + `Net` + `Console`)
  — "which one?" has one answer per type.
- Two of the **same** type in one scope is a **compile error**; you must scope them
  separately (nested `with`) so each call sees exactly one.

Rationale: a hidden *decision* rule (lenient precedence) crosses the no-magic line and
defeats "readable without comments." Strict turns an ambiguity into a compile error —
the trade FIT makes everywhere. The cost (genuine multi-cap-of-one-type cases need
nested scoping) lands exactly where logic is genuinely doing two things, so the
verbosity earns its place.

### 5.4 No `env` grab-bag — `main` is just the root case
There is **no** god-object holding all authority. `main` declares its built-in
requirements like any other function; the **runtime** is the one entity that satisfies
them:

```fit
fn main() using Console, Fs {
    greet()                  // needs Console — satisfied
    save_log("started")      // needs Fs — satisfied
}
```

`main` is not special-cased — it is simply *the boundary where the runtime, rather than
a caller, supplies the requirements*. A capability absent from `main`'s requirements
(and not minted downstream from one present) is **unreachable** — the ultimate audit
surface, visible in one signature.

### 5.5 Least authority — projection, the inverse of bundling
**Correction from Draft 1's first pass:** there is no separate "derive a narrow cap from
a broad one" mechanism. The atoms are the *narrow* powers; broad caps are **bundles** of
them. `Fs` is not an indivisible thing that `Read` is carved from — `Fs` *is* the bundle
`Read + Write + Append + Delete`. So "narrowing" is simply **holding fewer members**, and
the operation that produces a narrower cap is **projection**: select a subset of what you
already hold. (Verb `project` is a placeholder — naming deferred.)

```fit
capability Read                        // atomic powers
capability Write
capability Append
capability Delete
capability Fs = Read + Write + Append + Delete    // a bundle of atoms

fn read_cfg(p: String) using Read { fs.read(p)? }            // needs only Read
fn save(p: String, d: Bytes) using Write { fs.write(p, d)? } // needs Write

fn main() using Fs {
    let ro: Read = project(currentFs, Read)   // pick the Read member out of Fs
    with ro {
        read_cfg("c.txt")     // ✓ holds Read
        save("c.txt", bytes)  // ✗ COMPILE ERROR: needs Write; only Read in scope
    }
}
```

Projection can only ever **remove** members — you cannot project authority you do not
hold. So there is **one** structure (capabilities are sets of atoms) viewed two ways:
**bundle** (combine atoms) and **project** (keep a subset). Draft 1's "two composition
directions" was an over-count; it's one mechanism and its inverse.

**Open fork (membership vs. strict resolution) — to settle later.** If holding `Fs`
auto-satisfied `using Read` (because `Read ∈ Fs`), then a scope holding both `Fs` and a
standalone `Read` would have *two* satisfiers for `using Read` — violating strict's
one-satisfier rule (§5.3). Two resolutions:
- **(A) Membership does NOT auto-satisfy** — you must `project(Fs, Read)` explicitly
  before a `using Read` is met. Most explicit; "what satisfies this?" is answerable from
  what's literally named in scope; consistent with no-silent-re-widening. **Leaning (A).**
- **(B) Membership DOES auto-satisfy** — and holding `Fs` *and* a separate `Read` in one
  scope is the ambiguity compile-error strict already defines. Less verbose; requires
  knowing bundle contents to answer "what satisfies this?"

This is the same explicit-vs-convenient dial as §5.3, applied to bundle membership.
Unresolved; flagged for Opus (§9 Q3).

### 5.6 Import gives code, never authority
`import fs` brings the *functions/types*; it grants **no** power. `fs.write` is a
function that *requires* `Fs`. A function with no `Fs` requirement provably cannot write,
no matter what it imports. This is the supply-chain property: a transitive dependency
cannot touch the filesystem just by importing it.

---

## 6. Two kinds of capability; two axes; one composition (+ its inverse)

### 6.1 Authority-bearing vs. permission capabilities
| Kind | Roots at | Backs | Example |
|------|----------|-------|---------|
| **Authority-bearing** | the **runtime** | a real OS power | `Fs`, `Net`, `Console` |
| **Permission** | a **mint capability** | program/organizational policy | `ChargeCard`, `AdminAction` |

A permission capability has **no OS backing** but is **not** a no-op and **not**
transparent — it is **opaque and unforgeable**. "No OS backing" ≠ "freely creatable."
Its unforgeability is its entire value (a forgeable `ChargeCard` gates nothing).

**Invariant (carved in stone):** *all authority — physical or organizational — is
granted, never conjured.* Authority-bearing caps bottom out at the runtime; permission
caps bottom out at a mint capability held by whatever code the author designates as
issuer. Nothing bottoms out at *nothing*.

### 6.2 Mint vs. typestate — different axes (do not conflate)
- **Typestate** = *what can THIS value do now?* — the **lifecycle of one value**.
  Transformation: same identity, new state. `Connection<Handshaking>` → `Ready`.
- **Mint** = *may a NEW value be born at all?* — **generation of a second value**. The
  minter persists unchanged; a fresh token appears.

**Test:** after the operation, how many things, and is one of them what you started
with? Typestate → **one** thing, **same** thing, new state. Mint → **two** things,
original minter unchanged + brand-new token.

They are orthogonal, proven by the fact that they **compose** — a minted capability can
itself be typestated:

```fit
capability ChargeCard                                // permission token (no OS backing)
capability MintChargeCard                            // authority to ISSUE ChargeCards

fn issue() using MintChargeCard -> grants ChargeCard<Unused>   // mint: minter persists
fn charge(c: ChargeCard<Unused>, amt: Money) -> ChargeCard<Used>  // typestate: one-shot
```

Framing: **mint : capabilities :: constructor : ordinary values** (controlled creation —
FIT's twist is that creation itself requires authority). **typestate : value :: state
machine : process** (controlled transition). Creation vs. transition.

### 6.3 Capabilities are sets of atoms — one composition mechanism
**Corrected from the first pass.** Capabilities form **one** structure: a set of atomic
powers. Two operations on that one structure:
- **Bundle (`+`):** name a set of atoms/bundles. `Fs = Read + Write + Append + Delete`;
  `DbAdmin = Net + Fs + MintAuditToken`. Transparent — a bundle is *definitionally* its
  members; the compiler flattens it. Bundles may contain bundles.
- **Project (inverse of bundle):** select a subset of what you hold (§5.5). Can only
  ever *remove* members; cannot grant what you don't have.

There is **no** separate "derive narrow from broad" mechanism — narrowing is just
holding fewer atoms. "Two composition directions" in the first pass was an over-count.
Under strict resolution a bundle satisfying a member requirement is governed by the open
fork in §5.5 (membership auto-satisfies, or not).

**v1 complexity guard.** Atoms, flat bundles, and projection **only**. No
narrowing-then-rebundling-then-renarrowing algebra, no capability lattice with derived
ordering beyond plain set membership. Add depth later only when a real program demands
it. (Same discipline as deferring async and deep typestate hierarchies.)

---

## 7. Where it still hurts (honest findings)

### 7.1 Error-union bloat *(minimal answer proposed; needs validation)*
"Every failure visible" is beautiful small, a type zoo large (Rust's `Box<dyn Error>` /
`anyhow` tax). Proposed minimum machinery: **named, transparent union aliases + implicit
widening, never erasure.**

```fit
error ConfigError = OpenError | ReadError | ParseError   // alias is still the union
```

Rule: aggregation may **name** a union, never **erase** it. Widening (a variant into a
superset) may be implicit (only *grows* a known set); narrowing requires a `match`. Keeps
`?`-ergonomics while "read the type, know every failure" stays literally true. No
`anyhow` escape hatch — purist here, as with ambient authority.

### 7.2 Cleanup after a failed *consuming* operation — **resolved in principle, untested**
Surfaced by §8.3. Draft 0 used "`close` total over all states by faith"; that was a
creeping second model and is **replaced**. The fix: **split the resource's fate by
declaring the failure outcome as a typestate carried in the error.** Two physically
distinct failures:

```fit
// recoverable: resource returns UNCHANGED, in the error tuple
fn read_all(f: File) -> Result<(Bytes, File), (ReadError, File)>

// transitional: resource returns in a NEW typestate, in the error tuple
fn handshake(c: Connection<Handshaking>)
    -> Result<Connection<Ready>, (HandshakeError, Connection<Poisoned>)>
```

This is option (a) (resource in the error) **made non-verbose** by §4.4 sugar: the
`using` binding owns the resource, so the threading sugar absorbs the error-arm rebind —
the signature tells the desugarer which state the resource lands in on failure. Result:

- post-failure state **visible in the type** (no-magic ✓),
- the match **generated, not written** (non-verbose ✓),
- `close` total because `Poisoned` is a *declared* state with a real disposal path, not
  total "by faith."

Guardrail: a `Poisoned` value exposes **only** `close` (no resurrection to a live state)
— typestate enforces it. Why this does **not** create a second model: a failed operation
just yields a value in a different **typestate** (another value of an existing axis), not
a new *axis* (which is what colored-async would have been). Failure = the state machine
taking an edge you'd rather it didn't.

**Still required:** stress-test against a real `zp` handshake. The fix is now a concrete
claim to falsify, not an open hole.

---

## 8. The three programs

### 8.1 Hello world — *does capability ceremony bloat the beginner path?*
```fit
fn main() using Console {
    console.write("Hello, world!\n")
}
```
**Verdict: survives.** One concept beyond `print`: "`main` declares what the program may
touch; here, the console" — arguably *educational* (authority is visible). `Console` is
unforgeable-but-unrestricted, so no use-once threading intrudes. Freshman-readable at
this tier.

### 8.2 File read — *full error spine, with desugaring shown*

**Sugared (what you write):**
```fit
fn read_config(path: String) using Fs
    -> Result<Config, OpenError | ReadError | ParseError> {
    using file = open(path)? cleanup close {
        let raw    = read_all(file)?     // file rebinds; on error → close(file), propagate
        let config = parse(raw)?         // raw is unrestricted Bytes; file untouched
        config                           // success → close(file), config is block value
    }
}
```

**Desugared (what the compiler produces — proves no runtime magic):**
```fit
fn read_config(path: String) using Fs
    -> Result<Config, OpenError | ReadError | ParseError> {
    let file = open(path)?                       // open failed → return early, nothing acquired
    // cleanup armed: close(file) on every exit below
    let (raw, file) = read_all(file) else (e, file) -> { close(file); return Err(e) }
    let config      = parse(raw)     else e        -> { close(file); return Err(e) }
    close(file)
    Ok(config)
}
```
Everything visible: `read_all` returns `Result<(Bytes, File), (ReadError, File)>`
(recoverable form, §7.2), the sugar unpacks-and-rebinds, cleanup is plain calls on error
arms. Cleanest case — `read` failure returns `file` unchanged.

### 8.3 State machine — *the headline demo (typestate)*
```fit
resource Connection<S>      // S is the typestate parameter

fn connect(addr: Address) using Net  -> Result<Connection<Handshaking>, ConnectError>
fn handshake(c: Connection<Handshaking>)
    -> Result<Connection<Ready>, (HandshakeError, Connection<Poisoned>)>   // §7.2
fn send(c: Connection<Ready>, data: Bytes)
    -> Result<Connection<Ready>, (SendError, Connection<Poisoned>)>
fn close(c: Connection<S>)           // total over every declared state, incl. Poisoned
```

**Correct use:**
```fit
fn send_message(addr: Address, msg: Bytes) using Net
    -> Result<Unit, ConnectError | HandshakeError | SendError> {
    using conn = connect(addr)? cleanup close {
        conn = handshake(conn)?      // Handshaking -> Ready (or -> Poisoned on error, then close)
        send(conn, msg)?             // requires Ready; conn rebinds Ready
        unit
    }
}
```

**The 5-second demo — does not compile:**
```fit
using conn = connect(addr)? cleanup close {
    send(conn, msg)?     // ERROR: send requires Connection<Ready>,
}                        //        conn is Connection<Handshaking>.
                         // The operation does not exist in this state.
```
`conn` changes **type** across lines; typestate threading rides the same sugar as §8.2.
This compile error is solid and independent of §7.2.

---

## 9. Questions for Opus

1. **§7.2 (the crux), now resolved in principle.** Declaring failure outcomes as
   typestates carried in the error tuple — is this sound across a real protocol (e.g.
   `zp` handshake), or are there failure modes where the resource's post-failure state
   genuinely cannot be named (e.g. partial writes leaving indeterminate state)? Does the
   session-type / typestate literature confirm or complicate this?
2. **§7.1:** is "named transparent unions + implicit widening, never erasure" sufficient
   in practice, or does real code force an erasure escape hatch — and if so, can it be
   contained without becoming `anyhow`?
3. **§5.3 / §5.5 strict resolution + bundle membership:** is "exactly one cap of a type
   per scope" too rigid for real systems code? And the open fork — should holding a
   bundle (`Fs`) auto-satisfy a member requirement (`using Read`), or must you `project`
   explicitly first? Where does each choice bite?
4. **§4.4 / §5.3 sugar:** is the "eliminates plumbing, never a decision" line a robust
   definition of no-magic, or can you construct a case where implicit capability
   resolution smuggles in a decision?
5. **§6 coherence:** with mint + typestate + narrow + bundle all added, is "one
   substructural core, several hats" still honest, or has the capability model quietly
   become its own subsystem with independent rules?
6. **Dual `using` (§4.2 note):** resource-binding vs. capability-requirement share a
   keyword. Overload, or disambiguate? Does conflating them cause real ambiguity?

---

*Next step regardless of Opus: hand-write a real `zp`-style handshake in this syntax and
watch §7.2 hold or break. Paper elegance and keyboard reality diverge; only the second
is true.*

---

## 10. What FIT is, and what it is not (checkpoint summary)

A plain-language snapshot of where the design stands at this pause. Nothing here is
implemented; this is a *specification of intent*, validated only on paper.

### 10.1 What FIT is
- **A small systems language built on one substructural core.** "Some values are
  physical objects — you have exactly one, you can hand it away, then you don't have it."
  That single idea (linearity) underlies resources, capabilities, state machines, and
  regions.
- **Capability-secure by construction.** Authority is never ambient. A function can only
  do what its signature *declares it needs* (`using Fs`), and that need can only be met by
  a context that was *granted* the authority — tracing back to the runtime (for physical
  powers) or to a mint capability (for permissions). **Read the signature, know the blast
  radius.**
- **Typestate-first.** A value's type encodes its state; illegal operations in a state
  don't compile (call `.send()` before `.connect()` → not an error at runtime, a
  non-existent operation at compile time). This is the showable, five-second demo.
- **No-magic.** Nothing happens at runtime that isn't in the source. No GC, no hidden
  scheduler, no invisible cleanup, no ambient authority. Sugar may remove *plumbing*
  (implicit threading) but never a *cost* or a *decision* (failure states stay in
  signatures).
- **Errors as values, with failures visible in the type.** No exceptions. A function's
  error union states every way it can fail; a failed *consuming* operation returns its
  resource in a declared failure typestate (`Poisoned`) so cleanup is always possible and
  always visible.
- **Deterministic resource management without borrows.** Linear/affine values give
  predictable, GC-free cleanup; `using … cleanup …` guarantees disposal on every exit
  path. No lifetime annotations, no borrow checker.
- **Readable without comments, as a design tenet.** Signatures carry needs (capabilities),
  failures (error unions), and disposal (`cleanup`) — so the contract is legible from the
  type alone.
- **Aimed at:** systems tooling, data/transform pipelines, embedded/edge, secure and
  capability-restricted programs, protocol/state-machine-heavy code (the `zp` family of
  problems is the archetypal target).
- **Teachable to a strong beginner — at the base tier.** Hello-world is one concept beyond
  `print`. The physical metaphors (objects, keys, locked doors, disposable workspaces)
  carry the model.

### 10.2 What FIT is not
- **Not a borrow-checked language.** It deliberately rejects Rust-style lifetimes/borrows
  as too large a surface; it buys deterministic memory with linearity instead.
- **Not garbage-collected.** No tracing GC, by tenet (it would be invisible runtime work).
- **Not ambient-authority.** Importing a module grants *code*, never *power*. A
  dependency can't touch the disk or network just by being imported.
- **Not exception-based.** No `throw`/`catch`, no stack unwinding.
- **Not (yet) an async/concurrent language.** Async is **deferred past v1**; the intended
  direction is capability-gated suspension + concurrency-as-region, *not* colored
  functions or hidden schedulers. Out of scope for now, on purpose.
- **Not a constraint solver / logic language.** The original "declarative problem-solving"
  framing (Category 1) was set aside; FIT is the pragmatic systems language (Category 2).
- **Not a general-purpose applications language.** Not aimed at web frameworks, GUIs,
  business CRUD, or rich-ecosystem app development — different trade-offs.
- **Not maximally terse.** Capability-as-requirement and linear threading impose a real,
  accepted ceremony tax; FIT chooses visible authority and disposal over brevity.
- **Not a deep capability lattice.** v1 stays at atoms + flat bundles + projection. No
  algebra of derived orderings. Complexity is added only when a real program forces it.
- **Not freshman-complete.** Beginners can *read* FIT and understand *why* a wrong program
  is rejected; writing fluent FIT (linear collections, regions, failure typestates) is an
  intermediate-to-advanced skill kept off the beginner path.
- **Not validated.** Every claim above is paper design. The next real test — a hand-written
  `zp` handshake stressing §7.2 — has not been done.

### 10.3 The single invariant, if you remember nothing else
**All authority — physical or organizational — is granted, never conjured; and every
value is used exactly as many times as its type says.** Everything else (resources,
capabilities, typestate, regions, mint, error handling) is that one idea wearing
different hats.

### 10.4 Open forks at this pause (for the next session / Opus)
1. **§5.5** — does holding a bundle auto-satisfy a member requirement, or must you
   `project` explicitly? (Leaning explicit.)
2. **§7.2** — do declared failure-typestates survive a real protocol, or do some failures
   leave genuinely un-nameable states?
3. **§7.1** — is "named unions, never erasure" enough without an `anyhow`-style hatch?
4. **§4.2 / §9 Q6** — `using` overloaded for resource-binding *and* capability-requirement:
   keep, or disambiguate?
5. **Async** — confirm capability-gated + concurrency-as-region as the eventual model,
   still deferred.
6. **Reality** — write the `zp` handshake. Paper elegance ≠ keyboard reality.
