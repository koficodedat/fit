# FIT Codegen Spike — Findings

**Date:** 2026-05-26  
**Status:** Complete. All four programs compile and run; all six cleanup paths verified.

---

## The one question: does FIT's model translate to running code?

**Yes.** The cleanup model translates to C without gaps or ambiguity. Every resource is
cleaned exactly once on every path — no leak, no double-free — across all six test paths
in the verification matrix.

| Program | Path | Expected | Result |
|---------|------|----------|--------|
| `cleanup_scope` | normal exit | `free_widget` fires at scope exit | ✅ PASS |
| `cleanup_drop` | drop mid-scope | `free_widget` fires once at drop, not at exit | ✅ PASS |
| `cleanup_error` | `risky()` → Err | `free_widget` fires before Err return | ✅ PASS |
| `cleanup_error` | `risky()` → Ok | `free_widget` fires at drop, not on error path | ✅ PASS |
| `payment` | `execute_charge` fails | `void_token` fires inside `execute_charge` | ✅ PASS |
| `payment` | success | `void_token` does not fire in `process_payment` | ✅ PASS |

Automatic cleanup is no longer assumed — it is verified.

---

## Architecture decision: option (b) — checker's analysis drives cleanup

The checker's settled TypeEnv was sufficient. Codegen did not re-derive move/lend modes
or ownership — it consumed them from `buildTypeEnv`'s output. The `FunctionSig.params[i].mode`
field already encodes whether each callee parameter is `move` or `lend`, which is exactly
what codegen needs to decide whether to remove a var from `state.live` when building a call.

**What the checker provides that codegen uses:**
- `param.mode === "move"` → remove arg from `state.live` before emitting `?` error check
- `resource.cleanup` → the C function name to call for each owned var
- `sig.returnType` → used to construct the error-branch return struct at each `?` site

**What codegen adds on top:**
- `state.live: LiveVar[]` — a declaration-order list of currently-owned resources, mutated as
  vars are consumed (move calls, drop, Ok/Err wrapping) and appended when let-bindings introduce resources
- Reverse-order emission at scope exit and `?` sites

The checker and codegen share the same underlying ownership model. They do not diverge.

---

## What the spike reveals about the model

**The cleanup model is complete for straight-line code.** The four programs cover every
cleanup trigger — scope exit, explicit drop, error path while owned, consumed-then-failed —
and the C lowering handled all of them with the same simple invariant: if it's in `state.live`,
it gets cleaned; if it's been moved out, it doesn't.

**Typestate and capability erasure are correct.** `Foo<Fresh>` and `Foo<Ready>` are the same C
struct. No runtime representation for either property was needed or missed. Both are purely
static.

**The consumed-then-failed obligation (§7) expressed cleanly.** In `payment.fit`,
`execute_charge` receives `token` by move. If it fails, it owns `token` and cleans it inside
itself. The caller (`process_payment`) has nothing in `state.live` at the `?` site after
`execute_charge`, so no cleanup is emitted there. This is correct and required no special
handling — it fell out of the ownership model automatically.

**One gap found during the spike:** Plain opaque types (`Receipt`, `Cents`, `CardDetails`)
used as function parameter types or return types were not emitted as `typedef int <Name>` in
the generated C. The generated code referenced these names as bare identifiers with no definition.
Fixed by adding `collectPlainTypeNames()` to `codegen.ts`, which scans function signatures and
emits `typedef int <Name>` for each distinct plain type name. This is a gap in the spike
implementation, not a gap in the FIT model — the model is correct, the code generator needed
to handle opaque plain types explicitly.

---

## Remaining gaps (unchanged from poc-findings.md)

The codegen spike does not resolve any of the known PoC limitations:
- **Match / enum payload types** — not implemented; the four spike programs avoid match.
- **loop / if / rebind** — `emitStmt` throws on loop and if; the spike programs don't use them.
- **Self-recursive inference** — bodied functions with self-recursive consumption still need
  explicit annotation; unchanged from the checker.

These are post-spike work, not findings about the cleanup model.

---

## Differentiator #3 verdict

"Automatic, declared-at-type cleanup" was listed as one of FIT's four differentiators (§1.3)
and was previously untested — the checker only verified ownership, not disposal.

This spike closes that gap. Cleanup fires automatically, correctly, on every path, without
programmer annotation at call sites. The differentiator is real.
