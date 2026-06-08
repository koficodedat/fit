import {
  Program,
  Decl,
  Stmt,
  Expr,
  Type,
  Pattern,
  Pos,
  FieldDef,
  ParamDef,
  CleanupDef,
  VariantDef,
  MatchArm,
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
        let closed = false;
        while (this.idx < this.src.length) {
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.advance(); // consume *
            this.advance(); // consume /
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) this.err("unterminated block comment");
      } else {
        break;
      }
    }
  }

  private pos(): Pos {
    return { line: this.line, col: this.col, file: this.filename };
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
      if (this.peek() === ",") {
        this.advance();
        this.skip();
      }
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
      if (this.peek() === ",") {
        this.advance();
        this.skip();
      }
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
      if (this.peek() === ",") {
        this.advance();
        this.skip();
      }
    }
    this.expect("}");
    if (!cleanup) this.err(`resource '${name}' missing cleanup field`);
    return { kind: "resource", name, typeParam, fields, cleanup: cleanup as CleanupDef, pos };
  }

  private peekIdent(): string {
    let i = this.idx;
    while (i < this.src.length && /[ \t\r\n]/.test(this.src[i])) i++;
    let s = "";
    while (i < this.src.length && /[a-zA-Z_0-9]/.test(this.src[i])) s += this.src[i++];
    return s;
  }

  private parseFn(pos: Pos): Decl {
    const name = this.ident();
    this.expect("(");
    const params: ParamDef[] = [];
    this.skip();
    while (this.peek() !== ")") {
      const pname = this.ident();
      this.expect(":");
      this.skip();
      let annotatedMode: "move" | "lend" | null = null;
      const maybeMode = this.peekIdent();
      if (maybeMode === "move" || maybeMode === "lend") {
        annotatedMode = this.ident() as "move" | "lend";
      }
      const type_ = this.parseType();
      params.push({ name: pname, type_, annotatedMode });
      this.skip();
      if (this.peek() === ",") {
        this.advance();
        this.skip();
      }
    }
    this.expect(")");
    // optional using clause
    const caps: string[] = [];
    this.skip();
    if (this.peekIdent() === "using") {
      this.ident(); // consume "using"
      caps.push(this.ident());
      this.skip();
      while (this.peek() === ",") {
        this.advance();
        caps.push(this.ident());
        this.skip();
      }
    }
    this.expect("->");
    const returnType = this.parseType();
    this.skip();
    let body: Stmt[] | null = null;
    if (this.peek() === "{") {
      body = this.parseBlock();
    }
    return { kind: "fn", name, params, caps, returnType, body, pos };
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
    this.expect("{");
    const stmts: Stmt[] = [];
    this.skip();
    while (this.peek() !== "}") {
      stmts.push(this.parseStmt());
      this.skip();
    }
    this.expect("}");
    return stmts;
  }

  private parseStmt(): Stmt {
    this.skip();
    const p = this.pos();

    // let / let mut
    if (this.peekIdent() === "let") {
      this.ident(); // consume "let"
      this.skip();
      let mut = false;
      if (this.peekIdent() === "mut") {
        this.ident();
        mut = true;
      }
      const name = this.ident();
      this.expect("=");
      const init = this.parseExpr();
      return { kind: "let", name, mut, init, pos: p };
    }

    // break
    if (this.peekIdent() === "break") {
      this.ident(); // consume "break"
      return { kind: "break", pos: p };
    }

    // if
    if (this.peekIdent() === "if") {
      return this.parseIf(p);
    }

    // loop
    if (this.peekIdent() === "loop") {
      return this.parseLoop(p);
    }

    // match
    if (this.peekIdent() === "match") {
      return this.parseMatchStmt(p);
    }

    // select
    if (this.peekIdent() === "select") {
      return this.parseSelect(p);
    }

    // unit value expression statement: ()
    if (this.peek() === "(" && this.peek(1) === ")") {
      const expr = this.parseExpr(); // consumes ()
      return { kind: "expr", expr, pos: p };
    }

    // expression or rebind — read leading identifier first
    const name = this.ident();
    this.skip();
    if (this.peek() === "=" && this.peek(1) !== "=") {
      this.advance(); // consume =
      const expr = this.parseExpr();
      return { kind: "rebind", name, expr, pos: p };
    }
    // expression statement — re-enter parseExpr with name already consumed
    const expr = this.parseExprFromName(name, p);
    return { kind: "expr", expr, pos: p };
  }

  private parseExprFromName(name: string, p: Pos): Expr {
    this.skip();
    // Qualified access: EnumName.Member — semantic interpretation deferred to checker
    if (this.peek() === "." && /[a-zA-Z_]/.test(this.peek(1))) {
      this.advance(); // consume "."
      const memberName = this.ident();
      const e: Expr = { kind: "qualified_var", enumName: name, name: memberName, pos: p };
      return this.parseTry(e);
    }
    if (this.peek() === "(") {
      this.advance(); // consume (
      this.skip();
      if (name === "Ok") {
        const inner = this.parseExpr();
        this.skip();
        this.expect(")");
        const e: Expr = { kind: "ok", expr: inner, pos: p };
        return this.parseTry(e);
      }
      if (name === "Err") {
        const inner = this.parseExpr();
        this.skip();
        this.expect(")");
        const e: Expr = { kind: "err", expr: inner, pos: p };
        return this.parseTry(e);
      }
      const args: Expr[] = [];
      while (this.peek() !== ")") {
        args.push(this.parseExpr());
        this.skip();
        if (this.peek() === ",") {
          this.advance();
          this.skip();
        }
      }
      this.expect(")");
      const e: Expr = { kind: "call", fn: name, args, pos: p };
      return this.parseTry(e);
    }
    const e: Expr = { kind: "var", name, pos: p };
    return this.parseTry(e);
  }

  private parseTry(e: Expr): Expr {
    this.skip();
    if (this.peek() === "?") {
      const p = this.pos();
      this.advance();
      return { kind: "try", expr: e, pos: p };
    }
    return e;
  }

  private parseExpr(): Expr {
    this.skip();
    const p = this.pos();
    if (this.peek() === "(" && this.peek(1) === ")") {
      this.advance();
      this.advance();
      return { kind: "unit_val", pos: p };
    }
    const name = this.ident();
    return this.parseExprFromName(name, p);
  }

  private parseIf(p: Pos): Stmt {
    this.ident(); // consume "if"
    const cond = this.parseExpr();
    const then = this.parseBlock();
    this.skip();
    if (this.peekIdent() !== "else") this.err("expected 'else' after if block");
    this.ident(); // consume "else"
    const else_ = this.parseBlock();
    return { kind: "if", cond, then, else_, pos: p };
  }

  private parseLoop(p: Pos): Stmt {
    this.ident(); // consume "loop"
    const body = this.parseBlock();
    return { kind: "loop", body, pos: p };
  }

  private parsePattern(): Pattern {
    this.skip();
    if (this.peek() === "_") {
      this.advance();
      return { kind: "wildcard" };
    }
    const first = this.ident();
    this.skip();
    // Qualified variant: EnumName.VariantName
    let qualifier: string | null = null;
    let name = first;
    if (this.peek() === "." && /[a-zA-Z_]/.test(this.peek(1))) {
      this.advance(); // consume "."
      qualifier = first;
      name = this.ident();
      this.skip();
    }
    const binds: string[] = [];
    if (this.peek() === "(") {
      this.advance();
      this.skip();
      while (this.peek() !== ")") {
        binds.push(this.ident());
        this.skip();
        if (this.peek() === ",") {
          this.advance();
          this.skip();
        }
      }
      this.expect(")");
    }
    return { kind: "variant", qualifier, name, binds };
  }

  private parseMatchStmt(p: Pos): Stmt {
    this.ident(); // consume "match"
    const expr = this.parseExpr();
    this.expect("{");
    const arms: MatchArm[] = [];
    this.skip();
    while (this.peek() !== "}") {
      const pattern = this.parsePattern();
      this.skip();
      this.expect("=>");
      this.skip();
      let body: Stmt[];
      if (this.peek() === "{") {
        body = this.parseBlock();
      } else {
        body = [this.parseStmt()];
      }
      this.skip();
      if (this.peek() === ",") {
        this.advance();
        this.skip();
      }
      arms.push({ pattern, body });
    }
    this.expect("}");
    return { kind: "match", expr, arms, pos: p };
  }

  private parseSelect(p: Pos): Stmt {
    this.ident(); // consume "select"
    const atoms: string[] = [];
    atoms.push(this.ident());
    this.skip();
    while (this.peek() === ",") {
      this.advance();
      atoms.push(this.ident());
      this.skip();
    }
    this.expect("from");
    const from = this.ident();
    return { kind: "select", atoms, from, pos: p };
  }
}

export function parse(src: string, filename: string): Program {
  return new Parser(src, filename).parseProgram();
}
