import {
  Program, Decl, Stmt, Expr, Type, Pattern, Pos,
  FieldDef, ParamDef, CleanupDef, VariantDef, MatchArm
} from "./ast";

class Parser {
  private src: string;
  private idx = 0;
  private line = 1;
  private col = 1;
  private filename: string;

  constructor(src: string, filename: string) {
    this.src = src;
    this.filename = filename;
  }

  private advance(): string {
    const ch = this.src[this.idx] ?? "";
    this.idx++;
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private peek(offset = 0): string {
    return this.src[this.idx + offset] ?? "";
  }

  private skip(): void {
    while (this.idx < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        // Line comment
        while (this.idx < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
      } else if (ch === "/" && this.peek(1) === "*") {
        // Block comment
        this.advance(); // consume /
        this.advance(); // consume *
        while (this.idx < this.src.length) {
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.advance(); // consume *
            this.advance(); // consume /
            break;
          }
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private pos(): Pos {
    return { line: this.line, col: this.col };
  }

  private err(msg: string): never {
    throw new Error(`${this.filename}:${this.line}:${this.col}: ${msg}`);
  }

  private ident(): string {
    this.skip();
    let s = "";
    const first = this.peek();
    if (!/[a-zA-Z_]/.test(first)) {
      this.err(`expected identifier, got '${first}'`);
    }
    while (/[a-zA-Z0-9_]/.test(this.peek())) {
      s += this.advance();
    }
    return s;
  }

  private expect(s: string): void {
    this.skip();
    for (const ch of s) {
      if (this.peek() !== ch) {
        this.err(`expected '${s}', got '${this.peek()}'`);
      }
      this.advance();
    }
  }

  parseProgram(): Program {
    const decls: Decl[] = [];
    this.skip();
    while (this.idx < this.src.length) {
      decls.push(this.parseDecl());
      this.skip();
    }
    return { decls };
  }

  private parseDecl(): Decl {
    this.skip();
    const p = this.pos();
    let kw = "";
    while (/[a-zA-Z_]/.test(this.peek())) {
      kw += this.advance();
    }
    switch (kw) {
      case "record":
        return this.parseRecord(p);
      case "enum":
        return this.parseEnum(p);
      case "resource":
        return this.parseResource(p);
      case "type":
        return this.parseTypeAlias(p);
      case "capability":
        return this.parseCapability(p);
      case "fn":
        return this.parseFn(p);
      default:
        this.err(`unexpected top-level keyword '${kw}'`);
    }
  }

  private parseCapability(pos: Pos): Decl {
    const name = this.ident();
    return { kind: "capability", name, pos };
  }

  private parseRecord(pos: Pos): Decl {
    const name = this.ident();
    this.expect("{");
    const fields: FieldDef[] = [];
    this.skip();
    while (this.peek() !== "}") {
      const fname = this.ident();
      this.expect(":");
      const type_ = this.parseType();
      fields.push({ name: fname, type_ });
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect("}");
    return { kind: "record", name, fields, pos };
  }

  private parseEnum(pos: Pos): Decl {
    const name = this.ident();
    this.expect("{");
    const variants: VariantDef[] = [];
    this.skip();
    while (this.peek() !== "}") {
      const vname = this.ident();
      this.skip();
      let payload: Type | null = null;
      if (this.peek() === "(") {
        this.advance(); // consume (
        payload = this.parseType();
        this.expect(")");
      }
      variants.push({ name: vname, payload });
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect("}");
    return { kind: "enum", name, variants, pos };
  }

  private parseTypeAlias(pos: Pos): Decl {
    const name = this.ident();
    this.expect("=");
    const members: string[] = [];
    members.push(this.ident());
    this.skip();
    while (this.peek() === "|") {
      this.advance(); // consume |
      members.push(this.ident());
      this.skip();
    }
    return { kind: "type_alias", name, members, pos };
  }

  private parseResource(pos: Pos): Decl {
    const name = this.ident();
    this.skip();
    let typeParam: string | null = null;
    if (this.peek() === "<") {
      this.advance(); // consume <
      typeParam = this.ident();
      this.expect(">");
    }
    this.expect("{");
    const fields: FieldDef[] = [];
    let cleanup: CleanupDef | null = null;
    this.skip();
    while (this.peek() !== "}") {
      const fname = this.ident();
      this.expect(":");
      this.skip();
      if (fname === "cleanup") {
        const kw = this.ident();
        if (kw === "fallback") {
          cleanup = { fallback: true, fn: this.ident() };
        } else {
          cleanup = { fallback: false, fn: kw };
        }
      } else {
        const type_ = this.parseType();
        fields.push({ name: fname, type_ });
      }
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect("}");
    if (!cleanup) this.err(`resource '${name}' missing cleanup field`);
    return { kind: "resource", name, typeParam, fields, cleanup: cleanup as CleanupDef, pos };
  }

  private parseFn(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseType(): Type {
    this.skip();
    if (this.peek() === "(") {
      // unit type ()
      this.advance();
      this.expect(")");
      return { kind: "unit" };
    }
    // read type name
    const name = this.ident();
    if (name === "Result") {
      this.expect("<");
      const ok = this.parseType();
      this.expect(",");
      const err = this.parseType();
      this.skip();
      this.expect(">");
      return { kind: "result", ok, err };
    }
    this.skip();
    let typeArg: Type | null = null;
    if (this.peek() === "<") {
      this.advance();
      typeArg = this.parseType();
      this.skip();
      this.expect(">");
    }
    return { kind: "named", name, typeArg };
  }

  private parseBlock(): Stmt[] {
    throw new Error("TODO");
  }

  private parseStmt(): Stmt {
    throw new Error("TODO");
  }

  private parseExpr(): Expr {
    throw new Error("TODO");
  }

  private parsePattern(): Pattern {
    throw new Error("TODO");
  }
}

export function parse(src: string, filename: string): Program {
  return new Parser(src, filename).parseProgram();
}
