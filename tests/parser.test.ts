import { Program, Decl, Stmt, Expr, Type, Pattern } from "../src/ast";

test("ast types import", () => {
  const _: Program = { decls: [] };
  expect(_.decls).toHaveLength(0);
});
