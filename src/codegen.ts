import { Program, Decl, Stmt, Expr, VariantDef } from "./ast";
import { FitType, TypeEnv, buildTypeEnv, resolveType, DIV_RESULT_TYPE } from "./types";

// Maps a FitType to a C type name (for values: struct fields, union members, variables).
// unit → int (placeholder; use cRetTypeName for function return types).
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
    case "enum":
      return t.name;
    case "result":
      return `R_${cTypeName(t.ok)}_${cTypeName(t.err)}`;
    default: {
      const _exhaustive: never = t;
      throw new Error(`cTypeName: unhandled FitType kind`);
    }
  }
}

// For function return positions: unit → void (idiomatic C); all others → cTypeName.
function cRetTypeName(t: FitType): string {
  return t.kind === "unit" ? "void" : cTypeName(t);
}

function ind(depth: number): string {
  return "  ".repeat(depth);
}

// Combined context threaded through body emission.
type CodegenCtx = {
  env: TypeEnv;
  enumVariants: Map<string, VariantDef[]>; // enum name → variant defs (with payload info)
};

// True if any variant of the named enum carries a payload.
function enumHasPayload(enumName: string, ctx: CodegenCtx): boolean {
  return (ctx.enumVariants.get(enumName) ?? []).some(v => v.payload !== null);
}

// 0-based source-order index of variantName within enumName.
function variantIndexOf(enumName: string, variantName: string, ctx: CodegenCtx): number {
  const variants = ctx.enumVariants.get(enumName) ?? [];
  const idx = variants.findIndex(v => v.name === variantName);
  return idx >= 0 ? idx : 0;
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

// Scans every function body for literal/binop usage that needs a typedef but may
// never appear in any function signature — so collectPlainTypeNames/collectResultTypes
// (which only walk signatures) can't discover it. Two concrete gaps this closes:
//   - `let x = 1 < 2` never puts Bool in any signature — Bool still needs `typedef int
//     Bool;` or the generated C fails to compile ("use of undeclared identifier 'Bool'").
//   - Result<Int, DivByZero> may never appear in any signature either (it can be
//     `?`-unwrapped into a union alias before reaching one), so its typedef and Int's
//     need the same forcing.
type LiteralUsage = { needsInt: boolean; needsBool: boolean; needsDivByZero: boolean };

function scanLiteralUsage(program: Program): LiteralUsage {
  const usage: LiteralUsage = { needsInt: false, needsBool: false, needsDivByZero: false };

  function visitExpr(e: Expr): void {
    switch (e.kind) {
      case "int_lit":
        usage.needsInt = true;
        return;
      case "bool_lit":
        usage.needsBool = true;
        return;
      case "binop":
        if (e.op === "/" || e.op === "%") {
          usage.needsInt = true;
          usage.needsDivByZero = true;
        } else if (e.op === "+" || e.op === "-" || e.op === "*") {
          usage.needsInt = true;
        } else {
          usage.needsBool = true;
        }
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "ok":
      case "err":
      case "try":
        visitExpr(e.expr);
        return;
      case "call":
        e.args.forEach(visitExpr);
        return;
      // Leaf nodes with no child expressions to walk — listed explicitly (rather than
      // falling into a catch-all `default`) so that a future Expr variant with children
      // fails to compile here instead of silently producing generated C with a missing
      // typedef (the same class of bug this function exists to close — see the comment
      // on scanLiteralUsage above).
      case "var":
      case "unit_val":
      case "qualified_var":
        return;
      default: {
        const _exhaustive: never = e;
      }
    }
  }

  function visitStmt(s: Stmt): void {
    switch (s.kind) {
      case "expr":
        visitExpr(s.expr);
        return;
      case "let":
        visitExpr(s.init);
        return;
      case "rebind":
        visitExpr(s.expr);
        return;
      case "if":
        visitExpr(s.cond);
        s.then.forEach(visitStmt);
        s.else_.forEach(visitStmt);
        return;
      case "loop":
        s.body.forEach(visitStmt);
        return;
      case "match":
        visitExpr(s.expr);
        s.arms.forEach(a => a.body.forEach(visitStmt));
        return;
      // break/select have no child expressions or statements to walk.
      case "break":
      case "select":
        return;
      default: {
        const _exhaustive: never = s;
      }
    }
  }

  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) decl.body.forEach(visitStmt);
  }
  return usage;
}

// Collects all distinct plain type names used across function signatures.
// Resources, enums, and records are already emitted as structs/enums — excluded here.
function collectPlainTypeNames(env: TypeEnv, program: Program): string[] {
  const defined = new Set<string>();
  for (const decl of program.decls) {
    if (decl.kind === "resource" || decl.kind === "enum" || decl.kind === "record") {
      defined.add(decl.name);
    }
  }

  const seen = new Set<string>();
  const names: string[] = [];

  function visit(t: FitType) {
    switch (t.kind) {
      case "plain":
        if (!defined.has(t.name) && !seen.has(t.name)) {
          seen.add(t.name);
          names.push(t.name);
        }
        break;
      case "result":
        visit(t.ok);
        visit(t.err);
        break;
      default:
        break;
    }
  }

  for (const sig of env.functions.values()) {
    visit(sig.returnType);
    for (const p of sig.params) visit(p.type_);
  }
  for (const decl of program.decls) {
    if (decl.kind === "enum") {
      for (const v of decl.variants) {
        if (v.payload !== null) visit(resolveType(v.payload, env));
      }
    }
  }
  return names;
}

// If the declared error slot is a union alias and the value is one of its members,
// wrap it in the alias's tagged-union representation. Pass through otherwise —
// when the value already IS the alias, or the slot is a plain error type.
function wrapErrMember(
  cExpr: string,
  valueType: FitType,
  errSlot: FitType | null
): string {
  if (errSlot === null || errSlot.kind !== "alias") return cExpr;
  const name = "name" in valueType ? valueType.name : null;
  if (name === null || name === errSlot.name) return cExpr;
  const idx = errSlot.members.indexOf(name);
  if (idx < 0) return cExpr;
  return `(${errSlot.name}){${idx}, {.${name} = ${cExpr}}}`;
}

// Entry point: compile a parsed FIT program to a C source string.
export function codegen(program: Program): string {
  if (program.decls.some(d => d.kind === "import")) {
    throw new Error(
      "codegen: unexpected import decl in assembled program — loader must strip imports before codegen"
    );
  }
  const { env } = buildTypeEnv(program);

  // Build enum-variants lookup for payload detection and variant-index resolution.
  const enumVariants = new Map<string, VariantDef[]>();
  for (const decl of program.decls) {
    if (decl.kind === "enum") enumVariants.set(decl.name, decl.variants);
  }
  const ctx: CodegenCtx = { env, enumVariants };
  const literalUsage = scanLiteralUsage(program);

  const out: string[] = [];

  out.push("#include <stdio.h>");
  out.push("#include <string.h>");
  out.push("#include <stdlib.h>");
  out.push("");

  // Collect fn names that have explicit declarations, so we can suppress duplicate
  // resource-level cleanup externs when the cleanup fn is already declared as fn.
  const explicitFnDecls = new Set<string>(
    program.decls
      .filter(d => d.kind === "fn" && d.body === null)
      .map(d => (d as { name: string }).name)
  );

  // Plain-type typedefs (opaque types used in signatures or enum payloads, lowered to int).
  const plainNames = collectPlainTypeNames(env, program);
  // Int/Bool literals and binops may be used purely locally (e.g. `let x = 1 < 2`)
  // without Int/Bool ever appearing in any function signature — force them in when
  // that happens, or the generated C references an undefined type. See scanLiteralUsage.
  // This unconditional `typedef int Int;` would collide with a user `resource Int
  // {...}`'s own struct typedef (both named "Int") — that's only safe because
  // codegen() is never reached for a program that fails check() (main.ts gates codegen
  // on check() passing first), and the checker's isInt (checker.ts, the `binop` case)
  // rejects a resource named "Int" used as an arithmetic operand, which is the only way
  // literalUsage.needsInt gets set for a program that also declares `resource Int`. If
  // that checker guarantee ever weakens, this typedef becomes a silent C name collision.
  if (literalUsage.needsInt && !plainNames.includes("Int")) {
    plainNames.push("Int");
  }
  if (literalUsage.needsBool && !plainNames.includes("Bool")) {
    plainNames.push("Bool");
  }
  for (const name of plainNames) {
    out.push(`typedef int ${name};`);
  }
  if (plainNames.length > 0) {
    out.push("");
  }

  // Record struct typedefs (aggregate types, no cleanup).
  for (const decl of program.decls) {
    if (decl.kind === "record") {
      out.push("typedef struct {");
      for (const f of decl.fields) {
        out.push(`  int ${f.name};`);
      }
      out.push(`} ${decl.name};`);
      out.push("");
    }
  }

  // Resource struct typedefs + cleanup function extern declarations.
  // Cleanup extern is suppressed when the fn is explicitly declared.
  for (const decl of program.decls) {
    if (decl.kind === "resource") {
      out.push("typedef struct {");
      for (const f of decl.fields) {
        out.push(`  int ${f.name};`);
      }
      out.push(`} ${decl.name};`);
      if (!explicitFnDecls.has(decl.cleanup.fn)) {
        out.push(`extern void ${decl.cleanup.fn}(${decl.name} v);`);
      }
      out.push("");
    }
  }

  // Enum typedefs: unit-only → C enum; has-payload → tagged-union struct.
  for (const decl of program.decls) {
    if (decl.kind === "enum") {
      const hasPayload = decl.variants.some(v => v.payload !== null);
      if (hasPayload) {
        out.push("typedef struct {");
        out.push("  int tag;");
        out.push("  union {");
        for (const v of decl.variants) {
          if (v.payload !== null) {
            const payloadFit = resolveType(v.payload, env);
            out.push(`    ${cTypeName(payloadFit)} ${v.name};`);
          }
        }
        out.push("  };");
        out.push(`} ${decl.name};`);
      } else {
        const variants = decl.variants
          .map((v, i) => `  ${decl.name}_${v.name} = ${i}`)
          .join(",\n");
        out.push(`typedef enum {\n${variants}\n} ${decl.name};`);
      }
      out.push("");
    }
  }

  // DivByZero: built-in unit-only enum for `/` and `%` (§4.1). Not a program.decls
  // entry — no `enum` decl exists for it — so it isn't reached by the loop above.
  // Emitted only when the program actually uses division or modulo, following the
  // same conditional-emission pattern as the plain-type typedefs.
  if (literalUsage.needsDivByZero) {
    out.push("typedef enum {\n  DivByZero_DivByZero = 0\n} DivByZero;");
    out.push("");
  }

  // Type alias typedefs: tagged union over the alias's member types. A member
  // carrying a payload lowers to a struct, and struct-into-int is not a legal C
  // conversion — so the alias itself must be tagged, not erased to int.
  for (const decl of program.decls) {
    if (decl.kind === "type_alias") {
      out.push(`/* error union ${decl.name} = ${decl.members.join(" | ")} */`);
      out.push("typedef struct {");
      out.push("  int tag;");
      out.push("  union {");
      for (const m of decl.members) {
        const memberType = resolveType({ kind: "named", name: m, typeArg: null }, env);
        out.push(`    ${cTypeName(memberType)} ${m};`);
      }
      out.push("  };");
      out.push(`} ${decl.name};`);
      out.push("");
    }
  }

  // Result tagged-union typedefs.
  const resultTypes = collectResultTypes(env);
  // As with Int above: force R_Int_DivByZero in when `/` or `%` are used, since the
  // signature walk that builds resultTypes may never see it directly.
  if (literalUsage.needsDivByZero && !resultTypes.some(rt => cTypeName(rt) === cTypeName(DIV_RESULT_TYPE))) {
    resultTypes.push(DIV_RESULT_TYPE);
  }
  for (const rt of resultTypes) {
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

  // Extern declarations (body-less fn decls).
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body === null) {
      out.push(emitExternDecl(decl, ctx));
    }
  }
  out.push("");

  // Function implementations (fn decls with a body).
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      out.push(emitFnImpl(decl as Decl & { kind: "fn"; body: Stmt[] }, ctx));
    }
  }

  return out.join("\n") + "\n";
}

function emitExternDecl(
  decl: Decl & { kind: "fn" },
  ctx: CodegenCtx
): string {
  const sig = ctx.env.functions.get(decl.name)!;
  const retT = cRetTypeName(sig.returnType);
  const params = sig.params
    .map((p) => `${cTypeName(p.type_)} ${p.name}`)
    .join(", ");
  return `extern ${retT} ${decl.name}(${params || "void"});`;
}

// A live (still-owned) linear resource in the current scope.
type LiveVar = { name: string; cleanupFn: string };

// A pending goto target for the loop it was pushed by. `used` is set by a
// "break" anywhere within the loop's body (including inside cloned branch
// states) and read back by the "loop" case after emitting the body — the
// array spread on clone copies the stack, not the LoopLabel objects, so the
// flag is shared by reference across branches. See codegen-break-lowering brief §1.1.
type LoopLabel = { name: string; used: boolean };

// Mutable state threaded through body emission.
type EmitState = {
  live: LiveVar[];                  // owned resources in declaration order
  varTypes: Map<string, FitType>;  // all declared locals (for type lookup)
  tmp: { n: number };               // fresh temp-variable counter (shared across branches)
  returned: boolean;                // true once a return has been emitted
  loopLabels: LoopLabel[];          // enclosing-loop goto targets, innermost last
};

function emitFnImpl(decl: Decl & { kind: "fn"; body: Stmt[] }, ctx: CodegenCtx): string {
  const sig    = ctx.env.functions.get(decl.name)!;
  const retT   = cRetTypeName(sig.returnType);
  const params = sig.params
    .map(p => `${cTypeName(p.type_)} ${p.name}`)
    .join(", ");

  const out: string[] = [];
  out.push(`${retT} ${decl.name}(${params || "void"}) {`);

  // Seed live and varTypes from move-mode resource parameters.
  const live: LiveVar[] = [];
  const varTypes = new Map<string, FitType>();
  for (const p of sig.params) {
    varTypes.set(p.name, p.type_);
    if (p.mode === "move" && p.type_.kind === "resource") {
      live.push({ name: p.name, cleanupFn: p.type_.cleanup });
    }
  }

  const state: EmitState = { live, varTypes, tmp: { n: 0 }, returned: false, loopLabels: [] };
  emitStmts(decl.body, 1, ctx, sig.returnType, state, true, out);

  if (!state.returned) {
    // Scope exit: clean up any still-owned move-mode resources in reverse order.
    for (const v of [...state.live].reverse()) {
      out.push(`${ind(1)}${v.cleanupFn}(${v.name});`);
    }
    if (sig.returnType.kind === "unit") {
      out.push(`${ind(1)}return;`);
    }
  }

  out.push("}");
  out.push("");
  return out.join("\n");
}

// Block-scoping rule: each `let` wraps itself and all subsequent siblings in a new
// C block (`{...}`). The binding is emitted INSIDE the block (at depth+1), safely
// nested below any parameter or prior let at the current depth.
//
// isTail marks that the LAST statement of this list is in tail position of the
// enclosing function body (only emitFnImpl's top-level call passes true; if/loop/
// match bodies are out of scope for tail-expression return and always pass false).
// Only the final statement inherits it; earlier statements get false. The `let`
// case recurses on the remainder with the same incoming flag — the remainder's
// tail is still the enclosing body's tail.
function emitStmts(
  stmts: Stmt[],
  depth: number,
  ctx: CodegenCtx,
  retType: FitType,
  state: EmitState,
  isTail: boolean,
  out: string[]
): void {
  for (let i = 0; i < stmts.length; i++) {
    if (state.returned) break;
    const stmt = stmts[i];
    const stmtIsTail = isTail && i === stmts.length - 1;

    if (stmt.kind === "let") {
      out.push(`${ind(depth)}{`);
      const { cExpr, fitType } = emitExpr(stmt.init, depth + 1, ctx, retType, state, out);
      out.push(`${ind(depth + 1)}${cTypeName(fitType)} ${stmt.name} = ${cExpr};`);
      state.varTypes.set(stmt.name, fitType);
      if (fitType.kind === "resource") {
        const existingIdx = state.live.findIndex(v => v.name === stmt.name);
        if (existingIdx >= 0) state.live.splice(existingIdx, 1);
        state.live.push({ name: stmt.name, cleanupFn: fitType.cleanup });
      }
      emitStmts(stmts.slice(i + 1), depth + 1, ctx, retType, state, isTail, out);
      out.push(`${ind(depth)}}`);
      return;
    }

    emitStmt(stmt, depth, ctx, retType, state, stmtIsTail, out);
  }
}

function emitStmt(
  stmt: Stmt,
  depth: number,
  ctx: CodegenCtx,
  retType: FitType,
  state: EmitState,
  isTail: boolean,
  out: string[]
): void {
  switch (stmt.kind) {
    case "rebind": {
      const { cExpr, fitType } = emitExpr(stmt.expr, depth, ctx, retType, state, out);
      out.push(`${ind(depth)}${stmt.name} = ${cExpr};`);
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
        // Ok(...)/Err(...) is FIT's explicit return construct — the checker allows
        // it at any statement position (early return from inside if/match arms),
        // not just tail. Unconditional on isTail; ordering (cleanup before
        // evaluating the value) preserved exactly.
        for (const v of [...state.live].reverse()) {
          out.push(`${ind(depth)}${v.cleanupFn}(${v.name});`);
        }
        state.live.length = 0;
        const { cExpr } = emitExpr(expr, depth, ctx, retType, state, out);
        out.push(`${ind(depth)}return ${cExpr};`);
        state.returned = true;
      } else if (isTail && retType.kind !== "unit") {
        // General tail expression (call, var, qualified_var, try, ...): evaluate
        // first — a `try` must emit its own statements (including its own
        // error-path cleanup) before we return — then clean up remaining live
        // vars, then return the value.
        const { cExpr } = emitExpr(expr, depth, ctx, retType, state, out);
        if (cExpr !== "(void)0") {
          for (const v of [...state.live].reverse()) {
            out.push(`${ind(depth)}${v.cleanupFn}(${v.name});`);
          }
          state.live.length = 0;
          out.push(`${ind(depth)}return ${cExpr};`);
          state.returned = true;
        }
      } else {
        const { cExpr } = emitExpr(stmt.expr, depth, ctx, retType, state, out);
        if (stmt.expr.kind !== "try" && cExpr !== "(void)0") {
          out.push(`${ind(depth)}${cExpr};`);
        }
      }
      break;
    }

    case "if": {
      const { cExpr: condExpr } = emitExpr(stmt.cond, depth, ctx, retType, state, out);
      const preLive = [...state.live];

      const thenState: EmitState = {
        live: [...preLive],
        varTypes: state.varTypes,
        tmp: state.tmp,
        returned: false,
        loopLabels: [...state.loopLabels],
      };
      out.push(`${ind(depth)}if (${condExpr}) {`);
      emitStmts(stmt.then, depth + 1, ctx, retType, thenState, false, out);

      const elseState: EmitState = {
        live: [...preLive],
        varTypes: state.varTypes,
        tmp: state.tmp,
        returned: false,
        loopLabels: [...state.loopLabels],
      };
      out.push(`${ind(depth)}} else {`);
      emitStmts(stmt.else_, depth + 1, ctx, retType, elseState, false, out);
      out.push(`${ind(depth)}}`);

      if (!thenState.returned && !elseState.returned) {
        state.live = thenState.live;
      } else if (thenState.returned && !elseState.returned) {
        state.live = elseState.live;
      } else if (!thenState.returned && elseState.returned) {
        state.live = thenState.live;
      } else {
        state.returned = true;
      }
      break;
    }

    case "loop": {
      const label: LoopLabel = { name: `_loop_end_${state.tmp.n++}`, used: false };
      out.push(`${ind(depth)}while (1) {`);
      const bodyState: EmitState = {
        live: [...state.live],
        varTypes: state.varTypes,
        tmp: state.tmp,
        returned: false,
        loopLabels: [...state.loopLabels, label],
      };
      emitStmts(stmt.body, depth + 1, ctx, retType, bodyState, false, out);
      out.push(`${ind(depth)}}`);
      if (label.used) {
        out.push(`${ind(depth)}${label.name}:;`);
      }
      break;
    }

    case "break": {
      const label = state.loopLabels[state.loopLabels.length - 1];
      if (label === undefined) {
        throw new Error("codegen: 'break' outside any loop");
      }
      label.used = true;
      out.push(`${ind(depth)}goto ${label.name};`);
      break;
    }

    case "select": {
      // Compile-time capability resolution only; emit as a comment marker.
      const atoms = stmt.atoms.join(", ");
      out.push(`${ind(depth)}/* select ${atoms} from ${stmt.from} */`);
      break;
    }

    case "match": {
      // Step 1: evaluate scrutinee.
      const { cExpr: scrutCExpr, fitType: scrutType } = emitExpr(
        stmt.expr, depth, ctx, retType, state, out
      );

      // Step 2: consume scrutinee if it's a linear var (ownership transfers to arms).
      if (stmt.expr.kind === "var" && scrutType.mode === "linear") {
        const varName = (stmt.expr as { name: string }).name;
        const idx = state.live.findIndex(v => v.name === varName);
        if (idx >= 0) state.live.splice(idx, 1);
      }

      // Step 3: open outer block and bind scrutinee to a fresh temp.
      const tmpName = `_t${state.tmp.n++}`;
      const scrutCType = cTypeName(scrutType);
      out.push(`${ind(depth)}{`);
      out.push(`${ind(depth + 1)}${scrutCType} ${tmpName} = ${scrutCExpr};`);

      // Step 4: decide switch expression.
      // Tagged-union enums and Result switch on .tag; unit-only enums switch directly.
      let switchExpr: string;
      let scrutEnumName = "";
      if (scrutType.kind === "enum") {
        scrutEnumName = scrutType.name;
        switchExpr = enumHasPayload(scrutType.name, ctx)
          ? `${tmpName}.tag`
          : tmpName;
      } else if (scrutType.kind === "result") {
        switchExpr = `${tmpName}.tag`;
      } else {
        // Unknown type (e.g. undeclared fn return) — switch directly on value.
        switchExpr = tmpName;
      }

      // Step 5: emit switch.
      out.push(`${ind(depth + 1)}switch (${switchExpr}) {`);

      // Step 6: emit arms.
      let hasWildcard = false;
      const armStates: EmitState[] = [];

      for (const arm of stmt.arms) {
        if (arm.pattern.kind === "wildcard") {
          hasWildcard = true;
          out.push(`${ind(depth + 1)}default: {`);
          const armState: EmitState = {
            live: [...state.live],
            varTypes: state.varTypes,
            tmp: state.tmp,
            returned: false,
            loopLabels: [...state.loopLabels],
          };
          armStates.push(armState);
          emitStmts(arm.body, depth + 2, ctx, retType, armState, false, out);
          if (!armState.returned) out.push(`${ind(depth + 2)}break;`);
          out.push(`${ind(depth + 1)}}`);
        } else {
          // Variant pattern.
          const pat = arm.pattern;
          // Use explicit qualifier if present; otherwise infer from scrutinee's enum.
          const enumName = pat.qualifier ?? scrutEnumName;
          const idx = variantIndexOf(enumName, pat.name, ctx);

          out.push(`${ind(depth + 1)}case ${idx}: {`);

          const armState: EmitState = {
            live: [...state.live],
            varTypes: state.varTypes,
            tmp: state.tmp,
            returned: false,
            loopLabels: [...state.loopLabels],
          };
          armStates.push(armState);

          // Payload binding: only first bind for multi-bind patterns (checker rejects multi-bind;
          // codegen mirrors recovery by emitting only the first).
          if (pat.binds.length > 0) {
            const bindName = pat.binds[0];
            const variants = ctx.enumVariants.get(enumName) ?? [];
            const variantDef = variants.find(v => v.name === pat.name);
            if (variantDef?.payload != null) {
              const payloadFitType = resolveType(variantDef.payload, ctx.env);
              const payloadCType = cTypeName(payloadFitType);
              out.push(`${ind(depth + 2)}${payloadCType} ${bindName} = ${tmpName}.${pat.name};`);
              armState.varTypes.set(bindName, payloadFitType);
              if (payloadFitType.kind === "resource") {
                armState.live.push({ name: bindName, cleanupFn: payloadFitType.cleanup });
              }
            }
          }

          emitStmts(arm.body, depth + 2, ctx, retType, armState, false, out);
          if (!armState.returned) out.push(`${ind(depth + 2)}break;`);
          out.push(`${ind(depth + 1)}}`);
        }
      }

      // Step 7: synthesize default abort() arm if no wildcard was present.
      if (!hasWildcard) {
        out.push(`${ind(depth + 1)}default: abort(); break;`);
      }

      // Step 8: close switch and outer block.
      out.push(`${ind(depth + 1)}}`);
      out.push(`${ind(depth)}}`);

      // Step 9: merge post-arm live sets (mirrors if post-state propagation).
      const nonReturned = armStates.filter(s => !s.returned);
      if (nonReturned.length === 0) {
        state.returned = true;
      } else {
        state.live = nonReturned[0].live;
      }
      break;
    }

    default:
      throw new Error(`codegen: unsupported stmt kind '${(stmt as any).kind}'`);
  }
}

function emitExpr(
  expr: Expr,
  depth: number,
  ctx: CodegenCtx,
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
      const inner = emitExpr(expr.expr, depth, ctx, retType, state, out);
      if (expr.expr.kind === "var" && inner.fitType.kind === "resource") {
        const idx = state.live.findIndex(v => v.name === (expr.expr as { name: string }).name);
        if (idx >= 0) state.live.splice(idx, 1);
      }
      const cName = cTypeName(retType);
      return { cExpr: `(${cName}){0, {.ok = ${inner.cExpr}}}`, fitType: retType };
    }

    case "err": {
      const inner = emitExpr(expr.expr, depth, ctx, retType, state, out);
      const cName = cTypeName(retType);
      const errSlot = retType.kind === "result" ? retType.err : null;
      const wrapped = wrapErrMember(inner.cExpr, inner.fitType, errSlot);
      return { cExpr: `(${cName}){1, {.err = ${wrapped}}}`, fitType: retType };
    }

    case "call": {
      if (expr.fn === "drop") {
        const arg = expr.args[0];
        if (arg.kind === "var") {
          const idx = state.live.findIndex(v => v.name === arg.name);
          if (idx >= 0) {
            const v = state.live[idx];
            state.live.splice(idx, 1);
            out.push(`${ind(depth)}${v.cleanupFn}(${arg.name});`);
          }
        }
        return { cExpr: "(void)0", fitType: { kind: "unit", mode: "unrestricted" } };
      }

      const sig = ctx.env.functions.get(expr.fn);
      if (!sig) {
        const argExprs = expr.args.map(a => emitExpr(a, depth, ctx, retType, state, out).cExpr);
        return {
          cExpr: `${expr.fn}(${argExprs.join(", ")})`,
          fitType: { kind: "plain", mode: "unrestricted", name: "?" },
        };
      }

      const argExprs: string[] = [];
      for (let i = 0; i < sig.params.length && i < expr.args.length; i++) {
        const arg   = expr.args[i];
        const param = sig.params[i];
        const { cExpr: argCExpr } = emitExpr(arg, depth, ctx, retType, state, out);
        argExprs.push(argCExpr);
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
      const inner = emitExpr(expr.expr, depth, ctx, retType, state, out);
      const tmpName = `_t${state.tmp.n++}`;
      const innerCType = cTypeName(inner.fitType);

      out.push(`${ind(depth)}${innerCType} ${tmpName} = ${inner.cExpr};`);
      out.push(`${ind(depth)}if (${tmpName}.tag != 0) {`);
      for (const v of [...state.live].reverse()) {
        out.push(`${ind(depth + 1)}${v.cleanupFn}(${v.name});`);
      }
      const retCType = cTypeName(retType);
      const innerErrType = inner.fitType.kind === "result" ? inner.fitType.err : null;
      const errSlot = retType.kind === "result" ? retType.err : null;
      const wrappedErr = innerErrType !== null
        ? wrapErrMember(`${tmpName}.err`, innerErrType, errSlot)
        : `${tmpName}.err`;
      out.push(`${ind(depth + 1)}${retCType} _err = {1, {.err = ${wrappedErr}}};`);
      out.push(`${ind(depth + 1)}return _err;`);
      out.push(`${ind(depth)}}`);

      const okFitType = inner.fitType.kind === "result"
        ? inner.fitType.ok
        : { kind: "unit" as const, mode: "unrestricted" as const };
      return { cExpr: `${tmpName}.ok`, fitType: okFitType };
    }

    case "qualified_var": {
      // Emit the correct C value for an enum variant reference.
      // Unit-only enum: EnumName_VariantName (C enum constant).
      // Has-payload enum: (EnumName){.tag = INDEX} (tagged-union struct literal).
      const hasPayload = enumHasPayload(expr.enumName, ctx);
      const idx = variantIndexOf(expr.enumName, expr.name, ctx);
      const cExpr = hasPayload
        ? `(${expr.enumName}){.tag = ${idx}}`
        : `${expr.enumName}_${expr.name}`;
      const enumInfo = ctx.env.enumDecls.get(expr.enumName);
      const mode = enumInfo?.isLinear ? "linear" as const : "unrestricted" as const;
      return { cExpr, fitType: { kind: "enum", mode, name: expr.enumName } };
    }

    case "int_lit":
      return { cExpr: String(expr.value), fitType: { kind: "plain", mode: "unrestricted", name: "Int" } };

    case "bool_lit":
      // C99 has no `bool` without <stdbool.h>, and Bool lowers as a plain (int) type.
      return {
        cExpr: expr.value ? "1" : "0",
        fitType: { kind: "plain", mode: "unrestricted", name: "Bool" },
      };

    case "binop": {
      if (expr.op === "/" || expr.op === "%") {
        return emitDivMod(expr, depth, ctx, retType, state, out);
      }
      const left = emitExpr(expr.left, depth, ctx, retType, state, out);
      const right = emitExpr(expr.right, depth, ctx, retType, state, out);
      // Parenthesise so C precedence cannot disagree with FIT's — precedence was
      // already resolved by the parser; this just protects the resulting string.
      const cExpr = `(${left.cExpr} ${expr.op} ${right.cExpr})`;
      const isArith = expr.op === "+" || expr.op === "-" || expr.op === "*";
      const fitType: FitType = {
        kind: "plain",
        mode: "unrestricted",
        name: isArith ? "Int" : "Bool",
      };
      return { cExpr, fitType };
    }

    default: {
      const _exhaustive: never = expr;
      return { cExpr: "0", fitType: { kind: "unit", mode: "unrestricted" } };
    }
  }
}

// Division/modulo push statements onto `out` exactly as the "try" case does (§1.3):
// temps for the once-evaluated left operand and divisor, a zero-check, and construction
// of the Ok/Err Result value — then the temp itself (not `.ok`) is returned as cExpr, so
// a wrapping `?` (the existing, unmodified "try" case) unwraps it exactly as it does for
// a call.
//
// Both operands are bound to their own temps *before* the zero-check, in source
// (left-to-right) order, and the branch below uses only the temps — never
// left.cExpr/right.cExpr directly. This matters beyond the usual "evaluate once" reason
// division/modulo already had for the divisor: if left.cExpr is itself a call that moves
// a linear resource (e.g. `use_conn(c) / n` where `use_conn` takes `c: move Conn`),
// splicing it inline inside the `else` branch means the call — and the move the checker
// already recorded as unconditional — would only execute when the divisor is nonzero.
// The checker never emits cleanup for `c` (it's consumed), so on the `n == 0` path `c`
// would be opened and never closed: a linear resource leak reachable from a
// checker-accepted program. Binding left to a temp unconditionally, ahead of the
// zero-check, makes the C match what the checker already assumes.
function emitDivMod(
  expr: Expr & { kind: "binop" },
  depth: number,
  ctx: CodegenCtx,
  retType: FitType,
  state: EmitState,
  out: string[]
): { cExpr: string; fitType: FitType } {
  const left = emitExpr(expr.left, depth, ctx, retType, state, out);
  const right = emitExpr(expr.right, depth, ctx, retType, state, out);

  // Bind the left operand to its own temp, unconditionally, before the divisor and the
  // zero-check — see the function comment above for why this must not be deferred into
  // the `else` branch below.
  const leftTmp = `_t${state.tmp.n++}`;
  out.push(`${ind(depth)}Int ${leftTmp} = ${left.cExpr};`);

  // Bind the divisor to its own temp before the zero-check — otherwise the check and
  // the division/modulo each evaluate `right` again, which is wrong if it has side
  // effects and wasteful even if it doesn't.
  const divisorTmp = `_t${state.tmp.n++}`;
  out.push(`${ind(depth)}Int ${divisorTmp} = ${right.cExpr};`);

  const resultCType = cTypeName(DIV_RESULT_TYPE);
  const resultTmp = `_t${state.tmp.n++}`;
  out.push(`${ind(depth)}${resultCType} ${resultTmp};`);
  out.push(`${ind(depth)}if (${divisorTmp} == 0) {`);
  out.push(`${ind(depth + 1)}${resultTmp} = (${resultCType}){1, {.err = DivByZero_DivByZero}};`);
  out.push(`${ind(depth)}} else {`);
  out.push(
    `${ind(depth + 1)}${resultTmp} = (${resultCType}){0, {.ok = (${leftTmp} ${expr.op} ${divisorTmp})}};`
  );
  out.push(`${ind(depth)}}`);

  return { cExpr: resultTmp, fitType: DIV_RESULT_TYPE };
}
