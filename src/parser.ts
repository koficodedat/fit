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

  private parseRecord(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseEnum(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseResource(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseTypeAlias(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseCapability(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseFn(_pos: Pos): Decl {
    throw new Error("TODO");
  }

  private parseType(): Type {
    throw new Error("TODO");
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
