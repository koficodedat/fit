import * as fs from "fs";
import * as path from "path";
import { parse, ParseError } from "./parser";
import { Program, Decl, Pos } from "./ast";

export type LoadError = { message: string; pos: Pos };

export function loadProgram(
  rootPath: string
): { program: Program; loadErrors: LoadError[] } {
  const loadErrors: LoadError[] = [];
  // Files already assembled into the output — prevents re-inclusion on diamond paths
  // and also prevents re-parsing (any file in `included` was already read+parsed).
  const included = new Set<string>();

  function loadDecls(absPath: string, importPos: Pos, stack: string[]): Decl[] {
    const norm = path.resolve(absPath);

    // Cycle: file is currently being loaded in this call chain
    const cycleIdx = stack.indexOf(norm);
    if (cycleIdx !== -1) {
      const cycle = [...stack.slice(cycleIdx), norm]
        .map(p => path.basename(p))
        .join(" → ");
      loadErrors.push({ message: `import cycle detected: ${cycle}`, pos: importPos });
      return [];
    }

    // Diamond: already fully assembled in an earlier branch — skip without re-parsing
    if (included.has(norm)) return [];

    let src: string;
    try {
      src = fs.readFileSync(norm, "utf8").replace(/^﻿/, "");
    } catch {
      included.add(norm);
      loadErrors.push({
        message: `cannot read '${path.basename(norm)}'`,
        pos: importPos,
      });
      return [];
    }

    let prog: Program;
    try {
      prog = parse(src, norm);
    } catch (e: unknown) {
      included.add(norm);
      if (e instanceof ParseError) {
        loadErrors.push({ message: e.rawMessage, pos: e.pos });
      } else {
        loadErrors.push({ message: e instanceof Error ? e.message : String(e), pos: importPos });
      }
      return [];
    }

    // Mark included before recursing — any re-entry through a second import path
    // while this file's children are being processed hits the cycle check (via stack),
    // not the diamond check (via included), which is the correct distinction.
    included.add(norm);

    const dir = path.dirname(norm);
    const nextStack = [...stack, norm];
    const decls: Decl[] = [];

    for (const decl of prog.decls) {
      if (decl.kind === "import") {
        const depPath = path.join(dir, `${decl.name}.fit`);
        decls.push(...loadDecls(depPath, decl.pos, nextStack));
      } else {
        decls.push(decl);
      }
    }

    return decls;
  }

  const rootAbs = path.resolve(rootPath);
  const rootPos: Pos = { line: 1, col: 1, file: rootAbs };
  const decls = loadDecls(rootAbs, rootPos, []);
  return { program: { decls }, loadErrors };
}
