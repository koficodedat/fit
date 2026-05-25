import * as fs from "fs";
import { parse } from "./parser";
import { check } from "./checker";

const [, , cmd, file] = process.argv;

if (cmd !== "check" || !file) {
  console.error("Usage: fit check <file>");
  process.exit(1);
}

let src: string;
try {
  src = fs.readFileSync(file, "utf8");
} catch {
  console.error(`fit: cannot read '${file}'`);
  process.exit(1);
}

let errors;
try {
  errors = check(parse(src, file));
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`fit: parse error in '${file}': ${msg}`);
  process.exit(1);
}

if (errors.length === 0) {
  process.exit(0);
}

for (const err of errors) {
  console.error(`${file}:${err.pos.line}:${err.pos.col}: ${err.message}`);
}
process.exit(1);
