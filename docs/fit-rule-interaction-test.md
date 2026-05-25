# FIT — Test F: Do the Three New Rules Interact Cleanly?

> Round 3 added three composition rules. Individually each held. The danger with
> composition rules is **pairwise and triple interaction** — each is fine alone, but
> combined they may contradict or create undecidable cases. This test deliberately builds
> the worst-case program that triggers all three at once.
>
> The three rules under test:
> - **EVT** (from C): event-driven transitions return a **sum over next-state handles**;
>   caller must `match`.
> - **AFN** (from D): affine is legal **only if drop is a no-op**; real disposal ⇒ linear.
> - **CLO** (from E3): capturing a linear value is `FnOnce`-style and **moves** the binding
>   (no further rebind); a `mut` linear binding cannot be captured and remain live.

---

## F.1 The adversarial program: all three at once

A connection that (a) changes state on remote events (EVT), is (b) held in a `mut` linear
binding, and is (c) captured by a retry closure (CLO) — with (d) an affine speculative
token in the mix (AFN).

```fit
fn resilient_pump(mut c: Tcp<Established>, items: List<Bytes>) using Net
    -> Result<Tcp<Established>, (PumpError, Tcp<Failed>)> {

    let hint: affine SpeculativeHint = guess_window()      // AFN: drop must be no-op

    for it in items {
        // EVT: send's outcome may be data-driven (peer could have closed)
        match send_or_detect(c, it)? {
            Sent(c2)        => { c = c2 }                   // mut linear rebind (R4)
            PeerClosed(cw)  => {
                // c is now Tcp<CloseWait>, a DIFFERENT type than the loop expects
                return finish_closing(cw)                  // must exit loop; c-as-Established gone
            }
        }
    }
    Ok(c)
}
```

### F.2 INTERACTION BREAK #1 — EVT vs. mut linear binding
The loop's `mut c` is typed `Tcp<Established>`. But EVT says `send_or_detect` may return
`PeerClosed(Tcp<CloseWait>)` — a **different type**. A `mut` binding rebinds the *same
name*; can it rebind to a **different type**?

- If `mut c` is fixed at `Tcp<Established>`, the `PeerClosed` arm **cannot** rebind `c` (type
  mismatch) — so it must `return`/exit, as written. That works *here* because we leave.
- But what if the protocol should **continue** in `CloseWait` (drain remaining data)? Then
  we'd want `c` to *become* `Tcp<CloseWait>` and the loop to keep going with a different set
  of legal operations. A single-type `mut` binding **cannot express a value whose type
  changes across iterations.**

**Finding (real):** **EVT and mut-linear conflict when an event-driven transition needs to
change the binding's type mid-loop.** Typestate makes the type *part of* the type; `mut`
rebinds within *one* type. So "loop that continues across a state transition" is **not
expressible** with `mut` alone. This is a genuine interaction break, not present in either
rule alone.

**Candidate resolutions (none free):**
1. **Forbid it** — an event transition that changes state must **exit** the current
   typed scope (as the example does). Simple, but bans legitimate "drain in CloseWait"
   loops; forces awkward restructuring into multiple loops.
2. **State-polymorphic loop** — allow a loop carrying a value whose typestate may change,
   typed as the **sum** `Tcp<Established|CloseWait>`, with a `match` each iteration. Powerful
   but introduces *sum-typed typestate bindings* — a real new construct, more compiler
   weight, and pressure on the "small core" claim.
3. **Recursion instead of mut-loop** — model the state machine as tail-recursive functions,
   one per state, each taking the precisely-typed handle. No `mut` type-change needed; the
   "loop" is the call graph. This is the classic typed-state-machine encoding (and how
   session-type languages do it). **Likely the right answer** — it sidesteps the conflict
   entirely by not using a mut-loop for state-changing protocols.

**Assessment:** resolution 3 (recursion) dissolves the break without new machinery, at the
cost of telling users "stateful protocols are written as recursive functions, not loops."
That's a real ergonomic/teaching cost but a clean semantic one. **This is a fork to decide,
not a fatal flaw — but it directly dents the 'freshman writes loops' intuition for the
protocol-heavy use case.**

### F.3 INTERACTION BREAK #2 — CLO vs. EVT sum handles
The retry closure captures `c` (CLO → moves it, FnOnce). But EVT means the closure's body
does `match send_or_detect(c, ...)` which **produces a new typed handle** of an unknown-
until-runtime state. A `FnOnce` closure that captures `c: Tcp<Established>` and returns…
what? Its return type must be the **sum over next states**, and since it's `FnOnce` the
captured `c` is consumed exactly once — consistent. **No break:** CLO + EVT actually compose
*cleanly*, because FnOnce-consumes-once and EVT-returns-a-sum are orthogonal (one is about
capture cardinality, the other about return typing). The closure just has an EVT sum return
type. **PASS.** Worth noting because it's the one pair that *didn't* break.

### F.4 INTERACTION BREAK #3 — AFN vs. early exit via EVT
On the `PeerClosed` arm we `return` early. At that point the affine `hint` is still live.
AFN says affine may be dropped iff drop is a no-op. The early `return` drops `hint`. **Is
that sound?** Only if `hint`'s drop is genuinely free — which AFN already requires by
construction. So **AFN + EVT-early-exit compose cleanly**, *provided* the AFN guarantee
(no-op drop) is enforced at the type level so the early return can't accidentally drop
something costly. **PASS, conditional on AFN being a type-level guarantee, not a convention.**

This reinforces D1: AFN must be **compiler-enforced** (the type proves drop is a no-op),
because EVT creates many implicit early-exit points where affine values get dropped. If AFN
were merely a convention, EVT would turn it into a leak generator. **So EVT raises the
stakes on D1: affine's no-op-drop must be provable, not promised.**

---

## F.5 Consolidated interaction findings

| Pair / triple | Result |
|---------------|--------|
| EVT × mut-linear | **BREAK** — mut can't change a binding's type mid-loop; state-changing protocol loops aren't expressible with `mut`. Resolution: write stateful protocols as **recursion**, not mut-loops (no new machinery, real teaching cost). |
| CLO × EVT | **PASS** — FnOnce-capture and sum-return are orthogonal; compose cleanly. |
| AFN × EVT early-exit | **PASS, conditional** — sound only if AFN's no-op-drop is **compiler-enforced**, because EVT multiplies implicit drop points. Strengthens D1. |
| EVT × mut × CLO (triple) | Dominated by the EVT×mut break; if protocols use recursion (res. 3), the triple doesn't arise because there's no mut-loop to capture. |

### The load-bearing conclusion
The three new rules are **mostly compatible**, with **one real conflict**: event-driven
state changes do not fit `mut`-style loops. The cleanest resolution — **model stateful
protocols as recursive functions over precisely-typed handles** — is the textbook
typed-state-machine approach and needs no new core machinery. But it carries an honest
consequence for FIT's identity:

> **Protocol/state-machine code in FIT is naturally recursive, not loop-based.** Loops are
> for iterating data (the pipeline case, where values are unrestricted); recursion is for
> advancing state machines (where the handle's type changes each step). This is a clean
> division, but it must be **taught explicitly**, and it slightly complicates the "a
> beginner writes ordinary loops" story for exactly the domain (protocols) FIT most wants
> to own.

### Net effect on the "small core + composition rules" claim
The claim **survives**, strengthened by one clarification and one constraint:
- **Clarification:** EVT is realized via recursion + sum types, both already in the core. No
  new construct needed if we accept the recursion idiom.
- **Constraint:** AFN must be compiler-enforced (D1 hardened by F4), not conventional.
- **One open fork:** do we accept "stateful protocols = recursion" (resolution 3, my
  recommendation), or invest in state-polymorphic loops (resolution 2, more power, heavier
  core)? This is the next genuine design decision and a strong candidate to hand to a
  fresh review.

**Honest status:** four rounds of testing. Core coherent throughout. Round 3 added 3 rules;
Round 4 (this) found they interact cleanly except for EVT×mut, resolvable without new
machinery but with a real teaching cost. No fatal flaw found. The simplicity claim is now
precisely: *one substructural core + a small fixed set of composition rules + an idiom
(recursion for state machines).* That is a more honest and more complex claim than "one
mechanism, several hats" — and it is still a genuinely small language by systems-language
standards.
