#!/usr/bin/env ts-node
// Regenerate a codegen snapshot (.fit.c.expected) for a given .fit file.
// Usage: npx ts-node scripts/regen-snapshot.ts <path/to/program.fit>
//
// Reads the .fit file, runs loader + codegen, writes output to <file>.c.expected.
// Run this explicitly when codegen output changes intentionally; review the diff before committing.

import * as fs from "fs";
import * as path from "path";
import { loadProgram } from "../src/loader";
import { check } from "../src/checker";
import { codegen } from "../src/codegen";

const [, , fitFile] = process.argv;

if (!fitFile) {
  console.error("Usage: npx ts-node scripts/regen-snapshot.ts <path/to/program.fit>");
  process.exit(1);
}

const absPath = path.resolve(fitFile);
if (!fs.existsSync(absPath)) {
  console.error(`Error: file not found: ${absPath}`);
  process.exit(1);
}

const { program, loadErrors } = loadProgram(absPath);
if (loadErrors.length > 0) {
  console.error("Load errors:");
  for (const e of loadErrors) console.error(`  ${e.message}`);
  process.exit(1);
}

const checkErrors = check(program);
if (checkErrors.length > 0) {
  console.error("Type-check errors (snapshot not written):");
  for (const e of checkErrors) console.error(`  ${e.message}`);
  process.exit(1);
}

const output = codegen(program);
const outPath = absPath + ".c.expected";
fs.writeFileSync(outPath, output, "utf-8");
console.log(`Written: ${outPath}`);
