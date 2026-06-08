import { loadProgram } from "./loader";
import { check } from "./checker";
import { codegen } from "./codegen";

function printErrors(
  errors: { pos: { line: number; col: number; file: string }; message: string }[]
): void {
  for (const err of errors) {
    console.error(`${err.pos.file}:${err.pos.line}:${err.pos.col}: ${err.message}`);
  }
}

const [, , cmd, file] = process.argv;

if (!cmd || !file) {
  console.error("Usage: fit <check|codegen> <file>");
  process.exit(1);
}

const { program, loadErrors } = loadProgram(file);

if (loadErrors.length > 0) {
  printErrors(loadErrors);
  process.exit(1);
}

if (cmd === "check") {
  const errors = check(program);
  if (errors.length === 0) process.exit(0);
  printErrors(errors);
  process.exit(1);
} else if (cmd === "codegen") {
  const errors = check(program);
  if (errors.length > 0) {
    printErrors(errors);
    process.exit(1);
  }
  process.stdout.write(codegen(program));
  process.exit(0);
} else {
  console.error(`fit: unknown command '${cmd}'`);
  process.exit(1);
}
