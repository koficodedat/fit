import { Program, Decl, Stmt, Expr } from "./ast";
import { FitType, TypeEnv, buildTypeEnv } from "./types";

// Maps a FitType to a C type name.
// unit → int, plain → name, resource → name, alias → name, result → R_<ok>_<err>
export function cTypeName(t: FitType): string {
  switch (t.kind) {
    case "unit":
      return "int";
    case "plain":
      return t.name;
    case "resource":
      return t.name;
    case "alias":
      return t.name;
    case "result":
      return `R_${cTypeName(t.ok)}_${cTypeName(t.err)}`;
    default: {
      const _exhaustive: never = t;
      throw new Error(`cTypeName: unhandled FitType kind`);
    }
  }
}

// Collects all distinct Result FitTypes reachable from function signatures.
function collectResultTypes(env: TypeEnv): FitType[] {
  const seen = new Set<string>();
  const results: FitType[] = [];

  function visit(t: FitType) {
    if (t.kind === "result") {
      const key = cTypeName(t);
      if (!seen.has(key)) {
        seen.add(key);
        results.push(t);
        visit(t.ok);
        visit(t.err);
      }
    }
  }

  for (const sig of env.functions.values()) {
    visit(sig.returnType);
    for (const p of sig.params) visit(p.type_);
  }
  return results;
}

// Entry point: compile a parsed FIT program to a C source string.
export function codegen(program: Program): string {
  const { env } = buildTypeEnv(program);
  const out: string[] = [];

  out.push("#include <stdio.h>");
  out.push("#include <string.h>");
  out.push("");

  // Resource struct typedefs + cleanup function extern declarations
  for (const decl of program.decls) {
    if (decl.kind === "resource") {
      out.push("typedef struct {");
      for (const f of decl.fields) {
        out.push(`  int ${f.name};`);
      }
      out.push(`} ${decl.name};`);
      out.push(`extern void ${decl.cleanup.fn}(${decl.name} v);`);
      out.push("");
    }
  }

  // Enum typedefs
  for (const decl of program.decls) {
    if (decl.kind === "enum") {
      const variants = decl.variants
        .map((v, i) => `  ${decl.name}_${v.name} = ${i}`)
        .join(",\n");
      out.push(`typedef enum {\n${variants}\n} ${decl.name};`);
      out.push("");
    }
  }

  // Result tagged-union typedefs
  for (const rt of collectResultTypes(env)) {
    if (rt.kind !== "result") continue;
    const name = cTypeName(rt);
    const okT = cTypeName(rt.ok);
    const errT = cTypeName(rt.err);
    out.push("typedef struct {");
    out.push("  int tag;");
    out.push(`  union { ${okT} ok; ${errT} err; };`);
    out.push(`} ${name};`);
    out.push("");
  }

  // Extern declarations (body-less fn decls)
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body === null) {
      out.push(emitExternDecl(decl, env));
    }
  }
  out.push("");

  // Function implementations (fn decls with a body)
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      out.push(emitFnImpl(decl as Decl & { kind: "fn"; body: Stmt[] }, env));
    }
  }

  return out.join("\n") + "\n";
}

function emitExternDecl(
  decl: Decl & { kind: "fn" },
  env: TypeEnv
): string {
  const sig = env.functions.get(decl.name)!;
  const retT = cTypeName(sig.returnType);
  const params = sig.params
    .map((p) => `${cTypeName(p.type_)} ${p.name}`)
    .join(", ");
  return `extern ${retT} ${decl.name}(${params || "void"});`;
}

// A live (still-owned) linear resource in the current scope.
type LiveVar = { name: string; cleanupFn: string };

// Mutable state threaded through body emission.
type EmitState = {
  live: LiveVar[];                 // owned resources in declaration order
  varTypes: Map<string, FitType>; // all declared locals (for type lookup)
  tmp: { n: number };              // fresh temp-variable counter
  returned: boolean;               // true once a return has been emitted
};

function emitFnImpl(decl: Decl & { kind: "fn"; body: Stmt[] }, env: TypeEnv): string {
  const sig    = env.functions.get(decl.name)!;
  const retT   = cTypeName(sig.returnType);
  const params = sig.params
    .map(p => `${cTypeName(p.type_)} ${p.name}`)
    .join(", ");

  const out: string[] = [];
  out.push(`${retT} ${decl.name}(${params || "void"}) {`);

  // Seed live and varTypes from move-mode resource parameters
  const live: LiveVar[] = [];
  const varTypes = new Map<string, FitType>();
  for (const p of sig.params) {
    varTypes.set(p.name, p.type_);
    if (p.mode === "move" && p.type_.kind === "resource") {
      live.push({ name: p.name, cleanupFn: p.type_.cleanup });
    }
  }

  const state: EmitState = { live, varTypes, tmp: { n: 0 }, returned: false };
  emitStmts(decl.body, env, sig.returnType, state, out);

  if (!state.returned) {
    // Scope exit: clean up remaining owned resources in reverse declaration order
    for (const v of [...state.live].reverse()) {
      out.push(`  ${v.cleanupFn}(${v.name});`);
    }
    if (sig.returnType.kind === "unit") {
      out.push("  return 0;");
    }
  }

  out.push("}");
  out.push("");
  return out.join("\n");
}

function emitStmts(
  stmts: Stmt[],
  env: TypeEnv,
  retType: FitType,
  state: EmitState,
  out: string[]
): void {
  for (const stmt of stmts) {
    if (state.returned) break;
    emitStmt(stmt, env, retType, state, out);
  }
}

function emitStmt(
  stmt: Stmt,
  env: TypeEnv,
  retType: FitType,
  state: EmitState,
  out: string[]
): void {
  switch (stmt.kind) {
    case "let": {
      const { cExpr, fitType } = emitExpr(stmt.init, env, retType, state, out);
      out.push(`  ${cTypeName(fitType)} ${stmt.name} = ${cExpr};`);
      state.varTypes.set(stmt.name, fitType);
      if (fitType.kind === "resource") {
        state.live.push({ name: stmt.name, cleanupFn: fitType.cleanup });
      }
      break;
    }

    case "rebind": {
      const { cExpr, fitType } = emitExpr(stmt.expr, env, retType, state, out);
      out.push(`  ${stmt.name} = ${cExpr};`);
      state.varTypes.set(stmt.name, fitType);
      if (fitType.kind === "resource") {
        const idx = state.live.findIndex(v => v.name === stmt.name);
        if (idx >= 0) {
          state.live[idx].cleanupFn = fitType.cleanup;
        } else {
          state.live.push({ name: stmt.name, cleanupFn: fitType.cleanup });
        }
      }
      break;
    }

    case "expr": {
      const expr = stmt.expr;
      if (expr.kind === "ok" || expr.kind === "err") {
        // Return expression: clean up live vars first, then return
        for (const v of [...state.live].reverse()) {
          out.push(`  ${v.cleanupFn}(${v.name});`);
        }
        state.live.length = 0;
        const { cExpr } = emitExpr(expr, env, retType, state, out);
        out.push(`  return ${cExpr};`);
        state.returned = true;
      } else {
        const { cExpr } = emitExpr(stmt.expr, env, retType, state, out);
        // try: emitExpr already emitted the if-block
        // drop: emitExpr already emitted cleanup call; cExpr is "(void)0"
        // regular calls: emit as statement
        if (stmt.expr.kind !== "try" && cExpr !== "(void)0") {
          out.push(`  ${cExpr};`);
        }
      }
      break;
    }

    default:
      throw new Error(`codegen spike: unsupported stmt kind '${(stmt as any).kind}'`);
  }
}

function emitExpr(
  expr: Expr,
  env: TypeEnv,
  retType: FitType,
  state: EmitState,
  out: string[]
): { cExpr: string; fitType: FitType } {
  switch (expr.kind) {

    case "unit_val":
      return { cExpr: "0", fitType: { kind: "unit", mode: "unrestricted" } };

    case "var": {
      const fitType = state.varTypes.get(expr.name)
        ?? { kind: "plain", mode: "unrestricted" as const, name: expr.name };
      return { cExpr: expr.name, fitType };
    }

    case "ok": {
      const inner = emitExpr(expr.expr, env, retType, state, out);
      // Moving a resource into Ok consumes it
      if (expr.expr.kind === "var" && inner.fitType.kind === "resource") {
        const idx = state.live.findIndex(v => v.name === (expr.expr as { name: string }).name);
        if (idx >= 0) state.live.splice(idx, 1);
      }
      const cName = cTypeName(retType);
      return { cExpr: `(${cName}){0, {.ok = ${inner.cExpr}}}`, fitType: retType };
    }

    case "err": {
      const inner = emitExpr(expr.expr, env, retType, state, out);
      const cName = cTypeName(retType);
      return { cExpr: `(${cName}){1, {.err = ${inner.cExpr}}}`, fitType: retType };
    }

    case "call": {
      // drop(x) is a builtin: emit cleanup, remove from live
      if (expr.fn === "drop") {
        const arg = expr.args[0];
        if (arg.kind === "var") {
          const idx = state.live.findIndex(v => v.name === arg.name);
          if (idx >= 0) {
            const v = state.live[idx];
            state.live.splice(idx, 1);
            out.push(`  ${v.cleanupFn}(${arg.name});`);
          }
        }
        return { cExpr: "(void)0", fitType: { kind: "unit", mode: "unrestricted" } };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        const argExprs = expr.args.map(a => emitExpr(a, env, retType, state, out).cExpr);
        return {
          cExpr: `${expr.fn}(${argExprs.join(", ")})`,
          fitType: { kind: "plain", mode: "unrestricted", name: "?" },
        };
      }

      const argExprs: string[] = [];
      for (let i = 0; i < sig.params.length && i < expr.args.length; i++) {
        const arg   = expr.args[i];
        const param = sig.params[i];
        const { cExpr: argCExpr } = emitExpr(arg, env, retType, state, out);
        argExprs.push(argCExpr);
        // Move-mode resource arg: ownership transfers — remove from caller's live
        if (param.mode === "move" && param.type_.kind === "resource" && arg.kind === "var") {
          const idx = state.live.findIndex(v => v.name === arg.name);
          if (idx >= 0) state.live.splice(idx, 1);
        }
      }

      return {
        cExpr: `${expr.fn}(${argExprs.join(", ")})`,
        fitType: sig.returnType,
      };
    }

    case "try": {
      const inner = emitExpr(expr.expr, env, retType, state, out);
      const tmpName = `_t${state.tmp.n++}`;
      const innerCType = cTypeName(inner.fitType);

      out.push(`  ${innerCType} ${tmpName} = ${inner.cExpr};`);

      // Error branch: clean up all still-owned live vars, then return Err
      out.push(`  if (${tmpName}.tag != 0) {`);
      for (const v of [...state.live].reverse()) {
        out.push(`    ${v.cleanupFn}(${v.name});`);
      }
      const retCType = cTypeName(retType);
      out.push(`    ${retCType} _err = {1, {.err = ${tmpName}.err}};`);
      out.push(`    return _err;`);
      out.push(`  }`);

      const okFitType = inner.fitType.kind === "result"
        ? inner.fitType.ok
        : { kind: "unit" as const, mode: "unrestricted" as const };
      return { cExpr: `${tmpName}.ok`, fitType: okFitType };
    }

    default: {
      const _exhaustive: never = expr;
      return { cExpr: "0", fitType: { kind: "unit", mode: "unrestricted" } };
    }
  }
}
