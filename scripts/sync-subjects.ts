#!/usr/bin/env bun
// Keep every guide item's subject the one its ballot source in the endorsements catalog names,
// so the web app finds the guide's material on the race. The scrapers take their subjects from
// the ballot sources when they run; this catches up when the catalog re-files a race afterwards
// (its jurisdiction is part of its identity: San Diego County's contests moved from the City of
// San Diego's `us/ca/san-diego` to `us/ca/san-diego-county`). A guide's context follows its
// county's ballot source too. Items are matched by title and edited as text. Dry run by default.
//
//   bun scripts/sync-subjects.ts [--catalog <endorsements checkout>] [--apply]
//
// --catalog reads the ballot sources from a local checkout of openslate-public-endorsements
// instead of the published catalog, for a re-file not yet published.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ELECTION, type Subject, ballotSourceUrl, fetchOk } from "./lib/guide-common";

const apply = process.argv.includes("--apply");
const catalogAt = process.argv.indexOf("--catalog");
const catalog = catalogAt > 0 ? process.argv[catalogAt + 1] : undefined;

/** Each guide's ballot source: the county's election authority (the state's for guide/). */
const SOURCES: Record<string, string> = {
  guide: "ca-secretary-of-state",
  "county/alameda": "alameda-registrar-of-voters",
  "county/la": "la-county-registrar",
  "county/oc": "oc-registrar-of-voters",
  "county/san-mateo": "san-mateo-county-elections",
  "county/santa-clara": "santa-clara-registrar-of-voters",
  "county/sd": "sd-registrar-of-voters",
  "county/sf": "sf-department-of-elections",
};

interface Source {
  context?: { jurisdiction?: string };
  positions: { subject: Subject }[];
}

async function loadSource(org: string): Promise<Source> {
  if (catalog) return Bun.file(join(catalog, "orgs", org, ELECTION, "positions.json")).json();
  return (await fetchOk(ballotSourceUrl(org))).json();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with its first `"jurisdiction": "<from>"` set to `to`. */
function setJurisdiction(text: string, from: string, to: string): string {
  return text.replace(
    new RegExp(`("jurisdiction"\\s*:\\s*)"${escapeRegExp(from)}"`),
    (_, key: string) => `${key}"${to}"`,
  );
}

const state = await loadSource("ca-secretary-of-state");
let changed = 0;
for (const [dir, org] of Object.entries(SOURCES)) {
  if (!existsSync(join(dir, "items"))) continue;
  const source = org === "ca-secretary-of-state" ? state : await loadSource(org);
  // A county guide has the state's races too (Congress, the Legislature).
  const byTitle = new Map<string, Subject>();
  for (const { subject } of [...state.positions, ...source.positions]) {
    if (subject.election === ELECTION) byTitle.set(subject.title, subject);
  }

  for (const name of readdirSync(join(dir, "items")).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, "items", name);
    const text = await Bun.file(file).text();
    const { subject } = JSON.parse(text) as { subject: Subject };
    const want = byTitle.get(subject.title)?.jurisdiction;
    if (!want || !subject.jurisdiction || want === subject.jurisdiction) continue;
    console.log(`${file}: ${subject.jurisdiction} → ${want}`);
    changed++;
    if (apply) await Bun.write(file, setJurisdiction(text, subject.jurisdiction, want));
  }

  const guideFile = join(dir, "guide.json");
  const scope = source.context?.jurisdiction;
  if (org === "ca-secretary-of-state" || !scope || !existsSync(guideFile)) continue;
  const text = await Bun.file(guideFile).text();
  const context = (JSON.parse(text) as { context?: { jurisdiction?: string } }).context;
  if (!context?.jurisdiction || context.jurisdiction === scope) continue;
  console.log(`${guideFile}: context ${context.jurisdiction} → ${scope}`);
  changed++;
  if (apply) await Bun.write(guideFile, setJurisdiction(text, context.jurisdiction, scope));
}
console.log(`${changed} change(s)${apply ? "" : "; dry run, pass --apply to write"}`);
