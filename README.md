# FIT — Linearity + Ownership Checker (PoC)

A proof-of-concept **static checker** for a minimal subset of the FIT language.
FIT is a systems language built on linear types, typestate, and capabilities.
This PoC answers two viability questions:

1. **Is the checker small and clean?** — Austral's equivalent is ~600 lines; FIT's is measured here.
2. **Are the canonical programs readable by a non-programmer?** — Answered by `docs/reader-study.md`.

---

## What the checker does

Given a `.fit` source file, the checker:

- Verifies every **linear value is used exactly once** — no abandon, no double-use.
- Tracks **typestate transitions** — you cannot call `auth` on a `Fresh` connection; the stages must be in order.
- Verifies **capabilities at every call site** — a function that does not declare `using ChargeCard` cannot call a function that requires it.
- Detects **loop bodies that change a resource's typestate** — these are rejected with a suggestion to use recursion.
- Verifies **linear values are consumed on all branches** of an `if` or `match`.

On success it exits `0` and prints nothing. On failure it prints located errors:

```
payment.fit:22:5: missing capability 'ChargeCard' required by 'execute_charge'
```

---

## Quick start

```bash
npm install
npm run build          # compile TypeScript → dist/
node dist/src/main.js check tests/payment.fit
node dist/src/main.js check tests/smtp.fit
```

---

## Development commands

| Command | What it does |
|---------|-------------|
| `npm test` | Run all 251 tests |
| `npm run build` | Compile TypeScript |
| `npm run lint` | ESLint across `src/` and `tests/` |
| `npm run format` | Prettier auto-fix |
| `npm run format:check` | Prettier dry-run (CI use) |

---

## Repository layout

```
/
├── src/
│   ├── ast.ts          — AST type definitions
│   ├── parser.ts       — hand-written recursive-descent parser (501 lines)
│   ├── types.ts        — FIT type representations and buildTypeEnv
│   ├── checker.ts      — linearity + typestate + capability checker (301 lines)
│   └── main.ts         — CLI entry: fit check <file>
├── tests/
│   ├── payment.fit     — canonical program 1: payment processing
│   ├── smtp.fit        — canonical program 2: SMTP email session
│   ├── should_pass/    — programs the checker must accept
│   ├── should_fail/    — programs the checker must reject (named after the error)
│   ├── checker.test.ts — unit + integration tests for the checker
│   ├── parser.test.ts  — unit tests for the parser
│   ├── parser.edge.test.ts — edge cases and safety tests for the parser
│   ├── parser.errors.test.ts — parse error tests
│   ├── types.test.ts   — type environment tests
│   └── suite.test.ts   — auto-discovering runner for should_pass / should_fail
├── docs/
│   ├── FIT-SPEC-v2.md  — authoritative semantic decisions
│   ├── FIT-SYNTAX.md   — frozen concrete syntax
│   ├── reader-study.md — PoC question 2 instrument (programs + comprehension questions)
│   └── poc-findings.md — PoC results and deductions for handover
└── CLAUDE.md           — build handoff instructions and escalation rules
```

---

## The two canonical programs

Both live in `tests/` and must always pass the checker with zero errors.

**`payment.fit`** — Payment authorization pipeline. Demonstrates:
- `AuthToken` as a linear resource (cannot be charged twice)
- `using ChargeCard` capability enforcement
- `?` propagation with automatic cleanup on failure

**`smtp.fit`** — SMTP email session. Demonstrates:
- Five-stage typestate progression (`Fresh → Greeted → Authed → Ready → Closing`)
- Lend semantics enabling `send_message` in a loop without consuming the connection
- Loop typestate invariant enforcement

---

## PoC results

| Metric | Result |
|--------|--------|
| Parser | 501 lines |
| Checker | 301 lines |
| **Total (checker surface)** | **802 lines** |
| Reference (Austral) | ~600 lines (OCaml) |
| Test count | 251 |
| Canonical programs | both pass, 0 errors |

The ~34% gap vs. Austral is language overhead (TypeScript vs. OCaml), not semantic complexity.
`checker.ts` at 301 lines is competitive with Austral's equivalent semantic work.

---

## Known PoC limitations

These are accepted for the PoC and documented in `FIT-SPEC-v2.md`:

- **Terminal-function lend inference** — functions returning `()` are classified as lend because the resource name does not appear in the return type. A `close(conn)` call does not consume `conn`; cleanup fires at scope exit instead. A stricter body-inspection inference would fix this.
- **Match variant payload types** — payload bindings in match arms receive type `plain/unrestricted`; linear payloads inside enum variants are not tracked.
- **`Ok(non-var-linear)` not consumed** — the checker only consumes a named var in `Ok(x)`. Temporaries like `Ok(make_foo())` are not consumed (the function call transfers ownership before `Ok` is evaluated).
- **Exhaustiveness checking** — the checker does not verify that a `match` covers all enum variants; exhaustiveness is a post-PoC feature.
- **Duplicate declarations** — silently last-write-wins; no checker for duplicate names.

---

## Where to go next

See `docs/poc-findings.md` for a full assessment of what the PoC proves, what it does not, and what the natural next implementation steps are.
