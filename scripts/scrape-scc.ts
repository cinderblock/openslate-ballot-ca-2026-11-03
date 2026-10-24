#!/usr/bin/env bun
// Build county/santa-clara/ from Santa Clara County's online Voter Information Guide for one
// election: every candidate statement (Congress, the Legislature, and every local office) and
// each local measure's question, impartial analysis (with any tax rate statement), complete
// text, and arguments and rebuttals with their signers.
//
// Santa Clara publishes its guide through Democracy Live's OmniBallot. The voter-facing pages
// want a ballot style and a session, but the content behind them is published as static JSON:
// an index (`lookups.json`) of every statement and measure, and one file each, with the text as
// HTML (the county's own extraction from its printed guide). Nothing here needs a session.
//
// Each statement is filed under a contest id; a contest's statements go to the race on the
// ballot whose candidates they name (the Santa Clara ballot source in the endorsements catalog,
// and the Secretary of State's for Congress and the Legislature). A measure goes to the subject
// the ballot source gives its title (`contest-subjects.json` beside its positions).
//
// Raw responses are cached in .cache/ (ignored by git); the English HTML of each is kept under
// evidence/county/santa-clara/ with when it was fetched and the SHA-256 of what was sent.
//
//   bun scripts/scrape-scc.ts [--refresh] [--subjects contest-subjects.json --ballot positions.json]

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  type Block,
  ELECTION,
  type Item,
  type Passage,
  type Signer,
  type Subject,
  ballotSourceUrl,
  fetchOk,
  loadRaces,
  matchChoice,
  normName,
  now,
  sha256Hex,
} from "./lib/guide-common";
import {
  type Element,
  type Node,
  blocks,
  clean,
  isElement,
  parseDocument,
  textOf,
} from "./lib/html-blocks";
import {
  countItems,
  headingOverlap,
  itemStore,
  raceFor,
  wordCase,
  writeGuide,
} from "./lib/pamphlet";

const OUT = "county/santa-clara";
const EVIDENCE = "evidence/county/santa-clara";
const CACHE = ".cache/county/santa-clara";
const OMNI = "https://ca.omniballot.us";
/** Santa Clara's OmniBallot account, and this election's id there. */
const ACCOUNT = "06085";
const OMNI_ELECTION = "1968";
const PUBLISHED = `${OMNI}/published/${ACCOUNT}/${OMNI_ELECTION}/vg`;
const CATALOG = `https://cinderblock.github.io/openslate-public-endorsements/orgs/santa-clara-registrar-of-voters/${ELECTION}`;
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const PAUSE_MS = 100;
const refresh = process.argv.includes("--refresh");
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;

// As the guide words them.
const STATEMENT_CAVEAT =
  "Including a statement in this guide is at the option of the candidates and those that choose to do so are required to purchase the space.";
const ARGUMENT_CAVEAT =
  "Arguments in support of or in opposition to proposed measures are the opinions of the authors and have not been checked for accuracy by any official agency.";

// ---------------------------------------------------------------- inputs

const subjectsArg = argAfter("--subjects");
const contestSubjects = (
  subjectsArg
    ? await Bun.file(subjectsArg).json()
    : await (await fetchOk(`${CATALOG}/contest-subjects.json`)).json()
) as { contests: Record<string, Subject>; measures: Record<string, Subject> };
const ballots = [
  ballotSourceUrl("ca-secretary-of-state"),
  argAfter("--ballot") ?? ballotSourceUrl("santa-clara-registrar-of-voters"),
];
const races = new Map<string, BallotRace>();
for (const url of ballots) for (const [title, race] of await loadRaces(url)) races.set(title, race);

/**
 * Each candidate's ballot designation, by race and name ("<title>|<name>"), as the ballot
 * sources give it ("Democratic · Small Business Owner" from the Secretary of State).
 */
const designations = new Map<string, string>();
for (const url of ballots) {
  const source = (
    /^https?:/.test(url) ? await (await fetchOk(url)).json() : await Bun.file(url).json()
  ) as { positions: { subject: Subject; choice?: string; statement?: string }[] };
  for (const p of source.positions) {
    if (p.choice && p.statement) {
      designations.set(`${p.subject.title}|${p.choice}`, p.statement.replace(/^.*· /, ""));
    }
  }
}

interface Retrieved {
  url: string;
  sha256: string;
  retrieved_at: string;
  /** When OmniBallot last changed it, as it says. */
  updated_at?: string;
}
const indexPath = join(EVIDENCE, "index.json");
const index: Record<string, Retrieved> = existsSync(indexPath)
  ? JSON.parse(await Bun.file(indexPath).text())
  : {};

/** A published JSON file, from the cache unless --refresh. */
async function getJson<T>(url: string): Promise<{ data: T; retrieved_at: string }> {
  const path = join(CACHE, new URL(url).pathname.split("/").pop() as string);
  if (refresh || !existsSync(path) || !index[url]) {
    const bytes = new Uint8Array(await (await fetchOk(url, USER_AGENT)).arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    const sha256 = sha256Hex(bytes);
    const prior = index[url];
    index[url] = prior?.sha256 === sha256 ? prior : { url, sha256, retrieved_at: now() };
    await Bun.sleep(PAUSE_MS);
  }
  const data = JSON.parse(await Bun.file(path).text()) as T;
  const entry = index[url] as Retrieved;
  const updated = (data as { updated_at?: string }).updated_at;
  if (updated) entry.updated_at = updated;
  return { data, retrieved_at: entry.retrieved_at };
}

/** Keep the English HTML the county published, for review and diffs. */
async function keep(file: string, text: string): Promise<void> {
  const path = join(EVIDENCE, file);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text.endsWith("\n") ? text : `${text}\n`);
}

interface Text {
  value: string;
}
interface Lookups {
  candidate_profiles: Record<string, { url: string; title: Text[] }>;
  measure_details: Record<string, { url: string; title: Text[] }>;
}
interface Profile {
  id: number;
  titles: Text[];
  written_statement: Text[];
}
interface MeasureDetail {
  id: number;
  titles: Text[];
  content: Text[];
}

// ---------------------------------------------------------------- items

const { items, itemFor } = itemStore();
const problems: string[] = [];
const notes: string[] = [];

/** The children of an HTML fragment's body. */
function fragment(html: string): Node[] {
  const doc = parseDocument(html);
  const body = (doc.childNodes as Node[])
    .filter(isElement)
    .flatMap((e) => (e.childNodes as Node[]).filter(isElement))
    .find((e) => e.tagName === "body");
  return (body?.childNodes ?? []) as Node[];
}

// ---------------------------------------------------------------- statements

const { data: lookups } = await getJson<Lookups>(`${PUBLISHED}/lookups.json`);

/** Statements by contest: OmniBallot keys each "<contest id>-<candidate id>". */
const contests = new Map<string, { printed: string; url: string }[]>();
for (const [key, profile] of Object.entries(lookups.candidate_profiles)) {
  const contest = key.split("-")[0] as string;
  contests.set(contest, [
    ...(contests.get(contest) ?? []),
    { printed: clean(profile.title[0]?.value ?? ""), url: `${OMNI}${profile.url}` },
  ]);
}

/** An HTML fragment's text, a line per paragraph or break. */
const plainText = (html: string) =>
  fragment(html)
    .map((n) => textOf(n))
    .join("\n");

/** A statement's "Occupation:" line, which is the candidate's ballot designation. */
function occupationOf(html: string): string | undefined {
  const lines = plainText(html).split("\n").map(clean);
  return lines.find((l) => /^Occupation:/i.test(l))?.replace(/^Occupation:\s*/i, "");
}
const sameWork = (designation: string | undefined, occupation: string | undefined) => {
  if (!designation || !occupation) return false;
  const a = normName(designation).replace(/[^a-z0-9]+/g, " ").trim();
  const b = normName(occupation).replace(/[^a-z0-9]+/g, " ").trim();
  return a === b || a.includes(b) || b.includes(a);
};

for (const [contest, listed] of contests) {
  const profiles = [];
  for (const { printed, url } of listed) {
    const { data, retrieved_at } = await getJson<Profile>(url);
    const html = data.written_statement[0]?.value ?? "";
    await keep(`statements/${data.id}.html`, html);
    profiles.push({ printed, url, html, retrieved_at });
  }
  const found = raceFor(
    listed.map((c) => c.printed),
    "",
    races,
  );
  let race = "race" in found ? found.race : undefined;
  if (!race) {
    // A name alone can fit several races ("KAREN MARTINEZ"); the statements' occupations are
    // the ballot designations of the race they're for.
    const fits = [...races.values()].filter((r) =>
      profiles.every((p) => matchChoice(p.printed, r.choices) !== undefined),
    );
    const agree = fits.filter((r) =>
      profiles.every((p) =>
        sameWork(
          designations.get(`${r.subject.title}|${matchChoice(p.printed, r.choices)}`),
          occupationOf(p.html),
        ),
      ),
    );
    // Failing that ("Incumbent" on the ballot, "Community Relations Advocate" in the guide), the
    // race whose title the statements' words share most ("I serve as your San José Evergreen
    // Community College …"), if one stands out. Listed in the notes, to check.
    const words = profiles.map((p) => plainText(p.html)).join(" ");
    const score = (r: BallotRace) => headingOverlap(r.subject.title, words);
    const best = Math.max(...fits.map(score));
    const closest = fits.filter((r) => score(r) === best);
    if (agree.length === 1) race = agree[0];
    else if (closest.length === 1 && best > 0) {
      race = closest[0];
      notes.push(
        `contest ${contest} (${listed.map((c) => c.printed).join(", ")}): ${race?.subject.title}, by the statement's words (${best}; next ${Math.max(0, ...fits.filter((r) => r !== race).map(score))})`,
      );
    } else {
      problems.push(
        `contest ${contest}: ${"problem" in found ? found.problem : ""} (by the statement's words: ${fits.map((r) => `${r.subject.title} ${score(r)}`).join(", ")})`,
      );
      continue;
    }
  }
  if (!race) continue;
  for (const { printed, url, html, retrieved_at } of profiles) {
    const choice = matchChoice(printed, race.choices) as string;
    if (normName(choice) !== normName(printed)) {
      notes.push(`${race.subject.title}: "${printed}" → "${choice}"`);
    }
    const item = itemFor(race.subject, retrieved_at);
    item.candidates ??= [];
    if (item.candidates.some((c) => c.choice === choice)) {
      problems.push(`${race.subject.title}: two statements for ${choice}`);
      continue;
    }
    const statement: Passage = {
      by: choice,
      blocks: blocks(fragment(html), {}),
      source: url,
      disclaimer: STATEMENT_CAVEAT,
    };
    if (statement.blocks.length === 0) problems.push(`${race.subject.title}: ${choice}'s is empty`);
    item.candidates.push({ choice, statement });
  }
}

// ---------------------------------------------------------------- measures

const text = (node: Node) => clean(textOf(node));

/**
 * A measure's HTML: the ballot question in a bordered box (the measure's letter, the question,
 * and "Yes / No"), then sections under centred `h2` headings: the impartial analysis, the
 * complete text, a tax rate statement for a bond, and the arguments and rebuttals, each closing
 * with its signers ("/s/ NAME<br>TITLE"). A side with no argument has a "NO ARGUMENT … WAS
 * SUBMITTED" heading and nothing under it.
 */
function readMeasure(name: string, html: string, source: string, retrieved_at: string) {
  const subject = contestSubjects.measures[name];
  if (!subject) {
    problems.push(`no subject for measure "${name}" in contest-subjects.json`);
    return;
  }
  const item = itemFor(subject, retrieved_at);
  const nodes = fragment(html).filter((n) => isElement(n) || text(n) !== "");

  const box = nodes.find((n): n is Element => isElement(n) && n.tagName === "div");
  if (box) {
    const question = (box.childNodes as Node[]).filter(
      (n) =>
        !(
          isElement(n) &&
          // The letter, and the "Yes / No" beside the question.
          ((n.tagName === "p" && /^(?:[A-Z]{1,3}|Yes\s*No)$/.test(text(n))) || text(n) === "")
        ),
    );
    item.about = { blocks: blocks(question, {}), source };
  } else problems.push(`${name}: no question`);

  // The sections, at each heading.
  const sections: { heading: string; nodes: Node[] }[] = [];
  for (const node of nodes) {
    if (node === box) continue;
    if (isElement(node) && node.tagName === "h2") {
      if (text(node)) sections.push({ heading: text(node), nodes: [] });
      continue;
    }
    sections.at(-1)?.nodes.push(node);
  }

  const args: Argument[] = [];
  const tax: Block[] = [];
  for (const { heading, nodes: body } of sections) {
    if (/^NO (?:REBUTTAL TO )?ARGUMENT .* WAS SUBMITTED$/i.test(heading)) continue;
    const analysis = /^(.*?)['’]?S? IMPARTIAL ANALYSIS/i.exec(heading);
    if (analysis) {
      const { content, means } = votesMean(blocks(body, {}), source);
      if (means) item.means = means;
      const by = analysis[1]?.trim();
      item.analysis = {
        title: "Impartial Analysis",
        ...(by ? { by: wordCase(by) } : {}),
        blocks: content,
        source,
      };
      continue;
    }
    if (/^COMPLETE TEXT OF/i.test(heading)) {
      const of = heading.replace(/^COMPLETE TEXT OF /i, "").replace(/^MEASURE /i, "Measure ");
      item.fullText = { title: `Complete text of ${of}`, blocks: blocks(body, {}), source };
      continue;
    }
    if (/^TAX RATE STATEMENT$/i.test(heading)) {
      tax.push({ type: "h", level: 3, text: [wordCase(heading)] }, ...blocks(body, {}));
      continue;
    }
    const side = /^(REBUTTAL TO )?ARGUMENT (IN FAVOR OF|AGAINST)/i.exec(heading);
    if (!side) {
      problems.push(`${name}: unknown section "${heading}"`);
      continue;
    }
    const rebuttal = side[1] !== undefined;
    const favor = /IN FAVOR/i.test(side[2] as string);
    // A rebuttal answers the other side's argument.
    const yes = rebuttal ? !favor : favor;
    const signedAt = body.findIndex((n) => isElement(n) && /^\/?s\//.test(text(n)));
    const content = signedAt >= 0 ? body.slice(0, signedAt) : body;
    const signers: Signer[] = (signedAt >= 0 ? body.slice(signedAt) : [])
      .filter(isElement)
      .map((n) => {
        const [first = "", ...rest] = textOf(n).split("\n").map(clean).filter(Boolean);
        const title = rest.join(", ");
        return { name: first.replace(/^\/?s\/\s*/, ""), ...(title ? { title } : {}) };
      });
    if (signers.length === 0) problems.push(`${name}: no signers for "${heading}"`);
    // An argument may open with its own title, set as a smaller heading.
    const lead = content.find(isElement);
    const title = lead?.tagName === "h3" ? text(lead) : undefined;
    args.push({
      side: yes ? "Yes" : "No",
      rebuttal,
      ...(title ? { title } : {}),
      blocks: blocks(
        content.filter((n) => n !== lead || !title),
        {},
      ),
      signers,
      source,
      disclaimer: ARGUMENT_CAVEAT,
    });
  }
  if (tax.length) {
    if (item.analysis) item.analysis.blocks.push(...tax);
    else problems.push(`${name}: a tax rate statement but no analysis`);
  }
  if (!item.analysis) notes.push(`${name}: no impartial analysis`);
  if (!item.fullText) notes.push(`${name}: no complete text`);
  if (args.length) item.arguments = args;
}

/** What a yes and a no vote mean, the analysis's closing paragraphs ('A "yes" vote is …'). */
function votesMean(
  content: Block[],
  source: string,
): { content: Block[]; means?: Record<string, Passage> } {
  const opens = (b: Block, vote: string) =>
    b.type === "p" &&
    new RegExp(`^A [“"]${vote}[”"] vote`, "i").test(
      b.text.map((r) => (typeof r === "string" ? r : "")).join(""),
    );
  const yesAt = content.findIndex((b) => opens(b, "yes"));
  const noAt = content.findIndex((b) => opens(b, "no"));
  if (!(yesAt > 0 && noAt > yesAt)) return { content };
  return {
    content: [...content.slice(0, yesAt), ...content.slice(noAt + 1)],
    means: {
      Yes: { blocks: content.slice(yesAt, noAt), source },
      No: { blocks: [content[noAt] as Block], source },
    },
  };
}

for (const measure of Object.values(lookups.measure_details)) {
  const url = `${OMNI}${measure.url}`;
  const { data, retrieved_at } = await getJson<MeasureDetail>(url);
  const html = data.content[0]?.value ?? "";
  await keep(`measures/${data.id}.html`, html);
  readMeasure(clean(measure.title[0]?.value ?? ""), html, url, retrieved_at);
}

// ---------------------------------------------------------------- write

mkdirSync(EVIDENCE, { recursive: true });
await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
const retrieved = Object.values(index)
  .map((e) => e.retrieved_at)
  .sort();
await writeGuide(OUT, items, {
  context: {
    election: ELECTION,
    jurisdiction: "us/ca/santa-clara-county",
    title: "Santa Clara County Voter Information Guide: November 3, 2026 General Election",
  },
  attribution: {
    of: {
      name: "Santa Clara County Registrar of Voters",
      uri: "https://vote.santaclaracounty.gov/",
      kind: "election-authority",
    },
    mode: "scraped",
    retrieved_at: retrieved.at(-1) ?? now(),
    sources: [`${PUBLISHED}/lookups.json`],
  },
});

console.error(`${items.size} items: ${JSON.stringify(countItems(items))}`);
if (process.argv.includes("--verbose") && notes.length)
  console.error(`\nnotes:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
