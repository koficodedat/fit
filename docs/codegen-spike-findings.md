# FIT Codegen Spike — Findings

**Date:** 2026-05-26  
**Status:** Complete. Five programs compile and run; seven cleanup paths verified. §3 "point of consumption" rule clarified and confirmed for both bodied functions (compiler-enforced) and extern functions (author obligation).

---

## The one question: does FIT's model translate to running code?

**Yes, for straight-line code.** The cleanup model translates correctly across all seven
verified paths. All assertions use `strcmp` on the cleanup log; exit codes propagate
through `spike.sh`.

| Program | Path | What is verified | Result |
|---------|------|-----------------|--------|
| `cleanup_scope` | normal exit | `free_widget` fires at scope exit (compiler-emitted) | ✅ PASS |
| `cleanup_drop` | drop mid-scope | `free_widget` fires once at drop, not at exit | ✅ PASS |
| `cleanup_error` | `risky()` → Err | `free_widget` fires before Err return | ✅ PASS |
| `cleanup_error` | `risky()` → Ok | `free_widget` fires at drop, not on error path | ✅ PASS |
| `payment` | `execute_charge` fails | `void_token` inside `execute_charge`; caller emits nothing | ✅ PASS |
| `payment` | success | `void_token` inside `execute_charge` (extern obligation); caller emits nothing | ✅ PASS (extern-obligation) |
| `consume_body` | bodied consumer | `close_conn` fires inside `finish` at scope exit (compiler-emitted) | ✅ PASS |

`payment[success]` is labeled **extern-obligation**: both halves of the invariant hold —
the caller (compiler-enforced) emits no cleanup, and the callee (author obligation) calls
`void_token` before returning. The caller-side is compiler-verified; the callee-side is
verified via the corrected stub. See §3 clarification below.

Automatic cleanup is confirmed for all seven paths.

---

## Architecture: partial option (b) — classification shared, liveness re-walked

The original brief framed a binary choice: option (a) (codegen recomputes ownership
independently) vs option (b) (checker emits a cleanup schedule; codegen consumes it). The
actual result is a hybrid.

**What is genuinely shared with the checker (option b):**
- `param.mode === "move" | "lend"` — read from `env.functions.get(fn).params[i].mode`.
  Codegen does not re-inspect function bodies to determine calling convention; it reads the
  checker's pre-computed, frozen answer.
- `resource.cleanup` — the C cleanup function name comes from the TypeEnv's resource info,
  not guessed from naming conventions.
- `sig.returnType` — used to construct the error-branch return struct at each `?` site.

**What codegen re-walks independently (option a):**
- `state.live: LiveVar[]` — a declaration-order list of currently-owned resources. Codegen
  maintains this by walking the function body a second time, mutating `live` as variables
  are consumed (move calls, drop, Ok/Err wrapping) or introduced (let-bindings).
- Cleanup is emitted based on `state.live` at each exit point — scope exit, `?` error
  branch — not from a schedule the checker produced.

**Why this is accurate for straight-line code, and where it becomes a risk:**

For straight-line code (no branches, no loops), the checker's ownership walk and codegen's
independent walk trivially produce the same result at every exit point. All four spike
programs are straight-line. For control flow with branches or loops, the checker uses
`mergeScopes` to join ownership state at branch exits — codegen's independent walk would
have to mirror that join logic exactly, or the two diverge and cleanup gets placed wrong
(leak or double-free) on the paths branches create. That duplication is the real architectural
risk the spike surfaced, not a weakness in FIT's model.

---

## What the spike reveals about the model

**The cleanup model is complete for straight-line code.** The four programs cover every
cleanup trigger — scope exit, explicit drop, error path while owned, consumed-then-failed —
and the C lowering handled all of them with the same simple invariant: if it's in `state.live`,
it gets cleaned; if it's been moved out, it doesn't.

**Typestate and capability erasure are correct.** `Foo<Fresh>` and `Foo<Ready>` are the same C
struct. No runtime representation for either property was needed or missed. Both are purely
static.

**The consumed-then-failed obligation (§7) — fully verified after §3 clarification.**
In `payment.fit`, `execute_charge` receives `token` by move. Two invariants hold:

1. **Caller emits no cleanup** (compiler-enforced): `process_payment` has nothing in
   `state.live` at the `?` site after `execute_charge` — `token` was moved out. No cleanup
   emitted in `process_payment` on either path. Verified by the generated C.

2. **Callee disposes the token** (extern obligation): `execute_charge` receives `token` by
   move and returns a `Receipt` — the token transfers nowhere onward. By the §3 ruling
   (see below), the function that owns a resource and does not transfer it onward must
   dispose it, regardless of success or failure. For externs (no FIT body), this is the
   author's obligation; the compiler cannot insert the call. The corrected stub calls
   `void_token(token)` on both the failure path and the success path, and both assertions
   now check `cleanup_log == "void_token "`.

The original spike stub's success branch did `(void)token; return success;` — that was
wrong. The §3 ruling required `void_token` to fire on the success path too.

**One gap found during the spike:** Plain opaque types (`Receipt`, `Cents`, `CardDetails`)
used as function parameter types or return types were not emitted as `typedef int <Name>` in
the generated C. The generated code referenced these names as bare identifiers with no definition.
Fixed by adding `collectPlainTypeNames()` to `codegen.ts`, which scans function signatures and
emits `typedef int <Name>` for each distinct plain type name. This is a gap in the spike
implementation, not a gap in the FIT model — the model is correct, the code generator needed
to handle opaque plain types explicitly.

---

## §3 clarification: cleanup for resources moved into extern functions

**The question (now settled):** When a FIT function receives a linear resource by move and
that function has no FIT body (an extern), what disposes the resource if the function
succeeds and returns something else?

**The ruling — Interpretation A confirmed:**

The rule is uniform with locals: a resource moved into a function and not transferred onward
is disposed by that function (at scope exit, or earlier via drop). No special case for
externs.

- **For bodied functions:** compiler-enforced. The `consume_body` program demonstrates this
  directly — `finish(c: move Conn)` calls `summarize(c)` (a lend), so `c` remains in
  `state.live`, and the compiler emits `close_conn(c)` at scope exit. The stub does not
  choose this; it only observes it. Seven-path verification confirms.

- **For extern functions:** author obligation. The compiler verifies the caller emits no
  cleanup (move-out-skips-cleanup holds on the caller side), but cannot insert a call into
  the extern body. The hand-written implementation must call cleanup before returning on
  every path — success and failure alike. `execute_charge` is the example: `void_token`
  fires in both the failure path and the success path.

**What this settles:** The "point of consumption" rule covers consume-as-part-of-work, not
just `drop`. Disposal of a moved-in resource is compiler-enforced for bodied functions and
an author obligation for externs. Both halves are verified by the spike.

---

## The fifth program: confirming the branch boundary

To probe whether the second ownership walk would diverge at a branch, a fifth program was
written post-spike: a resource declared before an `if/else`, consumed on both branches
(symmetric, so the checker accepts it), with no `drop` after the branch (resource is gone).

```
fn run() -> () {
    let w = make_widget()
    if get_choice() {
        consume_widget(w)   // move — both branches consume
    } else {
        consume_widget(w)   // move
    }
    // w is no longer live; no cleanup at scope exit
}
```

Checker: exit 0 (symmetric consumption is valid).
Codegen: `Error: codegen spike: unsupported stmt kind 'if'`

The question of divergence is currently moot — `emitStmt` has no `if` case at all. The
branch boundary is explicit rather than implied. When `if` support is added to codegen,
it will need to mirror `mergeScopes` from the checker to handle ownership state at join
points correctly. That is the next real risk, and it is confirmed unimplemented, not
merely unverified.

## Remaining gaps

- **Match / enum payload types** — not implemented in codegen; spike programs avoid match.
- **loop / if** — `emitStmt` throws on these; the five programs expose `if` as the boundary.
- **rebind** — implemented in `emitStmt` but not exercised by any spike program.
- **Self-recursive inference** — unchanged from the checker; explicit annotation required.
- **Liveness at branch joins** — when `if`/`match` support is added to codegen, it must
  mirror `mergeScopes` from the checker; otherwise the two ownership walks diverge on
  branching paths. This is the architectural risk the spike surfaced.

---

## Differentiator #3 verdict

"Automatic, declared-at-type cleanup" was listed as one of FIT's four differentiators (§1.3)
and was previously untested — the checker only verified ownership, not disposal.

This spike verifies the differentiator for resources that live and die inside FIT bodies:
cleanup fires automatically at scope exit, at explicit drop, and on error paths, without
programmer annotation at call sites. Five of six paths confirm this directly.

The boundary: for resources moved into extern functions (no FIT body), automatic cleanup
depends on the extern's hand-written C, not on FIT's compiler. The §3 ruling (see above)
settles this: the rule is uniform — the extern author must call cleanup on every exit path.
The compiler enforces the caller side (move-out-skips-cleanup) and the author obligation
covers the callee side. The differentiator holds for FIT-bodied code and extends to externs
under the extern-obligation model, which is now verified.
