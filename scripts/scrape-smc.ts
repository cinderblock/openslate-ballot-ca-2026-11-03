#!/usr/bin/env bun
// Build county/san-mateo/ from what San Mateo County Elections publishes for one election: each
// local measure's filed documents (the resolution placing it on the ballot, its impartial
// analysis, and the arguments and rebuttals as submitted), linked at the county's site.
//
// San Mateo prints candidate statements and the typeset measure pages only in each voter's own
// pamphlet, behind a lookup that asks for a voter's address and birthdate, so this guide has no
// statements and no measure text. The documents on the election page are mostly scans of the
// filings (submission forms included), with no text layer. Each is linked, not mirrored (they
// come to over 500 MB), and identified by the SHA-256 of what was retrieved.
//
// A document's measure comes from its title ("Measure R - Impartial Analysis") or, for the
// filings named by contest ("Burlingame School District Bond Measure Argument in Favor"), from
// BY_NAME below, reviewed by hand. The run stops if a document fits no measure, or a measure on
// the ballot has no impartial analysis.
//
// The downloads are cached in .cache/ (ignored by git); evidence/county/san-mateo/index.json
// keeps each document's URL, title, size, SHA-256 and when it was fetched.
//
//   bun scripts/scrape-smc.ts [--refresh] [--subjects contest-subjects.json --ballot positions.json]

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BallotRace,
  ELECTION,
  type GuideDocument,
  type Subject,
  ballotSourceUrl,
  loadRaces,
  now,
  sha256Hex,
} from "./lib/guide-common";
import { countItems, itemStore, writeGuide } from "./lib/pamphlet";

const OUT = "county/san-mateo";
const EVIDENCE = "evidence/county/san-mateo";
const CACHE = ".cache/county/san-mateo";
const SITE = "https://www.smcacre.gov";
/** The current election's page, which links every measure document. */
const CURRENT = `${SITE}/elections/current-election`;
const CATALOG = `https://cinderblock.github.io/openslate-public-endorsements/orgs/san-mateo-county-elections/${ELECTION}`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 openslate-ballot-scraper (+https://openslate.us)";
const PAUSE_MS = 250;
const refresh = process.argv.includes("--refresh");
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;

// ---------------------------------------------------------------- inputs

const subjectsArg = argAfter("--subjects");
const contestSubjects = (
  subjectsArg
    ? await Bun.file(subjectsArg).json()
    : await (await get(`${CATALOG}/contest-subjects.json`)).json()
) as { measures: Record<string, Subject> };
const races: Map<string, BallotRace> = await loadRaces(
  argAfter("--ballot") ?? ballotSourceUrl("san-mateo-county-elections"),
);

async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (response.ok) return response;
    if (attempt >= 3 || response.status < 500) throw new Error(`${url}: HTTP ${response.status}`);
    await Bun.sleep(1000 * attempt);
  }
}

// ---------------------------------------------------------------- the documents

interface Linked {
  title: string;
  url: string;
}

/** Every document the election page links, through its "archival document" page that names it. */
async function linkedDocuments(): Promise<Linked[]> {
  const page = await (await get(CURRENT)).text();
  const documents: Linked[] = [];
  for (const m of page.matchAll(/archival-document\?document=([^"&]+)&amp;title=([^"]+)"/g)) {
    const url = decodeURIComponent(m[1] as string);
    const title = decodeURIComponent((m[2] as string).replace(/\+/g, " ")).trim();
    if (!documents.some((d) => d.url === url)) documents.push({ title, url });
  }
  if (!documents.length) throw new Error(`no documents linked from ${CURRENT}`);
  return documents;
}

/** Documents on the page that aren't about a measure. */
const NOT_MEASURES =
  /Random Alpha|Extended Fil|^Roster of Candidates$|Languages Spoken|Postcard|Bookmark|Quarter Sheet|Vote in Jail|Voting Rights in Jail/i;

/**
 * Filings titled by contest rather than letter, to their measure. Reviewed against each
 * measure's impartial analysis, which the county titles by letter.
 */
const BY_NAME: [RegExp, string[]][] = [
  [/^San Mateo County Amendments$/, ["J", "L", "U", "AA"]],
  [/^SMC Charter Amendment Measure Reapportionment/, ["U"]],
  [/Public Transit|^Regional Transit Measure/, ["RTM"]],
  [/^Burlingame School District Bond/, ["R"]],
  [/^Cabrillo Unified School District/, ["Z"]],
  [/^Jefferson Union High School District/, ["M"]],
  [/^Pacifica School District/, ["T"]],
  [/^San Carlos School District/, ["K"]],
  [/^San Mateo County Community College District/, ["V"]],
  [/^San Mateo-Foster City School District/, ["W"]],
  [/^City of Belmont/, ["Y"]],
  [/^City of Brisbane/, ["X"]],
  [/^City of Burlingame (Transient )?Occupancy/, ["D"]],
  [/^City of East Palo Alto Bond/, ["O"]],
  [/^City of East Palo Alto (Charter Amendment|Term Limits)/, ["CC"]],
  [/^City of Half Moon Bay Coastal/, ["I"]],
  [/^City of Half Moon Bay Housing/, ["Q"]],
  [/Menlo Park/, ["P"]],
  [/^City of Pacifica Transactions/, ["BB"]],
  [/Portola Valley/, ["N"]],
  [/^City of Redwood City/, ["E"]],
  [/^City of San Bruno Housing/, ["S"]],
  [/^City of San Bruno Fireworks/, ["DD"]],
  [/San Bruno:? Business License/, ["EE"]],
  [/^City of San Carlos (Transactions and )?Use Tax/, ["G"]],
  [/^City of San Mateo Transactions/, ["H"]],
  [/^City of San Mateo Charter/, ["F"]],
];

type Kind = "resolution" | "analysis" | "favor" | "against" | "rebut-favor" | "rebut-against";
const ORDER: Kind[] = [
  "resolution",
  "analysis",
  "favor",
  "against",
  "rebut-favor",
  "rebut-against",
];

/**
 * What a document is, from its title. A "Rebuttal Argument in Favor" is a rebuttal to the
 * argument in favor: its submission form says so ("Rebuttal to Argument in Favor of Measure").
 */
function kindOf(title: string): Kind {
  if (/Impartial Analysis/i.test(title)) return "analysis";
  if (/Rebuttal\b.*\bin Favor/i.test(title)) return "rebut-favor";
  if (/Rebuttal\b.*\bAgainst/i.test(title)) return "rebut-against";
  if (/Argument in Favor/i.test(title)) return "favor";
  if (/Argument Against/i.test(title)) return "against";
  return "resolution";
}

/** A file name's own word for what it is ("…-Reso-…", "…-5ArgInFavor-…", "…-RebutArgAgainst-…"). */
function kindOfFile(url: string): Kind | undefined {
  const name = decodeURIComponent(url.split("/").pop() ?? "");
  if (/ImpartialAnalysis/i.test(name)) return "analysis";
  if (/Rebut(Arg)?InFav/i.test(name)) return "rebut-favor";
  if (/Rebut(Arg)?Against/i.test(name)) return "rebut-against";
  if (/ArgInFav/i.test(name)) return "favor";
  if (/ArgAgainst/i.test(name)) return "against";
  if (/-Reso-|Amendments/i.test(name)) return "resolution";
  return undefined;
}

function lettersOf(doc: Linked): string[] {
  const titled = /^Measure ([A-Z]{1,2}) - /.exec(doc.title);
  if (titled) return [titled[1] as string];
  return BY_NAME.find(([pattern]) => pattern.test(doc.title))?.[1] ?? [];
}

function titleOf(kind: Kind, letters: string[]): string {
  const measure =
    letters.length === 1
      ? `Measure ${letters[0]}`
      : `Measures ${letters.slice(0, -1).join(", ")} and ${letters.at(-1)}`;
  switch (kind) {
    case "resolution":
      return `Resolution placing ${measure} on the ballot`;
    case "analysis":
      return `Impartial analysis of ${measure}`;
    case "favor":
      return `Argument in favor of ${measure}, as filed`;
    case "against":
      return `Argument against ${measure}, as filed`;
    case "rebut-favor":
      return `Rebuttal to the argument in favor of ${measure}, as filed`;
    case "rebut-against":
      return `Rebuttal to the argument against ${measure}, as filed`;
  }
}

// ---------------------------------------------------------------- retrieval

interface Retrieved {
  url: string;
  /** As the election page titles it. */
  title: string;
  bytes: number;
  sha256: string;
  retrieved_at: string;
}
const indexPath = join(EVIDENCE, "index.json");
const index: Record<string, Retrieved> = existsSync(indexPath)
  ? JSON.parse(await Bun.file(indexPath).text())
  : {};

/** Fetches a document into the cache unless it's there (or --refresh), and records its hash. */
async function retrieve(doc: Linked): Promise<Retrieved> {
  const path = join(CACHE, decodeURIComponent(new URL(doc.url).pathname).replace(/^\/+/, ""));
  if (refresh || !existsSync(path) || !index[doc.url]) {
    const bytes = new Uint8Array(await (await get(doc.url)).arrayBuffer());
    await Bun.write(path, bytes);
    const sha256 = sha256Hex(bytes);
    const prior = index[doc.url];
    index[doc.url] =
      prior?.sha256 === sha256
        ? { ...prior, title: doc.title }
        : { url: doc.url, title: doc.title, bytes: bytes.length, sha256, retrieved_at: now() };
    await Bun.sleep(PAUSE_MS);
  }
  return index[doc.url] as Retrieved;
}

// ---------------------------------------------------------------- items

const problems: string[] = [];
const byLetter = new Map<string, { kind: Kind; doc: Retrieved }[]>();

for (const doc of await linkedDocuments()) {
  if (NOT_MEASURES.test(doc.title)) continue;
  const letters = lettersOf(doc);
  if (!letters.length) {
    problems.push(`no measure for "${doc.title}" (${doc.url})`);
    continue;
  }
  const kind = kindOf(doc.title);
  const fileKind = kindOfFile(doc.url);
  if (fileKind !== kind)
    problems.push(`"${doc.title}" reads as ${kind}, its file name as ${fileKind ?? "nothing"}`);
  const retrieved = await retrieve(doc);
  for (const letter of letters) {
    const docs = byLetter.get(letter) ?? [];
    docs.push({ kind, doc: retrieved });
    byLetter.set(letter, docs);
  }
}

const { items, itemFor } = itemStore();
for (const [name, subject] of Object.entries(contestSubjects.measures)) {
  // "Burlingame — Measure D (…)", "Bay Area — Regional Measure RTM (…)".
  const letter = /\bMeasure ([A-Z]+)\b/.exec(subject.title)?.[1] ?? name;
  if (!races.has(subject.title)) {
    problems.push(`${name}: "${subject.title}" isn't in the San Mateo ballot source`);
    continue;
  }
  const docs = byLetter.get(letter) ?? [];
  byLetter.delete(letter);
  if (!docs.some((d) => d.kind === "analysis")) problems.push(`${name}: no impartial analysis`);
  if (!docs.length) continue;
  docs.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const item = itemFor(
    subject,
    docs.map((d) => d.doc.retrieved_at).reduce((a, b) => (a > b ? a : b)),
  );
  item.documents = docs.map(
    ({ kind, doc }): GuideDocument => ({
      title: titleOf(kind, BY_NAME.find(([pattern]) => pattern.test(doc.title))?.[1] ?? [letter]),
      source: doc.url,
      mediaType: "application/pdf",
      sha256: doc.sha256,
    }),
  );
}
for (const letter of byLetter.keys())
  problems.push(`Measure ${letter} has documents but isn't in the ballot source's measures`);

// ---------------------------------------------------------------- write

mkdirSync(EVIDENCE, { recursive: true });
const sorted = Object.fromEntries(
  Object.entries(index).sort(([a], [b]) => a.localeCompare(b)),
) as Record<string, Retrieved>;
await Bun.write(indexPath, `${JSON.stringify(sorted, null, 2)}\n`);
const retrieved = Object.values(index)
  .map((e) => e.retrieved_at)
  .sort();
await writeGuide(OUT, items, {
  context: {
    election: ELECTION,
    jurisdiction: "us/ca/san-mateo-county",
    title: "San Mateo County measure documents: November 3, 2026 General Election",
  },
  attribution: {
    of: {
      name: "San Mateo County Elections",
      uri: "https://www.smcacre.gov/elections",
      kind: "election-authority",
    },
    mode: "scraped",
    retrieved_at: retrieved.at(-1) ?? now(),
    sources: [CURRENT],
  },
});

const documents = [...items.values()].reduce((n, item) => n + (item.documents?.length ?? 0), 0);
console.error(`${items.size} items, ${documents} documents: ${JSON.stringify(countItems(items))}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
