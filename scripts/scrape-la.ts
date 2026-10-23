#!/usr/bin/env bun
// Build county/la/ from the Los Angeles County Registrar-Recorder/County Clerk's published data
// for one election: every candidate's statement (Congress, the Legislature, and every local
// office) and each local measure's question, impartial analysis, full text and, where LA
// publishes them, arguments. LA serves these as JSON with HTML inside, so nothing is read from
// a print PDF.
//
// Which race or measure each LA contest is comes from the LA ballot source in the public
// endorsements catalog (`contest-subjects.json` beside its positions), so the guide lines up
// with races the app already shows; Congress and Legislature districts come from the Secretary
// of State's titles. Statewide offices and justices are left to the state guide.
//
// LA's servers sit behind a bot wall that blocks bursts, so requests go one at a time with a
// pause, and the run stops at the first challenge page. Raw responses are cached in .cache/
// (ignored by git); the English text of each is kept under evidence/county/la/ with when it was
// fetched and the SHA-256 of what LA sent.
//
//   bun scripts/scrape-la.ts [--refresh] [--subjects contest-subjects.json --ballot positions.json]

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  type Block,
  ELECTION,
  type Item,
  type Passage,
  type Subject,
  ballotSourceUrl,
  fetchOk,
  loadRaces,
  matchChoice,
  normName,
  now,
  sha256Hex,
  slug,
} from "./lib/guide-common";
import { htmlBlocks } from "./lib/html-blocks";

const OUT = "county/la";
const EVIDENCE = "evidence/county/la";
const CACHE = ".cache/county/la";
const STATEMENTS_API = "https://apps.lavote.gov/statements-api/oc";
const SAMPLE_BALLOT = "https://isb.lavote.gov/parsed";
const STATEMENTS_PAGE = "https://apps.lavote.gov/candidate-statements/";
const SAMPLE_BALLOT_PAGE = "https://isb.lavote.gov/";
const CONTEST_SUBJECTS = `https://cinderblock.github.io/openslate-public-endorsements/orgs/la-county-registrar/${ELECTION}/contest-subjects.json`;
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const PAUSE_MS = 1200;
const refresh = process.argv.includes("--refresh");
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
// Local copies of the LA ballot source and its contest mapping, before they are published.
const subjectsArg = argAfter("--subjects");
const ballotArg = argAfter("--ballot");

// ---------------------------------------------------------------- fetching, paced and cached

interface Retrieved {
  url: string;
  sha256: string;
  retrieved_at: string;
}
const indexPath = join(EVIDENCE, "index.json");
const index: Record<string, Retrieved> = existsSync(indexPath)
  ? JSON.parse(await Bun.file(indexPath).text())
  : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A JSON response from LA, from the cache unless --refresh; paced, and stopped by the bot wall. */
async function getJson<T>(
  url: string,
  cacheFile: string,
): Promise<{ data: T; retrieved_at: string }> {
  const path = join(CACHE, cacheFile);
  if (refresh || !existsSync(path) || !index[url]) {
    const response = await fetchOk(url, USER_AGENT);
    const type = response.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (type.includes("html")) {
      throw new Error(`${url}: blocked by LA's bot wall; try again later`);
    }
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    const sha256 = sha256Hex(bytes);
    const prior = index[url];
    index[url] = prior?.sha256 === sha256 ? prior : { url, sha256, retrieved_at: now() };
    await sleep(PAUSE_MS);
  }
  const entry = index[url] as Retrieved;
  return { data: JSON.parse(await Bun.file(path).text()) as T, retrieved_at: entry.retrieved_at };
}

/** Keep the English text LA sent, for review and diffs. */
async function keep(file: string, text: string): Promise<void> {
  const path = join(EVIDENCE, file);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text.endsWith("\n") ? text : `${text}\n`);
}

function english(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "EN" in value) {
    const en = (value as { EN: unknown }).EN;
    return typeof en === "string" ? en : "";
  }
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------- subjects

interface ContestSubjects {
  electionId: number;
  contests: Record<string, Subject>;
  measures: Record<string, Subject>;
}
const contestSubjects = (
  subjectsArg && !subjectsArg.startsWith("--")
    ? await Bun.file(subjectsArg).json()
    : await (await fetchOk(CONTEST_SUBJECTS)).json()
) as ContestSubjects;
const ELECTION_ID = contestSubjects.electionId;

const races = new Map<string, BallotRace>([
  ...(await loadRaces(ballotSourceUrl("ca-secretary-of-state"))),
  ...(await loadRaces(
    ballotArg && !ballotArg.startsWith("--") ? ballotArg : ballotSourceUrl("la-county-registrar"),
  )),
]);

/** Congress and Legislature districts, in the Secretary of State's titles. */
function stateDistrict(title: string): string | undefined {
  const n = (s: string) => s.replace(/(st|nd|rd|th)$/, "");
  let m = /^UNITED STATES REPRESENTATIVE, (\d+\w*) District$/.exec(title);
  if (m) return `US House of Representatives, California District ${n(m[1] as string)}`;
  m = /^STATE SENATOR, (\d+\w*) District$/.exec(title);
  if (m) return `California State Senate, District ${n(m[1] as string)}`;
  m = /^MEMBER OF THE STATE ASSEMBLY, (\d+\w*) District$/.exec(title);
  if (m) return `California State Assembly, District ${n(m[1] as string)}`;
  return undefined;
}

const items = new Map<string, Item>();
const problems: string[] = [];
const notes: string[] = [];

function itemFor(subject: Subject, retrieved_at: string): Item {
  const key = itemKey(subject.title);
  let item = items.get(key);
  if (!item) {
    item = { v: 1, subject, retrieved_at };
    items.set(key, item);
  }
  if (retrieved_at > item.retrieved_at) item.retrieved_at = retrieved_at;
  return item;
}
function itemKey(title: string): string {
  return slug(title.replace(/\s*\(.*\)\s*$/, ""));
}

// ---------------------------------------------------------------- statements

interface ApiContest {
  contestId: number;
  title: string;
  candidates: {
    candidateId: number;
    nameFirst: string;
    nameMiddle: string;
    nameLast: string;
    publishedStatements: { language: string }[];
  }[];
}

/** The English statement alone: LA appends the translation after a second heading block. */
function englishStatement(html: string): string {
  // The translation starts after a line break with its own "STATEMENT OF …" heading. (Some
  // statements open with an empty heading, so "the second heading" isn't the boundary.)
  const translation = html.search(/<br\s*\/?>\s*<h1/i);
  return (translation > 0 ? html.slice(0, translation) : html).replace(/<h1[^>]*>\s*<\/h1>/gi, "");
}

/** The statement's body, without its "STATEMENT OF …" / "CANDIDATE FOR …" headings. */
function statementBlocks(html: string): Block[] {
  const blocks = htmlBlocks(html);
  let start = 0;
  while (start < blocks.length && blocks[start]?.type === "h") start++;
  return blocks.slice(start);
}

async function scrapeStatements(): Promise<void> {
  const { data: contests } = await getJson<ApiContest[]>(
    `${STATEMENTS_API}/read/election/${ELECTION_ID}/contest`,
    "contests.json",
  );
  for (const contest of contests) {
    const subject =
      contestSubjects.contests[`cc${contest.contestId}`] ??
      (() => {
        const title = stateDistrict(contest.title);
        return title ? races.get(title)?.subject : undefined;
      })();
    if (!subject) continue;
    const race = races.get(subject.title);
    if (!race) {
      problems.push(`${contest.title}: no race titled "${subject.title}" in the ballot sources`);
      continue;
    }
    for (const candidate of contest.candidates) {
      if (!candidate.publishedStatements.some((s) => s.language === "EN")) continue;
      const printed = [candidate.nameFirst, candidate.nameMiddle, candidate.nameLast]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      const choice = matchChoice(printed, race.choices);
      if (!choice) {
        problems.push(
          `${subject.title}: "${printed}" isn't on the ballot (${race.choices.join(", ")})`,
        );
        continue;
      }
      if (normName(choice) !== normName(printed))
        notes.push(`${subject.title}: "${printed}" → "${choice}"`);
      const url = `${STATEMENTS_API}/p/published/${contest.contestId}/${candidate.candidateId}`;
      const id = `cc${contest.contestId}-${candidate.candidateId}`;
      const { data, retrieved_at } = await getJson<{ language: string; statement: string }[]>(
        url,
        `statements/${id}.json`,
      );
      const html = englishStatement(data.find((s) => s.language === "EN")?.statement ?? "");
      await keep(`statements/${id}.html`, html);
      const blocks = statementBlocks(html);
      if (blocks.length === 0) {
        problems.push(`${subject.title}: ${choice}'s statement is empty`);
        continue;
      }
      const item = itemFor(subject, retrieved_at);
      item.candidates ??= [];
      item.candidates.push({
        choice,
        statement: {
          by: choice,
          blocks,
          source: STATEMENTS_PAGE,
          disclaimer:
            "Statements are volunteered by the candidates and have not been checked for accuracy by any official agency.",
        },
      });
    }
  }
}

// ---------------------------------------------------------------- measures

interface ApiMeasure {
  id: string;
  name: unknown;
  long_description: unknown;
  statements?: { ID: string; FullHTML: unknown; SequenceOrder?: number }[];
}

/** What a measure document is, from its first heading. */
function documentKind(
  heading: string,
):
  | { kind: "text" | "analysis" | "other"; argument?: undefined }
  | { kind: "argument"; side: string; rebuttal: boolean } {
  const h = heading.toUpperCase();
  const rebuttal = /^REBUTTAL TO (THE )?ARGUMENT (IN FAVOR|AGAINST)/.exec(h);
  if (rebuttal)
    return { kind: "argument", side: rebuttal[2] === "AGAINST" ? "Yes" : "No", rebuttal: true };
  const argument = /^ARGUMENT (IN FAVOR|AGAINST)/.exec(h);
  if (argument)
    return { kind: "argument", side: argument[1] === "AGAINST" ? "No" : "Yes", rebuttal: false };
  if (/IMPARTIAL ANALYSIS/.test(h)) return { kind: "analysis" };
  if (/^(FULL TEXT|TEXT OF|ORDINANCE|RESOLUTION|PROPOSED (ORDINANCE|CHARTER|RESOLUTION))/.test(h))
    return { kind: "text" };
  return { kind: "other" };
}

function plainText(blocks: Block[]): string {
  const flat = (r: unknown): string =>
    typeof r === "string"
      ? r
      : r && typeof r === "object"
        ? Object.values(r).flat().map(flat).join("")
        : "";
  return blocks
    .map((b) => ("text" in b ? (b.text as unknown[]).map(flat).join("") : ""))
    .join(" ")
    .trim();
}

async function scrapeMeasures(): Promise<void> {
  for (const [id, subject] of Object.entries(contestSubjects.measures)) {
    if (!races.has(subject.title)) {
      problems.push(`${id}: no measure titled "${subject.title}" in the ballot sources`);
      continue;
    }
    const url = `${SAMPLE_BALLOT}/${ELECTION_ID}/contests/${id}.json`;
    const { data, retrieved_at } = await getJson<ApiMeasure>(url, `measures/${id}.json`);
    const item = itemFor(subject, retrieved_at);
    const kept: string[] = [];

    const question = english(data.long_description);
    if (question) {
      kept.push(question);
      item.about = { blocks: htmlBlocks(question), source: SAMPLE_BALLOT_PAGE };
    }
    const docs = [...(data.statements ?? [])].sort(
      (a, b) => (a.SequenceOrder ?? 0) - (b.SequenceOrder ?? 0),
    );
    const args: Argument[] = [];
    for (const doc of docs) {
      const html = english(doc.FullHTML);
      if (!html) continue;
      kept.push(html);
      const blocks = htmlBlocks(html);
      const headingIndex = blocks.findIndex((b) => b.type === "h" || b.type === "p");
      const heading = headingIndex >= 0 ? plainText([blocks[headingIndex] as Block]) : "";
      const kind = documentKind(heading);
      // The heading names the document; the race page labels it, so it isn't repeated.
      const body =
        blocks[headingIndex]?.type === "h" ? blocks.filter((_, i) => i !== headingIndex) : blocks;
      const passage: Passage = {
        title: titleCase(heading),
        blocks: body,
        source: SAMPLE_BALLOT_PAGE,
      };
      if (kind.kind === "text") item.fullText = passage;
      else if (kind.kind === "analysis") {
        // Its author: "CITY ATTORNEY'S IMPARTIAL ANALYSIS …", or a "By …, County Counsel" line.
        const byLine = body[0] && "text" in body[0] ? plainText([body[0]]) : "";
        const signed = /^By\s+(.+)$/i.exec(byLine)?.[1];
        const by = signed ?? /^(.*?)(?:['’]S)? IMPARTIAL ANALYSIS/i.exec(heading)?.[1];
        item.analysis = {
          ...passage,
          ...(signed ? { blocks: body.slice(1) } : {}),
          ...(by ? { by: signed ? by : titleCase(by) } : {}),
        };
      } else if (kind.kind === "argument") {
        args.push({
          side: kind.side,
          rebuttal: kind.rebuttal,
          blocks: body,
          signers: [],
          source: SAMPLE_BALLOT_PAGE,
        });
      } else {
        notes.push(`${subject.title}: kept "${heading.slice(0, 60)}" with the analysis`);
        item.analysis = item.analysis
          ? {
              ...item.analysis,
              blocks: [
                ...item.analysis.blocks,
                { type: "h", level: 3, text: [titleCase(heading)] },
                ...body,
              ],
            }
          : passage;
      }
    }
    if (args.length) item.arguments = args;
    await keep(`measures/${id}.html`, kept.join("\n<hr>\n"));
    if (!item.about) problems.push(`${subject.title}: no question`);
  }
}

/** "CITY ATTORNEY'S IMPARTIAL ANALYSIS OF MEASURE C" → "City Attorney's Impartial Analysis of Measure C". */
function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text.trim();
  const small = new Set(["of", "the", "and", "for", "on", "in", "to", "a", "an", "by"]);
  return (
    text
      .trim()
      .toLowerCase()
      .split(/(\s+)/)
      .map((w, i) =>
        i > 0 && small.has(w)
          ? w
          : /^[a-z]$/.test(w) || /^(ii|iii|iv)$/.test(w)
            ? w.toUpperCase()
            : w.replace(/^(\p{L})/u, (c) => c.toUpperCase()),
      )
      .join("")
      // A measure's letters stay capitals, even "A", which the rule above takes for the article.
      .replace(/\bMeasure ([a-z0-9]+)\b/g, (_m, id: string) => `Measure ${id.toUpperCase()}`)
  );
}

// ---------------------------------------------------------------- run

try {
  await scrapeStatements();
  await scrapeMeasures();
} finally {
  mkdirSync(EVIDENCE, { recursive: true });
  await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

mkdirSync(join(OUT, "items"), { recursive: true });
const written = new Set<string>();
for (const [key, item] of items) {
  const file = `${key}.json`;
  written.add(file);
  await Bun.write(join(OUT, "items", file), `${JSON.stringify(item, null, 2)}\n`);
}
for (const file of readdirSync(join(OUT, "items"))) {
  if (!written.has(file)) {
    rmSync(join(OUT, "items", file));
    console.error(`removed items/${file} (no longer produced)`);
  }
}
const retrieved = Object.values(index)
  .map((e) => e.retrieved_at)
  .sort();
await Bun.write(
  join(OUT, "guide.json"),
  `${JSON.stringify(
    {
      context: {
        election: ELECTION,
        jurisdiction: "us/ca/los-angeles-county",
        title:
          "Los Angeles County: candidate statements and local measures, November 3, 2026 General Election",
      },
      attribution: {
        of: {
          name: "Los Angeles County Registrar-Recorder/County Clerk",
          uri: "https://www.lavote.gov/",
          kind: "election-authority",
        },
        mode: "scraped",
        retrieved_at: retrieved.at(-1) ?? now(),
        sources: [STATEMENTS_PAGE, SAMPLE_BALLOT_PAGE],
      },
    },
    null,
    2,
  )}\n`,
);

const counts = { races: 0, measures: 0, statements: 0, arguments: 0, fullTexts: 0 };
for (const item of items.values()) {
  if (item.subject.kind === "measure") counts.measures++;
  else counts.races++;
  counts.statements += item.candidates?.length ?? 0;
  counts.arguments += item.arguments?.length ?? 0;
  if (item.fullText) counts.fullTexts++;
}
console.error(`${items.size} items: ${JSON.stringify(counts)}`);
if (process.argv.includes("--verbose") && notes.length)
  console.error(`\nnotes:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
