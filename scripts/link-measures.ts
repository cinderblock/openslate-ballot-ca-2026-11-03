#!/usr/bin/env bun
// Build a measures-only guide for a county (or a city running its own election) from a reviewed
// table of links: linked/<name>.json. Each local measure gets the official documents its election
// authority publishes (full text or the resolution placing it on the ballot, the impartial
// analysis, the arguments and rebuttals), linked at the publisher's site, not mirrored, and
// identified by the SHA-256 of what was retrieved.
//
// For counties whose pamphlet nobody has scraped yet. The tables are written by hand: each
// county publishes its measures differently, and a wrong link is worse than none, so every link
// in a table was opened and checked against the document's own text (its `checked` note says what
// was read). This script doesn't guess; it fetches each document, checks it is what the table
// says (a PDF starts with %PDF), and checks each measure's titles against the catalog's subjects
// for the election, so an item always lands on a race the app shows. A catalog measure in a
// table's jurisdictions that the table neither links nor lists under `missing` is a problem too.
//
// The downloads are cached in .cache/linked/ (ignored by git); evidence/<dir>/index.json keeps
// each document's URL, size, SHA-256 and when it was fetched.
//
//   bun scripts/link-measures.ts [name …] [--refresh] [--catalog <bundle.json url or path>]

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ELECTION,
  type GuideDocument,
  type Item,
  type Subject,
  now,
  sha256Hex,
  slug,
} from "./lib/guide-common";
import { writeGuide } from "./lib/pamphlet";

const TABLES = "linked";
const CACHE = ".cache/linked";
const CATALOG = "https://cinderblock.github.io/openslate-public-endorsements/bundle.json";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 openslate-ballot-scraper (+https://openslate.us)";
/** Some county sites (Monterey's) turn away a request that doesn't look like a browser's. */
const HEADERS = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const PAUSE_MS = 250;

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const catalogArg = args.includes("--catalog") ? args[args.indexOf("--catalog") + 1] : undefined;
const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--catalog");

// ---------------------------------------------------------------- the tables

type Kind =
  | "text"
  | "resolution"
  | "analysis"
  | "fiscal"
  | "tax-rate"
  | "favor"
  | "against"
  | "rebut-favor"
  | "rebut-against"
  | "other";
const ORDER: Kind[] = [
  "text",
  "resolution",
  "analysis",
  "fiscal",
  "tax-rate",
  "favor",
  "against",
  "rebut-favor",
  "rebut-against",
  "other",
];

interface LinkedDocument {
  kind: Kind;
  /** The publisher's own title, where it says more than the kind does; required for `other`. */
  title?: string;
  url: string;
  mediaType: string;
  /** 1-based page of a larger document where this one starts. */
  page?: number;
  /** The official page that links it. */
  found_on: string;
  /** What was read in it to confirm it is this measure's document. */
  checked: string;
  /**
   * Retrieved by hand, for a host that turns this script away (a bot check that refuses
   * HTTP/1.1 clients, or anything but a browser): what was fetched and how. Used when this
   * script's own request is refused; checked against what it gets otherwise.
   */
  manual?: { sha256?: string; bytes?: number; retrieved_at: string; by: string };
}

interface LinkedMeasure {
  /** The measure's titles in the catalog (one measure may be titled two ways). */
  titles: string[];
  jurisdiction: string;
  /** The measure's letter or number as the ballot prints it ("R", "G-26", "I2026"). */
  letter: string;
  documents: LinkedDocument[];
  notes?: string;
}

interface Table {
  /** Where the guide goes, e.g. "county/marin". */
  dir: string;
  /** The guide's own jurisdiction and title. */
  jurisdiction: string;
  title: string;
  /** The election authority whose material this is. */
  authority: { name: string; uri: string };
  /** The official pages the links were found on. */
  pages: string[];
  measures: LinkedMeasure[];
  /** Catalog measures with nothing official to link, and what was tried. */
  missing?: { titles: string[]; why: string }[];
}

function documentTitle(doc: LinkedDocument, letter: string): string {
  const measure = `Measure ${letter}`;
  switch (doc.kind) {
    case "text":
      return doc.title ?? `Full text of ${measure}`;
    case "resolution":
      return doc.title ?? `Resolution placing ${measure} on the ballot`;
    case "analysis":
      return doc.title ?? `Impartial analysis of ${measure}`;
    case "fiscal":
      return doc.title ?? `Fiscal analysis of ${measure}`;
    case "tax-rate":
      return doc.title ?? `Tax rate statement for ${measure}`;
    case "favor":
      return doc.title ?? `Argument in favor of ${measure}`;
    case "against":
      return doc.title ?? `Argument against ${measure}`;
    case "rebut-favor":
      return doc.title ?? `Rebuttal to the argument in favor of ${measure}`;
    case "rebut-against":
      return doc.title ?? `Rebuttal to the argument against ${measure}`;
    case "other":
      if (!doc.title) throw new Error(`${doc.url}: an "other" document needs a title`);
      return doc.title;
  }
}

// ---------------------------------------------------------------- the catalog's measures

/** Every measure subject in the catalog for the election, by jurisdiction and title. */
async function catalogMeasures(): Promise<Map<string, Subject>> {
  const source = catalogArg ?? CATALOG;
  const bundle = (
    /^https?:/.test(source) ? await (await get(source)).json() : await Bun.file(source).json()
  ) as { entries: { token: string }[] };
  const measures = new Map<string, Subject>();
  for (const entry of bundle.entries) {
    const segment = entry.token.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as {
      positions?: { subject: Subject }[];
    };
    for (const { subject } of payload.positions ?? []) {
      if (subject.kind !== "measure" || subject.election !== ELECTION) continue;
      measures.set(subjectKey(subject.jurisdiction ?? "", subject.title), subject);
    }
  }
  return measures;
}

const subjectKey = (jurisdiction: string, title: string) => `${jurisdiction}|${title}`;

async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: HEADERS });
    if (response.ok) return response;
    if (attempt >= 3 || response.status < 500) throw new Error(`${url}: HTTP ${response.status}`);
    await Bun.sleep(1000 * attempt);
  }
}

// ---------------------------------------------------------------- retrieval

interface Retrieved {
  url: string;
  mediaType: string;
  bytes?: number;
  /** Not for a web page: its markup changes with every visit, so a hash would identify nothing. */
  sha256?: string;
  retrieved_at: string;
  /** Retrieved by hand (the table's `manual`), not by this script: how. */
  via?: string;
}

/** What the bytes are, as far as it matters here: a PDF, or what the server said. */
function sniff(bytes: Uint8Array, contentType: string | null): string {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return (contentType ?? "application/octet-stream").split(";")[0]?.trim() ?? "";
}

/** One file per URL; a URL can't be a path, since one page's address may be a prefix of another's. */
function cachePath(url: string): string {
  const { host } = new URL(url);
  return join(CACHE, host, sha256Hex(new TextEncoder().encode(url)).slice(0, 32));
}

async function fetchDocument(url: string, index: Record<string, Retrieved>): Promise<Retrieved> {
  const path = cachePath(url);
  const known = index[url];
  if (!refresh && known && !known.via && existsSync(path)) return known;
  const response = await get(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(path, bytes);
  const mediaType = sniff(bytes, response.headers.get("content-type"));
  const sha256 = mediaType === "text/html" ? undefined : sha256Hex(bytes);
  index[url] =
    known && !known.via && known.sha256 === sha256 && known.mediaType === mediaType
      ? known
      : {
          url,
          mediaType,
          ...(sha256 ? { bytes: bytes.length, sha256 } : {}),
          retrieved_at: now(),
        };
  await Bun.sleep(PAUSE_MS);
  return index[url] as Retrieved;
}

/** A document as fetched here, or as the table's manual retrieval recorded it when refused. */
async function retrieve(
  doc: LinkedDocument,
  index: Record<string, Retrieved>,
  problems: string[],
): Promise<Retrieved> {
  try {
    const got = await fetchDocument(doc.url, index);
    if (doc.manual?.sha256 && got.sha256 && doc.manual.sha256 !== got.sha256)
      problems.push(`${doc.url}: changed since it was retrieved by hand`);
    return got;
  } catch (error) {
    if (!doc.manual) throw error;
    if (doc.mediaType !== "text/html" && !doc.manual.sha256)
      throw new Error(`${(error as Error).message}, and its manual retrieval has no SHA-256`);
    const { sha256, bytes, retrieved_at, by } = doc.manual;
    const got: Retrieved = {
      url: doc.url,
      mediaType: doc.mediaType,
      ...(sha256 && doc.mediaType !== "text/html" ? { bytes, sha256 } : {}),
      retrieved_at,
      via: by,
    };
    index[doc.url] = got;
    return got;
  }
}

// ---------------------------------------------------------------- build one guide

async function build(name: string, catalog: Map<string, Subject>): Promise<string[]> {
  const table = (await Bun.file(join(TABLES, `${name}.json`)).json()) as Table;
  const problems: string[] = [];
  const evidence = join("evidence", table.dir);
  const indexPath = join(evidence, "index.json");
  const index: Record<string, Retrieved> = existsSync(indexPath)
    ? JSON.parse(await Bun.file(indexPath).text())
    : {};
  // Only what this table still links stays in its evidence.
  const used: Record<string, Retrieved> = {};

  // One item per catalog title. Its file is named for the measure without its short title,
  // unless the measure goes by two titles, which then need a file each.
  const items = new Map<string, Item>();
  const fileFor = (title: string) => {
    const short = slug(title.replace(/\s*\(.*\)\s*$/, ""));
    return items.has(short) ? slug(title) : short;
  };
  const accounted = new Set<string>();
  for (const measure of table.measures) {
    const subjects: Subject[] = [];
    for (const title of measure.titles) {
      const key = subjectKey(measure.jurisdiction, title);
      accounted.add(key);
      const subject = catalog.get(key);
      if (subject) subjects.push(subject);
      else problems.push(`"${title}" (${measure.jurisdiction}) isn't a measure in the catalog`);
    }
    if (!measure.documents.length) problems.push(`${measure.titles[0]}: no documents`);
    const documents: { doc: LinkedDocument; got: Retrieved }[] = [];
    for (const doc of measure.documents) {
      if (!doc.checked?.trim()) problems.push(`${doc.url}: no note of what was checked`);
      try {
        const got = await retrieve(doc, index, problems);
        used[doc.url] = got;
        if (got.mediaType !== doc.mediaType)
          problems.push(`${doc.url}: the table says ${doc.mediaType}, it is ${got.mediaType}`);
        documents.push({ doc, got });
      } catch (error) {
        problems.push(`${measure.titles[0]}: ${(error as Error).message}`);
      }
    }
    documents.sort((a, b) => ORDER.indexOf(a.doc.kind) - ORDER.indexOf(b.doc.kind));
    const retrievedAt =
      documents
        .map((d) => d.got.retrieved_at)
        .sort()
        .at(-1) ?? now();
    for (const subject of subjects) {
      const file = fileFor(subject.title);
      if (items.has(file)) problems.push(`two items would be ${file}.json`);
      const item: Item = {
        v: 1,
        subject: {
          title: subject.title,
          kind: "measure",
          jurisdiction: subject.jurisdiction,
          election: ELECTION,
        },
        retrieved_at: retrievedAt,
      };
      items.set(file, item);
      item.documents = documents.map(
        ({ doc, got }): GuideDocument => ({
          title: documentTitle(doc, measure.letter),
          source: doc.url,
          mediaType: got.mediaType,
          ...(doc.page ? { page: doc.page } : {}),
          ...(got.sha256 ? { sha256: got.sha256 } : {}),
        }),
      );
    }
  }
  for (const missing of table.missing ?? []) {
    for (const title of missing.titles) {
      const jurisdiction = [...catalog.values()].find((s) => s.title === title)?.jurisdiction;
      if (jurisdiction === undefined) problems.push(`missing "${title}" isn't in the catalog`);
      else accounted.add(subjectKey(jurisdiction, title));
    }
  }
  const jurisdictions = new Set(table.measures.map((m) => m.jurisdiction));
  for (const [key, subject] of catalog) {
    if (jurisdictions.has(subject.jurisdiction ?? "") && !accounted.has(key))
      problems.push(`the catalog's "${subject.title}" is neither linked nor listed as missing`);
  }

  mkdirSync(evidence, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(used).sort(([a], [b]) => a.localeCompare(b)));
  await Bun.write(indexPath, `${JSON.stringify(sorted, null, 2)}\n`);
  await writeGuide(table.dir, items, {
    context: { election: ELECTION, jurisdiction: table.jurisdiction, title: table.title },
    attribution: {
      of: { name: table.authority.name, uri: table.authority.uri, kind: "election-authority" },
      mode: "scraped",
      retrieved_at:
        Object.values(used)
          .map((r) => r.retrieved_at)
          .sort()
          .at(-1) ?? now(),
      sources: table.pages,
    },
  });
  const count = [...items.values()].reduce((n, item) => n + (item.documents?.length ?? 0), 0);
  console.error(`${table.dir}: ${items.size} items, ${count} documents`);
  return problems.map((p) => `${name}: ${p}`);
}

// ---------------------------------------------------------------- run

const all = readdirSync(TABLES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();
for (const name of names) if (!all.includes(name)) throw new Error(`no ${TABLES}/${name}.json`);
const catalog = await catalogMeasures();
const problems: string[] = [];
for (const name of names.length ? names : all) problems.push(...(await build(name, catalog)));
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
