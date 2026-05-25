// @ts-check
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");
const prettier = require("eslint-config-prettier");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Allow explicit any in test/scratch contexts — too noisy for a PoC
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused vars: error on non-underscore-prefixed names; underscore prefix = intentional
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // No floating promises — keeps async discipline if added later
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  // Disable formatting rules that conflict with Prettier
  prettier,
];
