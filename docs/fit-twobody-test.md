# FIT — The "Two Resources, One Fallible Step" Test

> **Purpose:** validate the surviving Break #1 (a fallible operation holds *two* linear
> resources; what happens to both on failure) using the smallest honest program — a file
> copy — and then **deliberately re-test the same primitive across three different domains**
> (systems / server / data pipeline) to ensure the fix is structurally general, not
> secretly shaped by one kind of program.
>
> Non-goal: frontend. FIT is systems→server→data. The cross-domain check is to stop the
> primitives from quietly specializing to one of those.

---

## 1. Restating Break #1 in plain terms (no crypto vocabulary)

A function consumes **two** linear values and can fail. On success it accounts for both.
On failure, the original §7.2 rule only described *one* of them (the resource owned by the
`using` binding). The second one's fate was unspecified — which means either an invisible
disposal (breaks no-magic) or a leak (breaks linearity).

The minimal real program that exercises this: **copy a file.** You hold a source handle
and a destination handle simultaneously, and the read/write step can fail.

---

## 2. The file copy — naive attempt with current rules

```fit
fn copy(src_path: String, dst_path: String) using Fs
    -> Result<Unit, OpenError | ReadError | WriteError> {

    using src = open(src_path)?  cleanup close {        // first linear resource
        using dst = create(dst_path)? cleanup close {   // second linear resource
            loop {
                let chunk = read(src, 4096)?    // ReadError -> must dispose BOTH src and dst
                if chunk.is_empty() { break }
                write(dst, chunk)?              // WriteError -> must dispose BOTH src and dst
            }
            unit
        }
    }
}
```

**Does this actually work?** Walk the failure of `read(src, 4096)?`:
- We're inside both `using` blocks.
- The propagation rule (§4.3): you can't leave a scope holding an undisposed linear value.
- On `?`, we leave the **inner** block first → its `cleanup close(dst)` runs. Then we leave
  the **outer** block → its `cleanup close(src)` runs. Both disposed, in LIFO order.

**Finding: nested `using` already solves it.** Two resources, each with its own `using …
cleanup`, dispose correctly on any `?` because scope exit is LIFO and each scope owns one
resource. **Break #1 does NOT occur when each resource has its own binding.**

So where did Break #1 actually come from in the handshake?

---

## 3. The real source of Break #1 — re-examined

In the handshake, `derive_keys(c, k)` failed and the problem was `k`. But look at *why* `k`
was a problem there and *isn't* here:

- In the file copy, `src` and `dst` are each **bound by a `using`** → each has a declared
  cleanup → scope exit disposes both. No hole.
- In the handshake, `k` was a **bare function argument**, not bound by `using`. It had no
  declared cleanup site. *That* was the hole — not "two resources," but "a linear value in
  flight with no `using` binding owning it."

**Reframed finding (this is the actual correction to §7.2):** the problem was never the
*count* of resources. It was that FIT allowed a **linear value to be passed as a bare
argument into a fallible function** without an owning `using` scope to guarantee its
disposal on the error path. The file copy avoids it by construction because everything
linear is `using`-bound.

So the fix is not `adopt`, not multi-resource sugar, not parameterized failure states
(all of which I over-engineered last round). The fix is a single rule:

> **A linear value may only be passed into a fallible function if it is owned by a `using`
> binding in the caller (or threaded back out in the result).** A bare linear argument to a
> fallible function is a compile error, with the fix being "bind it with `using` first."

This is *smaller* than the current model, not bigger. It deletes the special cases. It's
one extra well-formedness rule that a compiler error can teach: "this key needs a `using`."

---

## 4. Cross-domain check #1 — SERVER (request handling)

Does the same rule hold for a server, which is a *different* shape (long-lived, many
concurrent short-lived resources, accept loop)?

```fit
fn serve(listener: Listener) using Net
    -> Result<Unit, AcceptError> {
    loop {
        using conn = accept(listener)? cleanup close {   // one resource per iteration
            handle(conn)?      // conn disposed at end of each iteration, success or error
        }
        // conn is gone here; next accept is clean
    }
}

fn handle(c: Connection<Open>) using Net
    -> Result<Unit, RequestError | ResponseError> {
    let req  = read_request(c)?     // c bound by caller's using -> disposed on error
    let resp = route(req)           // pure, unrestricted, cannot fail catastrophically
    write_response(c, resp)?        // c disposed on error
    unit
}
```

**Holds.** The per-request connection is `using`-bound in the accept loop; any failure in
`handle` propagates and the loop's `cleanup close(conn)` fires. The rule from §3 (linear
values must be `using`-owned) is satisfied: `handle` receives `c` but `c` is owned by
`serve`'s `using` binding, threaded in. **No new machinery needed; same rule.**

One genuinely new thing a server exposes: the **loop** holds a resource per iteration and
must dispose it each time, not once at the end. Nested-`using`-inside-loop already does
this. Confirmed: the LIFO scope-exit model covers the iterate-and-dispose pattern.

---

## 5. Cross-domain check #2 — DATA PIPELINE (transform stream)

Different shape again: data flows through stages, no long-lived connection, the
"resource" is often just buffered data, and back-pressure / partial consumption matters.

```fit
fn process(in_path: String, out_path: String) using Fs
    -> Result<Stats, OpenError | ParseError | WriteError> {
    using source = open(in_path)?   cleanup close {
        using sink = create(out_path)? cleanup close {
            let mut stats = Stats::zero()           // unrestricted, freely mutated/copied
            loop {
                let line = read_line(source)?       // both disposed on error
                if line.is_eof() { break }
                let record = parse(line)?           // ParseError -> both disposed
                let out    = transform(record)      // pure
                write_line(sink, out)?              // both disposed on error
                stats = stats.count()               // unrestricted accumulation
            }
            stats                                   // returned out; both resources closed
        }
    }
}
```

**Holds, and reveals something useful:** the *data* (`line`, `record`, `out`) is
**unrestricted**, not linear — it's copied/transformed freely, no threading ceremony. Only
the *endpoints* (`source`, `sink`) are linear resources. This is the §3 split working as
intended: linearity is confined to the things that genuinely must be disposed (handles),
while the bulk of pipeline code (the data) stays ceremony-free.

This is the strongest evidence so far that FIT's primitives are **not** secretly
crypto-shaped. A data pipeline is about as far from a handshake as systems code gets, and
the same two ideas — `using`-bound linear endpoints + unrestricted data — carry it with no
additions.

---

## 6. Where the rule still needs care (honest residue)

1. **A fallible function that legitimately takes ownership of a linear value and is
   *supposed* to consume it** (e.g. `send(conn, msg)` consuming a one-shot token). The §3
   rule says it must be `using`-owned by the caller. But after a successful consume, the
   caller's `using` must NOT also try to clean it up (double-free). So `using` needs to
   distinguish "still own it" from "moved it into a consuming call." This is solvable —
   linearity already tracks move-out — but the *interaction with `cleanup`* needs one
   precise rule: **`cleanup` only fires for values still owned at scope exit; a value moved
   into a consuming call is no longer owned, so its `cleanup` does not fire.** Needs to be
   stated explicitly; it's the one subtlety.

2. **Two resources that must be disposed *together* in a specific order** (close write end
   before read end of a pipe, say). Nested `using` gives LIFO, which is usually right, but
   if a program needs a *different* disposal order than acquisition-LIFO, nested `using`
   can't express it. Likely rare; flag for a real example before adding anything.

Neither of these needs new machinery yet. #1 is a clarifying rule on existing mechanisms;
#2 is "wait for a real program that needs it."

---

## 7. Verdict

**Break #1 is RESOLVED, and the resolution SHRINKS the language.**

- The real defect was not "two resources" but "a linear value passed into a fallible
  function without a `using` owner." The fix is one well-formedness rule, not the `adopt` /
  multi-sugar / parameterized-failure machinery proposed last round (all now discarded as
  over-engineering — confirmed by your instinct).
- **Break #2 (secrets/poison) is gone entirely** — a secret is just a linear value whose
  `cleanup` is "erase," declared once at the type. No failure-state lattice.
- The fix was **cross-validated across systems (copy), server (accept loop), and data
  pipeline (transform)** — three structurally different domains — with **no domain-specific
  additions**. This is direct evidence the primitives are general, not specialized to
  secure-channel code.

**Net effect on the simplicity claim:** strengthened, not weakened. Two rounds of
"findings" both resolved by *removing* machinery once the example was chosen honestly and
across domains. The earlier convolution was example-induced (crypto vocabulary), not
intrinsic to FIT.

**Remaining true residue:** §6.1 (the move-vs-cleanup interaction rule) must be stated
precisely — it's the one place a real subtlety lives. §6.2 (custom disposal order) waits
for a real program.

**Next honest test (different claim, real protocol):** validate the *typestate sequencing*
claim against a finished, frozen real-world protocol with a published state machine — e.g.
TCP's connection states or HTTP/1.1 keep-alive — to check that "illegal transition = won't
compile" holds for a spec FIT didn't get to design. One claim at a time.
