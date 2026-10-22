#!/usr/bin/env bun
// Fetch OpenSlate at the pinned ref into .openslate/ for local development.
// CI workflows inline the equivalent steps for visibility.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const REF = (await Bun.file(".openslate-version").text()).trim();
const TARGET = ".openslate";

if (existsSync(join(TARGET, ".git"))) {
  const current = (await $`git -C ${TARGET} rev-parse HEAD`.quiet().text()).trim();
  if (current === REF) {
    console.log(`.openslate already at ${REF}`);
  } else {
    console.log(`updating .openslate ${current.slice(0, 8)} -> ${REF.slice(0, 8)}`);
    await $`git -C ${TARGET} fetch --quiet origin`;
    await $`git -C ${TARGET} checkout --quiet ${REF}`;
  }
} else {
  console.log(`cloning OpenSlate @ ${REF.slice(0, 8)}`);
  await $`git clone --quiet https://github.com/cinderblock/openslate.git ${TARGET}`;
  await $`git -C ${TARGET} checkout --quiet ${REF}`;
}

console.log("installing OpenSlate deps...");
await $`bun install --frozen-lockfile`.cwd(TARGET);
console.log("done.");
