# FIT — Scoped Lending + Resource Classification Test

> **Two pivots under test, on real code (file copy + HTTP keep-alive):**
>
> **Pivot 1 — Resource classification (the forced rule).**
> A type that declares cleanup (`close`/`release`/`zeroize`) has *non-trivial drop* → is a
> **resource** → must be **linear** (cleanup must run exactly once → exactly one owner).
> A type with no declared cleanup has *trivial drop* → may be **unrestricted or affine**.
> **affine + cleanup = compile error.** Classification is per-*type* (in its definition);
> signatures inherit it. There is no "unrestricted resource" — it's a contradiction.
>
> **Pivot 2 — Scoped lending (borrowing without the ceremony).**
> A function that *uses but does not consume* a resource receives it as a **lend**:
> automatic, lexical, **cannot escape the call**. No `&`, no lifetime annotations, no named
> regions. The lend begins and ends at the call boundary — so there are NO lifetimes to
> track (escape is what makes Rust's borrow checker hard; forbidding escape removes it).
> Consuming (ownership transfer) is explicit and only happens when you actually hand the
> resource away (e.g. `close`).
>
> **Goal:** see whether the threading verbosity, the `using c = c` wart, and the
> disposal-order tangle disappear — and whether anything new breaks.

---

## 1. The classification in code

```fit
// RESOURCE: declares cleanup -> compiler forces `linear`. affine here = error.
resource File {
    fd: Fd
    cleanup: close          // declaring this is what MAKES it a resource & forces linear
}

// PLAIN DATA: no cleanup -> trivial drop -> unrestricted (default) or affine, your choice
struct Chunk { bytes: Bytes }            // unrestricted; copy/drop freely, reclaimed mechanically
affine struct Hint { window: Int }       // affine OK: no cleanup, drop is trivial (just bytes)

// affine resource: REJECTED
affine resource Bad { fd: Fd, cleanup: close }
// ^ COMPILE ERROR: a type with `cleanup` cannot be affine; cleanup must run exactly once,
//   which requires linear (single-owner). Use `resource` (linear) or remove cleanup.
```

This is the whole classification: **one question — does it declare cleanup? — decides
linear vs. (unrestricted|affine).** No case-by-case use-count policy; the cleanup rule
*entails* the use-count.

---

## 2. The two access modes

```fit
// LEND (use, don't consume): the default for resource access. lexical, can't escape.
fn read_chunk(f: &File) -> Result<Chunk, ReadError>   // `&` = a lend; f returns to caller at call end
//   - read_chunk may use f for the duration of the call
//   - read_chunk MAY NOT store f, return f, or spawn anything holding f (no escape)
//   - caller still owns f after the call; no threading, no rebind

// CONSUME (transfer ownership): explicit, only when you give the resource away.
fn close(f: File)                                     // takes File by value -> consumes it
```

The distinction is in the signature and it's the *only* new syntax: `&File` = lend (you'll
get it back), `File` = consume (you're giving it up). One sigil, one meaning: "borrowed for
this call." No lifetimes because it cannot escape.

---

## 3. File copy — rewritten with both pivots

```fit
fn copy(src_path: String, dst_path: String) using Fs
    -> Result<Unit, OpenError | ReadError | WriteError> {

    let src = open(src_path)?          // src: File (linear, intrinsic cleanup=close)
    let dst = create(dst_path)?        // dst: File (linear)

    loop {
        let chunk = read_chunk(&src)?  // LEND src. src still owned here. NO rebind, NO threading.
        if chunk.is_empty() { break }
        write_chunk(&dst, chunk)?      // LEND dst. dst still owned.
    }

    close(src)                         // explicit consume — we're done, hand it away
    close(dst)
    Ok(unit)
}
```

### 3.1 What changed vs. every prior version
- **No `using ... cleanup`, no threading, no rebind.** `read_chunk(&src)` lends; `src`
  stays owned by `copy` throughout the loop. The body reads like ordinary imperative code.
- **The loop holds `&src` repeatedly with zero ceremony** — because a lend doesn't consume,
  there's nothing to thread back. This is the exact pain point of every earlier draft, gone.
- **Cleanup is explicit and in ONE place** (`close(src)`, `close(dst)` at the end).

### 3.2 BUT — the error path. Does cleanup still happen on `?`?
On `read_chunk(&src)?` failing: we leave `copy` early, holding **owned** `src` and `dst`
(the lends already ended — they don't escape the failed call). Now R1 applies: linear values
owned at exit must be disposed. There's no `using cleanup` here. **So who closes them?**

**Finding SL-1:** with explicit-consume-at-end, the **happy path is clean but the error path
loses automatic cleanup.** Two ways to resolve, and the choice is the crux:

- **(a) Intrinsic cleanup fires automatically on early exit** — because `File` *declared*
  `cleanup: close`, the compiler runs it for any owned `File` at any scope exit, including
  `?`. This means you DON'T write `close` at the end either — it's automatic. **But this is
  Austral's "implicit destructor call" — the exact thing we flagged as magic.** It's
  ergonomic and it's what Rust/Austral-affine do, but it inserts a call you didn't write.
- **(b) You must handle it explicitly** — wrap in `using cleanup`, bringing back the wart.

**This is the real fork, and it's the same one Austral faced.** Option (a) = implicit
destructors = ergonomic + slightly magic. Option (b) = explicit = no-magic + verbose/warty.
**Scoped lending fixed the *happy-path* threading, but the *error-path cleanup* fork is
untouched by it** — it's orthogonal. We still have to choose.

---

## 4. HTTP keep-alive — rewritten with both pivots

```fit
resource Conn { sock: Socket, cleanup: shutdown }     // linear, forced

fn read_request(c: &Conn) using Net -> Result<RequestOutcome, IoError>   // LEND
fn write_response(c: &Conn, resp: Response) using Net -> Result<Unit, IoError>  // LEND
fn route(req: ParsedRequest) -> Response              // pure; no Net; provably no I/O

fn serve_connection(c: &Conn) using Net {             // LEND — serve doesn't OWN the conn!
    loop {
        match read_request(c)? {                      // lend c into read_request
            ClientClosed => break,
            Timeout      => break,
            Request(req) => {
                let resp = route(req)
                write_response(c, resp)?               // lend c again
            }
        }
    }
}                                                      // c NOT closed here — caller owns it

fn main() using Net -> Result<Unit, BindError> {
    let listener = bind(":8080")?
    loop {
        let c = accept(listener)?                      // main OWNS c (linear Conn)
        serve_connection(&c)                           // LEND c for the whole connection
        close(c)                                       // explicit consume, one place
    }
}
```

### 4.1 What this buys (and it's significant)
- **`serve_connection` takes `&Conn` — a lend.** It uses the connection for the entire
  session but never *owns* it. So **there is no recursion, no type-change, no `mut`-across-
  types, no TCO.** The plain loop works because `c` is borrowed, not threaded.
- **Ownership lives in exactly one place (`main`'s accept loop).** One owner, one `close`,
  one disposal site. INT-2 (fragmented disposal) **gone.**
- **`using c = c` wart — gone entirely.** There's no need to attach cleanup to an
  already-owned value mid-function, because functions that use the conn *borrow* it; only
  `main` owns it, and it owns it plainly.
- **The audit surface still holds** — `route` has no `Net`, provably no I/O.

### 4.2 The same SL-1 fork resurfaces
If `serve_connection` errors, `main` still owns `c` → must dispose. Same fork as §3.2: does
intrinsic cleanup auto-fire (magic-ish, ergonomic) or must `main` handle it (explicit)?
**Scoped lending did NOT resolve this — but it did *concentrate* it: there's now exactly ONE
owner and ONE place the fork matters, instead of the obligation being smeared across scopes.**

---

## 5. Findings

| # | Finding |
|---|---------|
| **SL-1** | Scoped lending cleanly fixes happy-path threading/warts, but the **error-path cleanup fork** (implicit destructor vs. explicit) is orthogonal and still open. It's the Austral fork. |
| **SL-2** | Lending **concentrates ownership to one site**, so even if we pick explicit cleanup, it's stated *once*, not fragmented (INT-2 dissolved either way). |
| **SL-3** | The **recursion mandate / TCO / type-change cascade is GONE** — not via Position 4 yet, but because borrowing lets a function *use* a stateful resource without owning/threading it, so a plain loop suffices. **This alone may remove the need for Position 4.** |
| **SL-4** | Classification rule (cleanup → linear; no cleanup → unrestricted/affine) is **clean and forced**; affine-resource rejected with a clear error. No case-by-case use-count. |
| **SL-5** | Exactly one new sigil (`&` = lend, lexical, non-escaping). No lifetimes, because lends can't escape. This is the minimal viable borrowing. |

### The big realization (SL-3)
We introduced borrowing to fix *ergonomics*, but it **also dissolved the typestate baggage
cascade** — because the cascade was caused by needing to *thread* a state-changing resource
through a loop. If you can **lend** the resource instead of threading it, the loop body uses
it freely and the resource's ownership (and any state) stays put with the owner. **Borrowing
may be the thing that makes typestate-as-pattern ergonomic enough that we don't need
typestate-as-core at all** — OR it may be the substrate that finally makes Position 4
(permits) usable. Either way, borrowing is now looking like the **central missing piece**,
not a side concern.

### The one fork borrowing did NOT resolve
Implicit-destructor-on-early-exit vs. explicit-cleanup. This is genuinely the Austral
question and we must answer it deliberately:
- Austral chose **explicit destructors for linear types** (no implicit drop) → verbose,
  no-magic.
- Rust/affine chose **implicit Drop** → ergonomic, but a call you didn't write.
- FIT's stated tenet (no-magic) points to explicit; FIT's ergonomic goal points to implicit.
**This is the next real decision, and it's a values decision, not a technical one.**

---

## 6. Honest status

Scoped lending is the strongest single move of the entire session. It (a) gives the
GC-like ergonomics you wanted *for the common case* without GC or lifetimes, (b) removes the
threading verbosity, (c) **dissolves the recursion/TCO cascade as a side effect**, and (d)
costs exactly one non-escaping sigil. It does NOT, by itself, decide the implicit-vs-explicit
cleanup fork — that's orthogonal and still open.

**Crucially for the Austral question:** Austral *has* borrowing too (lexical regions, explicit
`borrow as`). FIT's bet here — **borrowing as the DEFAULT calling convention via a single
non-escaping `&`, no region syntax** — is a real ergonomic difference from Austral's explicit
`borrow x as ref in R do ... end`. Whether that difference is *enough* to justify a separate
language is still the open question — but it is, at last, a concrete and defensible
difference rather than a re-derivation.

**Next:** (1) decide the implicit-vs-explicit cleanup fork (values call); (2) re-examine
whether Position 4 (permits) is still needed now that SL-3 removed the cascade, or whether
typestate-as-opt-in-pattern + scoped lending already covers the protocol-safety goal.
