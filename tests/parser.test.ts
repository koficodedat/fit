import { Program, Decl, Stmt, Expr, Type, Pattern } from "../src/ast";
import { parse } from "../src/parser";

test("ast types import", () => {
  const _: Program = { decls: [] };
  expect(_.decls).toHaveLength(0);
});

test("parse empty program", () => {
  const prog = parse("", "empty.fit");
  expect(prog.decls).toHaveLength(0);
});

test("parse skips line comments", () => {
  const prog = parse("// this is a comment\n", "comment.fit");
  expect(prog.decls).toHaveLength(0);
});

test("parse skips block comments", () => {
  const prog = parse("/* block\n   comment */", "block.fit");
  expect(prog.decls).toHaveLength(0);
});
