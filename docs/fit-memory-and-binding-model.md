# FIT — The Memory & Binding Model

> **Status:** the cells in this document are populated **only** from cases verified in the
> file-copy test, the cross-domain checks (server, pipeline), and the `mut`/disposal tests.
> Where a cell is reasoned but not yet keyboard-tested, it is marked **(unverified)**.
> Syntax is illustrative; surface forms (`mut`, `using`, `cleanup`, mode keywords) are not
> final.
>
> This is the densest part of FIT and the easiest to get subtly wrong. It is deliberately
> a matrix with a worked example per cell, not prose.

---

## 1. Two independent axes

FIT separates **what a value is** (its memory mode) from **how a name is used** (its
binding mode). These are orthogonal — confirmed by Test A, where `mut` behaved identically
over unrestricted and linear values, differing only in what the *value's* mode required.

### Axis 1 — Memory mode (a property of the **value / type**)
| Mode | Use count | May be silently dropped? | Copyable? | Exists to… |
|------|-----------|--------------------------|-----------|------------|
| **unrestricted** | any (0..∞) | yes (nothing to release) | yes | carry plain data with zero ceremony |
| **affine** | at most once (0 or 1) | yes (drop = no-op) | no | model "optional consumption" — the relief valve |
| **linear** | exactly once (1) | **no** (must be consumed) | no | guarantee a resource/obligation is discharged once |

### Axis 2 — Binding mode (a property of the **name**)
| Mode | Meaning | Is it a memory mode? |
|------|---------|----------------------|
| **(plain `let`)** | name bound once to one value | no |
| **`mut`** | name **rebound** with each result: each step *consumes the old value and binds a new one* | **no** — it's a binding modifier |

**The central claim (verified, Test A):** `mut` is *not* a fourth memory mode. It composes
with all three memory modes. The model is therefore a **3 × 2 matrix**: {unrestricted,
affine, linear} × {plain, mut}.

---

## 2. The default, and why

**Unrestricted is the default.** A value is only `affine`/`linear` if its type declares it.
Rationale (made explicit, since it was previously assumed): tracking a value earns its cost
only when there is something to *release* (a resource) or an invariant that forbids
*duplication* (a secret, a capability, a one-shot token). A parsed record or an integer has
neither, so tracking it buys nothing and taxes every line. Linearity is a tool you reach
for at the points that need it, not a blanket tax.

**Corollary that prevents a common confusion (Test §A):** *being used once* does not make a
value linear. `let line = read_line(src)?` used once in a loop body is **unrestricted that
happens to be used once** — nothing forbids using it twice. A `linear` value is one the
compiler *forbids* from being used more than once. Coincidental single-use ≠ enforced
single-use.

---

## 3. The 3 × 2 matrix — a worked example per cell

### Row: plain `let` binding

| Memory mode | Worked example | Notes |
|-------------|----------------|-------|
| **unrestricted** | `let n = 42` then use `n` anywhere, any number of times | trivial; the everyday case |
| **affine** | `let token = try_acquire()?` — an optional lease you *may* use or *may* let lapse | if unused, dropped at scope exit, no error |
| **linear** | `let file = open(p)? cleanup close` — must be consumed exactly once | requires a disposal path (`cleanup` or thread-out); leak = compile error |

### Row: `mut` binding

| Memory mode | Worked example | Verified? |
|-------------|----------------|-----------|
| **unrestricted** | `let mut stats = Stats::zero(); stats = stats.count()` — consume old, rebind | ✓ (pipeline test) |
| **affine** | `let mut lease = none_lease; lease = renew(lease)` — may also be dropped if never rebound again | reasoned; **(unverified)** as a standalone test, but follows from affine + mut both holding |
| **linear** | `let mut conn = c; conn = send(conn, item)?` — each step consumes once, rebinds | ✓ (Test A) |

**Reading the `mut` row:** in every cell `mut` does the same thing — *rebind the name with
the result*. What differs per column is entirely the **value's** obligation: unrestricted
need not be rebound (could be ignored), affine may be dropped, linear **must** be consumed
(so each `mut` step's consuming call is what discharges the exactly-once duty).

---

## 4. Interaction rules (the cells where things get subtle)

These are the rules that make the matrix sound. Each is tied to the test that established
it.

### R1 — Linear values must have a disposal path *(file-copy test)*
A `linear` value must, on every control-flow exit, be either (a) consumed by a call that
takes ownership, (b) disposed by a declared `cleanup`, or (c) threaded out in the return
(incl. the error). Anything else is a compile error: "linear value not disposed."

### R2 — Linear arguments to fallible functions must be caller-owned *(file-copy / handshake)*
A `linear` value passed **into** a fallible function must be owned by a `using` binding (or
equivalently threaded back out), so its error-path disposal is guaranteed. A *bare* linear
argument to a fallible function — with no owner and no return path — is a compile error.
This is the corrected, generalized form of the original "§7.2" rule: the issue was never
*how many* resources, but whether each linear value in flight has an owner.

### R3 — `cleanup` fires only for values *still owned* at exit *(disposal test)*
If a value is moved out (consumed by a call, or explicitly closed) before scope exit, its
`cleanup` does **not** fire — linearity's move-tracking already knows it's gone. This is
what makes explicit ordered disposal (R6) compatible with automatic `cleanup`: manually
closing a resource removes it from the cleanup set, so there's no double-free.

### R4 — `?` threads the **current** value of a `mut` linear binding *(Test A — NEW rule)*
When `?` triggers an early exit inside a function holding a `mut` linear binding, the value
threaded into the error path is the binding's **current** value (after prior rebinds), not
the original. Without this stated, a mid-loop failure would thread the wrong (already-
consumed) value. With it, the matrix's `mut`×`linear` cell is sound.

### R5 — `mut` is unobservable-rewrite only *(no-magic boundary)*
Whether the compiler implements `mut` as true in-place mutation or as consume-and-rebind is
an implementation detail **only because it is unobservable** (single live value, no
aliasing). The moment a mutation became observable through aliasing, it would be hidden
runtime behaviour and is forbidden. So `mut` never introduces aliasing; it is always
semantically "rebind with result."

### R6 — Disposal order is LIFO unless made explicit *(disposal test)*
Multiple `using` bindings dispose in reverse acquisition order (LIFO). When a program needs
a disposal order **decoupled** from acquisition (rare; typically across function
boundaries), it closes resources explicitly in the body in the required order; R3 then
ensures the automatic `cleanup` only handles whatever remains. **Open residue:** this does
not guarantee *ordered* disposal if an error interrupts the manual sequence. No primitive is
added for that until a real program needs guaranteed ordered disposal on the error path.

---

## 5. How the modes relate (the mental model)

A single spectrum by *obligation strength*:

```
unrestricted  ──────────  affine  ──────────  linear
 (no duty)              (may consume)        (must consume)
 ignore freely          drop or use once     use exactly once
 copy freely            no copy              no copy
```

- **unrestricted → affine:** add "can't duplicate," keep "can ignore." For values where
  copying is wrong but forgetting is fine.
- **affine → linear:** add "can't ignore." For values where forgetting is a bug (a resource
  leak, an undischarged obligation).
- **`mut`** sits on *top* of any of these, modifying the *name*, never the value's place on
  the spectrum.

**The one-sentence model:** *the value's mode says how many times it must be used; `mut`
says the name will be rebound as it's used; nothing about `mut` changes the value's duty.*

---

## 6. Documentation checklist (for the eventual language reference)

When this is written up formally, every item below needs a runnable example, because each
is a place the model can be subtly misread:

1. unrestricted-used-once is **not** linear (the coincidental-vs-enforced distinction).
2. affine as the relief valve — when to choose it over linear.
3. The `mut` row of the matrix — that it means the same thing in every cell.
4. R2 (caller-owned linear arguments) with the compile-error message a user actually sees.
5. R4 (`mut` linear `?` threads current value) — the non-obvious one.
6. R3 + R6 together — explicit close removes cleanup obligation; ordered disposal.
7. The unverified cells (`mut affine`) flagged until a test confirms them.

---

## 7. What is verified vs. open

**Verified by test:** unrestricted×plain, linear×plain (file copy), unrestricted×mut
(pipeline), linear×mut (Test A); rules R1, R2, R3, R6; the orthogonality of `mut`.

**Reasoned, not yet keyboard-tested:** affine×plain and affine×mut (follow from the model
but lack a dedicated falsification test); R4 stated but only exercised in one loop shape.

**Open residue:** guaranteed ordered disposal on the error path (R6) — deferred to a real
program, with the unmet condition now precisely characterized.

**Honest status:** this matrix is the most load-bearing and most fragile part of FIT.
Two test rounds resolved every "break" by *removing* machinery or adding a *single* rule
(R4). That track record is the reason to trust it — but the affine cells and R4's
generality are the next things a skeptic should try to break.
