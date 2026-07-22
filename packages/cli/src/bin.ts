#!/usr/bin/env node
// Executable entry point for the `motionscore` command (task 9.3).
//
// This is the thin process shim referenced by the `bin` fields in both this
// package's package.json (`./dist/bin.js`) and the repo root
// (`packages/cli/dist/bin.js`). All real work lives in `main` (the testable
// core in `main.ts`, which never calls `process.exit`); this shim just maps the
// returned exit code onto the process. An unexpected rejection is reported and
// mapped to a non-zero exit so a failure can never masquerade as success.
//
// The shebang above MUST remain the first line of this file: `tsc` only
// preserves a `#!` shebang on emit when it is the very first line of the
// source, which is what makes the compiled `dist/bin.js` directly executable on
// POSIX systems (`chmod`/`node_modules/.bin` symlink). On Windows, npm generates
// the `.cmd`/PowerShell wrappers from the `bin` field regardless.

import { main } from './main.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
