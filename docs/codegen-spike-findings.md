# FIT Codegen Spike — Findings

**Date:** 2026-05-26  
**Status:** Complete. Four programs compile and run. Five of six cleanup paths genuinely verified; one path (`payment[success]`) is caller-side only — see findings.

---

## The one question: does FIT's model translate to running code?

**Yes, for straight-line code with resources that stay in FIT bodies.** The cleanup model
translates correctly across five of the six paths in the verification matrix. One path
(`payment[success]`) is caller-side verified only — see the qualification below.

| Program | Path | Expected | Result |
|---------|------|----------|--------|
| `cleanup_scope` | normal exit | `free_widget` fires at scope exit | ✅ PASS |
| `cleanup_drop` | drop mid-scope | `free_widget` fires once at drop, not at exit | ✅ PASS |
| `cleanup_error` | `risky()` → Err | `free_widget` fires before Err return | ✅ PASS |
| `cleanup_error` | `risky()` → Ok | `free_widget` fires at drop, not on error path | ✅ PASS |
| `payment` | `execute_charge` fails | `void_token` fires inside `execute_charge` | ✅ PASS |
| `payment` | success | caller emits no cleanup (token was moved out) | ⚠️ PARTIAL |

The five genuine PASS paths are verified via `strcmp` assertion on the cleanup log, with
exit codes propagated through `spike.sh`. The one partial path is described below.

Automatic cleanup is no longer assumed for the five verified paths — it is confirmed.

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

**The consumed-then-failed obligation (§7) — caller side verified, callee side deferred.**
In `payment.fit`, `execute_charge` receives `token` by move. The caller (`process_payment`)
has nothing in `state.live` at the `?` site after `execute_charge`, so no cleanup is emitted
in `process_payment` on the failure path. That part — the caller correctly emitting no cleanup
for a resource it has already moved out — is genuine and verified.

What is NOT verified: what disposes the token inside `execute_charge` on the success path.
`execute_charge` is an extern (no FIT body); the spike stub's success branch does `(void)token`
and returns. By §3 of the spec ("cleanup at point of consumption: fires when a value is
consumed by a function that transfers it nowhere onward"), `void_token` should fire inside
`execute_charge` on success — the token moves in, the receipt moves out, the token goes
nowhere onward. The stub silently chose not to call `void_token`, and the test asserts
`cleanup_log == ""`, which can only pass if the stub opts out. It cannot fail regardless
of what FIT's semantics require.

This is a real spec ambiguity: §3's "point of consumption" rule for a resource moved into
an extern function is unresolved. The spike did not surface it — it papered over it by
letting the stub choose. See "Open spec question" below.

**One gap found during the spike:** Plain opaque types (`Receipt`, `Cents`, `CardDetails`)
used as function parameter types or return types were not emitted as `typedef int <Name>` in
the generated C. The generated code referenced these names as bare identifiers with no definition.
Fixed by adding `collectPlainTypeNames()` to `codegen.ts`, which scans function signatures and
emits `typedef int <Name>` for each distinct plain type name. This is a gap in the spike
implementation, not a gap in the FIT model — the model is correct, the code generator needed
to handle opaque plain types explicitly.

---

## Open spec question: cleanup for resources moved into extern functions

**The question:** When a FIT function receives a linear resource by move and that function
has no FIT body (an extern), what disposes the resource if the function succeeds and returns
something else?

**The tension in §3:**

- "Move-out skips cleanup" — if the caller moves the resource out, the caller emits no
  cleanup. Correct and verified.
- "Cleanup at point of consumption" — when a function consumes a resource and transfers it
  nowhere onward, cleanup fires inside that function. For an extern with no FIT body, there
  is no mechanism for the compiler to insert that call. The stub (hand-written C) must do it.

**Three resolutions, not yet decided:**

1. **The stub must call cleanup on success.** `execute_charge` owns the token; when it
   returns `Receipt` (not the token), the token "transfers nowhere onward," so `void_token`
   fires inside `execute_charge`. The test should assert `cleanup_log == "void_token "` on
   success. The stub as written is wrong.

2. **"Consumed" means "semantically used up," not "structurally absent from the return."**
   `execute_charge` consumes the token as part of the charge transaction — the token is spent.
   Cleanup (void/revoke the token) would be incorrect on a successful charge because the
   payment processor has already processed it. Under this reading, the resource's lifecycle
   ends at the transaction boundary, and no further cleanup fires.

3. **Extern functions require an explicit cleanup annotation.** Like extern resource params
   already require `move`/`lend` annotation, externs that consume-without-cleanup require
   an explicit marker (`consumes-without-cleanup` or similar). Missing annotation is a build
   error. This is consistent with the principle that externs are a boundary where implicit
   rules cannot be inferred.

**Status:** Unresolved. Resolution 1 is what §3 literally says; resolution 2 is what the
domain semantics suggest; resolution 3 is a design extension. The spike cannot distinguish
them because the test is vacuous on this path. This must be resolved before codegen handles
extern functions in a real standard library.

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
depends on the extern's hand-written C, not on FIT's compiler. Whether the compiler should
inject or require a cleanup call on the extern's success path is the open spec question above.
The differentiator holds for FIT-bodied code; its scope at the FFI boundary requires
resolution before it can be stated without qualification.
