#!/usr/bin/env bun
// `openslate guide check` on every guide in the repo: the state guide and each county's.

import { existsSync, readdirSync } from "node:fs";

const dirs = [
  "guide",
  ...(existsSync("county") ? readdirSync("county").sort() : []).map((name) => `county/${name}`),
];
let failed = false;
for (const dir of dirs) {
  const run = Bun.spawnSync(
    ["bun", ".openslate/packages/cli/src/index.ts", "guide", "check", dir],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (run.exitCode !== 0) failed = true;
}
if (failed) process.exit(1);
