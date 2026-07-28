# Codegen: loop-exit live-set is discarded, causing double cleanup on `break`

**Date:** 2026-07-27
**Status:** Filed, not fixed. Needs an architectural decision, not a local patch — routed to the Architect via the Orchestrator.
**Found by:** final whole-branch review of `fix(codegen): lower break to goto; add execution tests` (`00fa616`), independently reproduced and confirmed before filing.
**Related:** extends the risk `docs/codegen-spike-findings.md` §"Architecture: partial option (b)" predicted for control flow with branches or loops (see "Why this was predictable" below).

---

## The bug

`case "loop"` in `src/codegen.ts` (currently lines 494–510) clones `state.live` into a
`bodyState`, emits the loop body against that clone, and then **discards `bodyState`
entirely** — unlike `case "if"` (lines 466–492 in the same file), which explicitly merges
`thenState.live` / `elseState.live` back into `state.live` after emission. Any resource
consumed *inside* the loop body (via `drop`, a moving call, or — as of `00fa616` — a
`break` out of a `match` arm) is invisible to the code that runs after the loop: as far as
`state.live` is concerned, nothing happened inside the loop.

The result is a **double cleanup**: the resource's cleanup fires once inside the loop body
(correctly, at the point of consumption) and fires again at the function's end, where
`emitFnImpl` cleans up everything still in `state.live` — because `state.live` was never
updated to reflect the consumption.

## Independently reproduced

```fit
resource Conn { cleanup: close_conn }
fn close_conn(c: move Conn) -> ()
fn open_conn() -> Conn
enum Sig { Stop, Again }
fn poll() -> Sig
fn done() -> ()

fn f() -> () {
    let c = open_conn()
    loop {
        match poll() {
            Stop  => { drop(c) break },
            Again => { drop(c) break },
        }
    }
    done()
}
```

Type-checks with **zero errors**. Generated C:

```c
void f(void) {
  {
    Conn c = open_conn();
    while (1) {
      {
        Sig _t1 = poll();
        switch (_t1) {
        case 0: {
          close_conn(c);
          goto _loop_end_0;
          break;
        }
        case 1: {
          close_conn(c);
          goto _loop_end_0;
          break;
        }
        default: abort(); break;
        }
      }
    }
    _loop_end_0:;
    done();
  }
  close_conn(c);          // <-- second call. c was already freed above.
  return;
}
```

`close_conn(c)` fires once per match arm (correct) and a third time after the loop
(wrong) — a double-free of whatever `close_conn` releases. Compiles clean under
`cc -std=c99 -Werror`; wrong at runtime. Same failure shape as the bug `00fa616` fixed
(clean compile, wrong behavior), but on the resource-cleanup axis instead of the
control-flow axis.

## Why `00fa616` made this reachable rather than causing it

The bug is **pre-existing** — `case "loop"` has never propagated its body's live set.
Before `00fa616`, a `break` inside a `match` arm lowered to a bare C `break;`, which exits
the `switch`, not the `while(1)` — so the loop never terminated, `f()` never returned, and
the second `close_conn(c)` at function end was dead code no execution could ever reach.
The `goto` fix makes `break` actually exit the loop, which makes the function actually
return, which makes the pre-existing double-cleanup path live for the first time. The
`goto` lowering itself is correct and the reachability increase is a strict improvement
over an infinite loop — but it is worth recording precisely because it moved this defect
from theoretical to live without being itself the defect.

`break` inside an `if` inside a `loop` (already lowered to a plain C `break;` before
`00fa616`, since an `if` doesn't wrap it in a `switch`) has the same gap and was already
reachable — `case "loop"` discards `bodyState.live` regardless of what construct the
`break` came from. This is not new with `00fa616`; it was simply undemonstrated.

## Root cause

`EmitState` (src/codegen.ts) tracks `returned: boolean` so branch-merge logic
(`case "if"`, lines 482–490) can tell "this arm returned" from "this arm fell through" and
merge `live` sets accordingly. There is no equivalent for loop exits: nothing distinguishes
"this iteration fell through to loop again" from "this iteration broke out," so
`case "loop"` has no signal to decide what `state.live` should be after the loop — and
currently doesn't try, just keeping the pre-loop value unconditionally.

`src/checker.ts:133–134` — `case "break": break; // still-owned linears get auto-cleaned; no linearity checker action` — documents the checker's side of the same assumption: cleanup for anything still owned at `break` time is the checker's problem to verify and codegen's problem to emit. The checker's linearity pass verifies exactly one arm's obligations are met per `CLAUDE.md` rule 3 ("Cleanup fires for still-owned values... on every exit path — normal return, early `?` return, `break`"), but nothing currently checks that codegen's `state.live` bookkeeping matches what the checker verified. This finding is that mismatch made concrete.

## Why this was predictable

`docs/codegen-spike-findings.md` §"Architecture: partial option (b): classification
shared, liveness re-walked" (2026-05-26) named this exact risk class before any of the
loop/match/break codegen existed:

> "For control flow with branches or loops, the checker uses `mergeScopes` to join
> ownership state at branch exits — codegen's independent walk would have to mirror that
> join logic exactly, or the two diverge and cleanup gets placed wrong (leak or
> double-free) on the paths branches create. That duplication is the real architectural
> risk the spike surfaced, not a weakness in FIT's model."

`case "if"` mirrors the checker's branch-merge logic (§ above). `case "loop"` never grew
the equivalent for its own exit — this finding is that gap surfacing on a concrete
program, not a new discovery of the risk itself.

## Why this needs a design decision, not a patch

The candidate fix — propagate `break`-path live sets out of the loop, the way `case "if"`
already propagates `then`/`else` live sets — has design surface the `if` case doesn't:

- A loop can have **multiple `break` sites** with potentially different live sets at each
  (e.g. one arm drops `c` before breaking, another doesn't). `case "if"` only ever merges
  two branches; a loop's merge is over an unbounded number of `break` sites plus the
  "loop never breaks" case (`label.used === false`, currently unreachable in the corpus
  but structurally possible with e.g. a `return` inside every arm instead of `break`).
- Whatever merge rule is chosen must match the checker's own `mergeScopes` semantics for
  loop exits (CLAUDE.md rule 7, "Linear values in branches... must be consumed on every
  branch"), or codegen's live-set walk and the checker's verified obligations diverge
  again in some other shape.
- `EmitState` needs a `broke`-equivalent to `returned` to make "this state is a break
  exit" representable at all — a type change with the same shape as this task's own
  `loopLabels` addition, but with more merge logic behind it.

This is exactly the class of thing `CLAUDE.md`'s escalation rules call out: *"The checker
requires a rule not present in FIT-SPEC-v2.md or FIT-SYNTAX.md"* and *"Anything in the
canonical test programs appears unsound"* — do not invent a solution here; flag it and
stop. This doc is that flag.

## Scope note

Not fixed as part of `00fa616` — that task's brief (`FIT-v0.1-codegen-break-lowering.md`)
scoped it to `break` lowering and execution-test infrastructure only, explicitly listed
"the checker's failure to reject `break` outside a loop" as a separate filed item (§4),
and its own §4/§7 instruct stopping and reporting rather than expanding scope on discovery
of something else. This doc is that report for a second, related defect surfaced by the
same review.

No canonical program (`payment.fit`, `smtp.fit`, `drain.fit`, `examples/postgres/postgres.fit`)
currently exercises a linear resource consumed inside a loop body via `break` or `drop`,
so this defect does not affect any program in the suite today — it was only reachable via
a purpose-built repro. The corresponding `tests/should_run/` execution tests
(`break_in_match_in_loop`, `nested_loop_break`) do not carry linear resources through their
loops, so they do not — and structurally cannot, as written — catch this class of bug.
