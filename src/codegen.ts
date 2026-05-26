import { Program, Decl, Stmt } from "./ast";
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

  return out.join("\n");
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

// Placeholder — implemented in Task 3
function emitFnImpl(
  _decl: Decl & { kind: "fn"; body: Stmt[] },
  _env: TypeEnv
): string {
  return "/* TODO: emitFnImpl */";
}
