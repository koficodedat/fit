# FIT Codegen Spike — Findings

**Date:** 2026-05-26  
**Status:** Complete. Five programs compile and run; 5 compiler-verified cleanup paths + 2 extern-boundary paths (demonstrated by correct stubs; not compiler-verifiable). §3 "point of consumption" rule clarified and confirmed for both bodied functions (compiler-enforced) and extern functions (author obligation).

---

## The one question: does FIT's model translate to running code?

**Yes, for straight-line code.** The cleanup model translates correctly across all seven
paths — five compiler-verified, two demonstrated at the extern boundary. All assertions
use `strcmp` on the cleanup log; exit codes propagate through `spike.sh`.

| Program | Path | What is verified | Result |
|---------|------|-----------------|--------|
| `cleanup_scope` | normal exit | `free_widget` fires at scope exit (compiler-emitted) | ✅ PASS |
| `cleanup_drop` | drop mid-scope | `free_widget` fires once at drop, not at exit | ✅ PASS |
| `cleanup_error` | `risky()` → Err | `free_widget` fires before Err return | ✅ PASS |
| `cleanup_error` | `risky()` → Ok | `free_widget` fires at drop, not on error path | ✅ PASS |
| `payment` | `execute_charge` fails | `void_token` inside `execute_charge`; caller emits nothing | ✅ caller-verified / extern-obligation (demonstrated) |
| `payment` | success | `void_token` inside `execute_charge` (extern obligation); caller emits nothing | ✅ caller-verified / extern-obligation (demonstrated) |
| `consume_body` | bodied consumer | `close_conn` fires inside `finish` at scope exit (compiler-emitted) | ✅ PASS |

Both `payment` paths are labeled **caller-verified / extern-obligation (demonstrated)**:
the caller (compiler-enforced) emits no cleanup, and the callee (author obligation) calls
`void_token` before returning on both paths. The caller-side is compiler-verified; the
callee-side is demonstrated by a correct stub; not compiler-verifiable. See §3 clarification below.

Automatic cleanup is compiler-verified for five paths. The two payment paths are demonstrated at the extern boundary by a correct stub; the callee side is not compiler-verifiable.

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

**The consumed-then-failed obligation (§7) — caller side compiler-verified; callee side demonstrated by a correct stub; not compiler-verifiable.**
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
an author obligation for externs. The bodied-function side is compiler-verified; the
extern-obligation side is demonstrated by a correct stub; not compiler-verifiable.

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
programmer annotation at call sites. Five of seven paths confirm this directly (the two
payment paths are extern-boundary, demonstrated by correct stubs; not compiler-verifiable).

The boundary: for resources moved into extern functions (no FIT body), automatic cleanup
depends on the extern's hand-written C, not on FIT's compiler. The §3 ruling (see above)
settles this: the rule is uniform — the extern author must call cleanup on every exit path.
The compiler enforces the caller side (move-out-skips-cleanup) and the author obligation
covers the callee side. The differentiator holds for FIT-bodied code and extends to externs
under the extern-obligation model, demonstrated by correct stubs; not compiler-verifiable.

---

## Linear enum payload tracking (post-spike fix)

### The gap

Before this fix, match pattern variables were bound to unrestricted stubs (`{ kind: "plain", mode: "unrestricted", name: "?" }`). Linear resources carried in enum variant payloads were invisible to the checker: a bound payload could be dropped, used after move, or left unconsumed with no error. `linear_payload_not_consumed.fit` — a `Connected(Conn)` arm that binds `c` and does nothing with it — was silently accepted.

### The fix

Three pieces were required:

(a) **TypeEnv enums map** — `buildTypeEnv` now iterates enum declarations and registers each variant by name in `env.enums` (keyed by variant name, e.g. `"More"`, `"Done"`). Payloads are resolved via `resolveType` in a dedicated loop after `resolveEnv` is fully settled, so resource lookups succeed.

(b) **Match case binding resolution** — when a match arm's pattern is a known variant, the bound variable is entered into `armScope` with the true resolved `FitType` (linear if the payload is a resource), not a stub. Arity checks added: no-payload+binds, linear-payload+zero-binds, and >1-binds are all errors.

(c) **Arm-local linear binding check** — arm-local linear bindings are tracked in `armLinearBinds`. After `checkStmts` runs on the arm body, any binding in `armLinearBinds` that is not marked `moved` is an error. `mergeScopes` alone was insufficient because it only walks `preScope` bindings, not variables introduced inside the arm.

### Before/after evidence

`tests/should_fail/linear_payload_not_consumed.fit` was silently accepted before the fix. After the fix it is correctly rejected with the error: `"linear value 'c' must be consumed in match arm for 'Connected'"`.

### What this makes sound

One-to-many typestate transitions via enum payloads are now checker-sound **through the match**. `tests/one_to_many.fit` exercises this directly: `recv` returns a `RecvResult` whose `More` variant carries `Conn<Active>` and whose `Done` variant carries `Conn<Closing>`. The match in `process` binds `c` in each arm; the checker confirms each arm consumes its linear payload. The program passes with 0 errors.

The soundness guarantee is scoped to in-match consumption. Once the match fires and binds a payload variable, that variable is tracked as linear and must be consumed. The hole one let away: the enum value itself (`let r = recv(c)?`) is a plain, unrestricted type — the checker does not track `r` as linear. If `r` is never matched, it leaks silently with no error.

### What remains open

- **Enum-linearity propagation** — enum values carrying linear payloads are not themselves linear. A named, unconsumed enum binding (`let r = get_response()` followed by no match) leaks undetected. Closing this gap would require the enum type to propagate the linearity of its most-linear payload variant, which is a non-trivial type-system extension. Logged as the next gap.
- **Match codegen is unimplemented.** `emitStmt` throws on `match`, so `one_to_many.fit` passes the checker but cannot produce running C. The checker soundness and the codegen gap are separate concerns; only the checker is addressed here.
- **Divergent-typestate merges** — if arm A leaves `Conn<Active>` live and arm B leaves `Conn<Closing>` live and both reach the merge point, `mergeScopes` would need to report a conflict. The canonical `one_to_many.fit` avoids this by consuming the resource on every arm; the case is an escalation trigger per the spec brief, not a resolved question.
- **Variant-name collision** — variant names must be unique across all enum declarations; a collision emits a `BuildError` (implemented alongside the enums map construction).
