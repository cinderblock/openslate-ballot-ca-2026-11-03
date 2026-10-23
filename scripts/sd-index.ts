#!/usr/bin/env bun
// Index San Diego County's Voter Information Pamphlets for one election. San Diego publishes
// one ~10 MB pamphlet per ballot type (several hundred of them), each assembled from shared
// sections: a candidate's statement or a measure's analysis appears in every ballot type that
// carries that contest. Downloading them all would be gigabytes, so this reads only each
// pamphlet's bookmarks (about 0.6 MB through range requests), which list the contests on that
// ballot type. scripts/scrape-sd.ts then downloads just enough pamphlets to cover every contest.
//
// Resumable: what's been read is kept in evidence/county/sd/ballot-types.json, and a ballot
// type whose size and date haven't changed isn't read again. Paced, one request at a time.
//
//   bun scripts/sd-index.ts [--max 900]

import { existsSync, mkdirSync } from "node:fs";
import { now } from "./lib/guide-common";
import { openRemotePdf, outlineTitles } from "./lib/pdf-range";

const BASE = "https://www.sdvote.com/content/dam/rov/en/sb";
const EVIDENCE = "evidence/county/sd";
const INDEX = `${EVIDENCE}/ballot-types.json`;
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const max = Number(process.argv[process.argv.indexOf("--max") + 1] || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BallotType {
  type: number;
  url: string;
  bytes: number;
  lastModified: string;
  retrieved_at: string;
  /** The pamphlet's bookmarks: the contests on this ballot type, then its sections. */
  outline: string[];
}

mkdirSync(EVIDENCE, { recursive: true });
const index: Record<string, BallotType> = existsSync(INDEX)
  ? JSON.parse(await Bun.file(INDEX).text())
  : {};
const save = () => Bun.write(INDEX, `${JSON.stringify(index, null, 2)}\n`);

let found = 0;
let read = 0;
let total = 0;
for (let n = 1; n <= max; n++) {
  const url = `${BASE}/SB-ENG-${n}.pdf`;
  const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
  await sleep(150);
  if (head.status === 404) continue;
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  found++;
  const bytes = Number(head.headers.get("content-length"));
  const lastModified = head.headers.get("last-modified") ?? "";
  const known = index[String(n)];
  if (known && known.bytes === bytes && known.lastModified === lastModified) continue;
  const pdf = await openRemotePdf(url, { userAgent: USER_AGENT });
  const outline = await outlineTitles(pdf.doc);
  total += pdf.fetched().bytes;
  await pdf.close();
  index[String(n)] = { type: n, url, bytes, lastModified, retrieved_at: now(), outline };
  read++;
  if (read % 10 === 0) await save();
  console.error(
    `SB-ENG-${n}: ${outline.length} bookmarks (${(total / 1e6).toFixed(0)} MB read so far)`,
  );
  await sleep(300);
}
await save();
console.error(`${found} ballot types, ${read} read now (${(total / 1e6).toFixed(0)} MB)`);
