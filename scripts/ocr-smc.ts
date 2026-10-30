#!/usr/bin/env bun
// Reads the scans San Mateo County Elections filed (see scrape-smc.ts) with Windows' built-in OCR
// and keeps what it read, one file per document, named by the document's SHA-256:
//
//   evidence/county/san-mateo/ocr/<sha256>.json   { engine, scale, pages: [{ page, width, height, lines }] }
//
// The scans are what the county published; this is a machine's reading of them, and it makes
// mistakes (hand-printed names especially). Nothing here is corrected by hand. scrape-smc.ts
// builds the guide's text from these files and marks it as read by machine.
//
// Windows only (the OCR engine is part of Windows). The results are committed, so building the
// guide needs no OCR. Re-running skips documents already read.
//
//   bun scripts/ocr-smc.ts [--jobs 3] [--only <sha256-prefix>]

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVIDENCE = "evidence/county/san-mateo";
const CACHE = ".cache/county/san-mateo";
const OCR = join(EVIDENCE, "ocr");
const SCRIPT = "scripts/lib/ocr-pdf.ps1";
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const jobs = Number(argAfter("--jobs") ?? 3);
const only = argAfter("--only");

if (process.platform !== "win32") {
  console.error(
    "OCR needs Windows' built-in engine; the committed results are in evidence/.../ocr/.",
  );
  process.exit(1);
}

interface Retrieved {
  url: string;
  title: string;
  sha256: string;
}
const index = JSON.parse(await Bun.file(join(EVIDENCE, "index.json")).text()) as Record<
  string,
  Retrieved
>;
mkdirSync(OCR, { recursive: true });

const todo = Object.values(index).filter(
  (doc) => !existsSync(join(OCR, `${doc.sha256}.json`)) && (!only || doc.sha256.startsWith(only)),
);
console.log(`${todo.length} of ${Object.keys(index).length} documents to read`);

async function read(doc: Retrieved): Promise<void> {
  const pdf = join(CACHE, decodeURIComponent(new URL(doc.url).pathname).replace(/^\/+/, ""));
  const tmp = join(tmpdir(), `ocr-${doc.sha256.slice(0, 12)}.json`);
  const started = Date.now();
  const proc = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT,
      "-Pdf",
      pdf,
      "-Out",
      tmp,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${doc.title}: OCR failed (${code}) ${err.slice(0, 300)}`);
  const result = JSON.parse((await Bun.file(tmp).text()).replace(/^﻿/, ""));
  await Bun.write(join(OCR, `${doc.sha256}.json`), `${JSON.stringify(result)}\n`);
  await Bun.file(tmp).delete();
  console.log(
    `${doc.sha256.slice(0, 8)} ${result.pages.length}p ${((Date.now() - started) / 1000).toFixed(0)}s ${doc.title}`,
  );
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) await read(doc);
  }),
);
