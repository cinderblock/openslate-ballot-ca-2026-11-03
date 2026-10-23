#!/usr/bin/env bun
// Build county/sf/ from the San Francisco Department of Elections' Voter Information Pamphlet
// for one election: each office's description, every candidate's statement of qualifications
// (Congress, the Assembly and local offices), and for each local and regional measure the
// question, the Ballot Simplification Council's digest, what a Yes and a No vote mean, the
// Controller's statement (or the impartial analysis), how it got on the ballot, the official
// arguments and rebuttals, the paid arguments, and where its legal text starts.
//
// The pamphlet is one large PDF. It is cached outside git (.cache/) and only its URL, SHA-256,
// size and retrieval time are committed (evidence/county/sf/index.json); every passage points
// at its page. SF prints no candidate photos. Legal text is linked by page rather than
// extracted: the pamphlet marks added and deleted law with drawn underlines and strikethroughs,
// which text extraction would lose.
//
// Subjects come from two ballot sources in the public endorsements catalog: the SF Department
// of Elections' (local races and measures) and the CA Secretary of State's (Congress, Assembly).
//
//   bun scripts/scrape-sf-vip.ts [--refresh]

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  type Block,
  ELECTION,
  type Inline,
  type Item,
  type Passage,
  type Signer,
  ballotSourceUrl,
  fetchOk,
  loadRaces,
  matchChoice,
  normName,
  now,
  sha256Hex,
  slug,
} from "./lib/guide-common";
import { blockReader } from "./lib/pdf-blocks";
import { type Line, type Page, pdfPages } from "./lib/pdf-layout";

const PDF_URL = "https://media.api.sf.gov/documents/N26_EN_VIP.pdf";
const OUT = "county/sf";
const EVIDENCE = "evidence/county/sf";
const CACHE = ".cache/county/sf/N26_EN_VIP.pdf";
// sf.gov's CDN refuses some non-browser user agents.
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const refresh = process.argv.includes("--refresh");

// ---------------------------------------------------------------- the pamphlet

interface Retrieved {
  url: string;
  sha256: string;
  bytes: number;
  retrieved_at: string;
}
const evidencePath = join(EVIDENCE, "index.json");
const evidence: Record<string, Retrieved> = existsSync(evidencePath)
  ? JSON.parse(await Bun.file(evidencePath).text())
  : {};

async function pamphlet(): Promise<{ bytes: Uint8Array; retrieved: Retrieved }> {
  let recorded = evidence[PDF_URL];
  if (!recorded || refresh || !existsSync(CACHE)) {
    const bytes = new Uint8Array(await (await fetchOk(PDF_URL, USER_AGENT)).arrayBuffer());
    mkdirSync(dirname(CACHE), { recursive: true });
    await Bun.write(CACHE, bytes);
    const sha256 = sha256Hex(bytes);
    // Keep the first retrieval time while the file is unchanged.
    recorded =
      recorded?.sha256 === sha256
        ? recorded
        : { url: PDF_URL, sha256, bytes: bytes.length, retrieved_at: now() };
    evidence[PDF_URL] = recorded;
    console.error(`fetched ${PDF_URL} (${bytes.length} bytes)`);
  }
  const bytes = new Uint8Array(await Bun.file(CACHE).arrayBuffer());
  if (sha256Hex(bytes) !== recorded.sha256) {
    throw new Error(`${CACHE} doesn't match the recorded SHA-256; run with --refresh`);
  }
  return { bytes, retrieved: recorded };
}

const { bytes, retrieved } = await pamphlet();
const pages = await pdfPages(bytes);
const sourceAt = (page: number) => `${PDF_URL}#page=${page}`;

// Running headers sit above y 715; the publisher's caveats sit below y 50.
const HEADER_Y = 715;
const FOOTER_Y = 50;
interface PageParts {
  page: Page;
  header: string;
  footer: string;
  body: Line[];
}
const parts: PageParts[] = pages.map((page) => ({
  page,
  header: page.lines
    .filter((l) => l.y > HEADER_Y && !/^\d+$|^38-EN-/.test(l.text))
    .map((l) => l.text)
    .join(" "),
  footer: page.lines
    .filter((l) => l.y < FOOTER_Y)
    .map((l) => l.text)
    .join(" "),
  body: page.lines.filter((l) => l.y <= HEADER_Y && l.y >= FOOTER_Y),
}));

// ---------------------------------------------------------------- lines into blocks

const { segments, wrapsFrom, joint, paragraphs, blocksOf, plain } = blockReader(
  parts.map((p) => ({ page: p.page.number, lines: p.body })),
);

// ---------------------------------------------------------------- subjects

const races = new Map<string, BallotRace>([
  ...(await loadRaces(ballotSourceUrl("ca-secretary-of-state"))),
  ...(await loadRaces(ballotSourceUrl("sf-department-of-elections"))),
]);
const problems: string[] = [];
const notes: string[] = [];
const items = new Map<string, Item>();

function itemFor(title: string): Item | undefined {
  const race = races.get(title);
  if (!race) {
    problems.push(`the ballot sources have no race titled ${JSON.stringify(title)}`);
    return undefined;
  }
  const key = itemKey(title);
  let item = items.get(key);
  if (!item) {
    item = { v: 1, subject: race.subject, retrieved_at: retrieved.retrieved_at };
    items.set(key, item);
  }
  return item;
}
function itemKey(title: string): string {
  const prop = /^San Francisco — Proposition ([A-Z]+) \(/.exec(title);
  if (prop) return `prop-${prop[1]?.toLowerCase()}`;
  const regional = /^Bay Area — Regional Measure ([A-Z]+) \(/.exec(title);
  if (regional) return `regional-${regional[1]?.toLowerCase()}`;
  return slug(title);
}
function measureTitle(letter: string): string | undefined {
  for (const title of races.keys()) {
    if (title.startsWith(`San Francisco — Proposition ${letter} (`)) return title;
    if (title.startsWith(`Bay Area — Regional Measure ${letter} (`)) return title;
  }
  problems.push(`the ballot sources have no measure ${letter}`);
  return undefined;
}

/** "Candidates for <office>" (and a term line, for the Community College Board) → race titles. */
function officeTitle(office: string, term: string | undefined): string | undefined {
  let m = /^United States Representative, District (\d+)$/.exec(office);
  if (m) return `US House of Representatives, California District ${m[1]}`;
  m = /^State Assembly, District (\d+)$/.exec(office);
  if (m) return `California State Assembly, District ${m[1]}`;
  m = /^State Senate, District (\d+)$/.exec(office);
  if (m) return `California State Senate, District ${m[1]}`;
  m = /^Board of Supervisors, District (\d+)$/.exec(office);
  if (m) return `San Francisco Board of Supervisors, District ${m[1]}`;
  m = /^BART Director, District (\d+)$/.exec(office);
  if (m) return `BART Board of Directors, District ${m[1]}`;
  switch (office) {
    case "Board of Education":
      return "San Francisco Unified School District Board of Education";
    case "Community College Board":
      return term && /remainder/i.test(term)
        ? "San Francisco Community College Board, Partial Term"
        : "San Francisco Community College Board";
    case "Assessor-Recorder":
      return "San Francisco Assessor-Recorder";
    case "Public Defender":
      return "San Francisco Public Defender";
  }
  problems.push(`unknown office heading "Candidates for ${office}"`);
  return undefined;
}

// ---------------------------------------------------------------- what each office does

const OFFICE_DESCRIPTIONS: Record<string, (title: string) => boolean> = {
  "Assessor-Recorder": (t) => t === "San Francisco Assessor-Recorder",
  "Public Defender": (t) => t === "San Francisco Public Defender",
  "Member, Board of Supervisors": (t) => t.startsWith("San Francisco Board of Supervisors,"),
  "Member, Board of Education": (t) =>
    t === "San Francisco Unified School District Board of Education",
  "Trustee, Community College Board": (t) => t.startsWith("San Francisco Community College Board"),
};

function scrapeOffices(): void {
  const lines = parts.flatMap((p) => p.body);
  const start = lines.findIndex((l) =>
    /^City and County of San Francisco Offices to be/.test(l.text),
  );
  if (start < 0) {
    problems.push("no office descriptions found");
    return;
  }
  let name: string | undefined;
  let body: Line[] = [];
  const flush = () => {
    if (!name) return;
    const matches = OFFICE_DESCRIPTIONS[name];
    if (!matches) problems.push(`unknown office description "${name}"`);
    else {
      for (const title of races.keys()) {
        if (!matches(title)) continue;
        const item = itemFor(title);
        if (item)
          item.about = {
            by: "San Francisco Department of Elections",
            blocks: [{ type: "h", level: 3, text: [name] }, ...blocksOf(body)],
            source: sourceAt(body[0]?.page ?? 1),
          };
      }
    }
    body = [];
  };
  for (const line of lines.slice(start + 1)) {
    if (line.size >= 18) {
      if (/^Voted on in this Election$/.test(line.text)) continue;
      break;
    }
    if (line.page !== lines[start]?.page && line.size >= 13) break;
    if (line.bold && line.size < 13) {
      flush();
      name = line.text;
    } else body.push(line);
  }
  flush();
}

// ---------------------------------------------------------------- candidate statements

/** A name heading: capitals, bold, 12–16 pt, in one column. */
function isNameHeading(line: Line): boolean {
  return (
    line.bold &&
    line.size >= 12 &&
    line.size < 17 &&
    line.column !== "full" &&
    line.text === line.text.toUpperCase() &&
    /\p{Lu}/u.test(line.text)
  );
}

function scrapeStatements(): void {
  let office: string | undefined;
  let term: string | undefined;
  let candidate: { name: string; title: string; lines: Line[]; footer: string } | undefined;
  const flush = () => {
    if (!candidate) return;
    addStatement(candidate.title, candidate.name, candidate.lines, candidate.footer);
    candidate = undefined;
  };
  for (const part of parts.filter((p) => p.header === "Candidate Statements")) {
    for (const line of part.body) {
      const heading = /^Candidates? for (.+)$/.exec(line.text);
      if (heading && line.size >= 18) {
        const next = heading[1] as string;
        if (next !== office) {
          flush();
          term = undefined;
        }
        office = next;
        continue;
      }
      if (line.size >= 14 && line.column === "full" && /^\(.+\)$/.test(line.text)) {
        if (line.text !== term) flush();
        term = line.text;
        continue;
      }
      if (isNameHeading(line)) {
        flush();
        const title = office ? officeTitle(office, term) : undefined;
        if (!title) continue;
        candidate = { name: line.text, title, lines: [], footer: part.footer };
        continue;
      }
      candidate?.lines.push(line);
    }
  }
  flush();
}

function addStatement(title: string, printed: string, lines: Line[], footer: string): void {
  const item = itemFor(title);
  const race = races.get(title);
  if (!item || !race) return;
  const choice = matchChoice(printed, race.choices);
  if (!choice) {
    problems.push(`${title}: "${printed}" isn't on the ballot source (${race.choices.join(", ")})`);
    return;
  }
  if (normName(choice) !== normName(printed)) notes.push(`${title}: "${printed}" → "${choice}"`);
  // The statement ends with the candidate's name as a sign-off; the heading already says it.
  const last = lines[lines.length - 1];
  if (last && matchChoice(last.text, [choice]) && last.text.split(" ").length <= 6) lines.pop();
  item.candidates ??= [];
  item.candidates.push({
    choice,
    statement: {
      by: choice,
      blocks: blocksOf(lines),
      source: sourceAt(lines[0]?.page ?? 1),
      ...(footer ? { disclaimer: footer } : {}),
    },
  });
}

// ---------------------------------------------------------------- measures

type Mode =
  | { kind: "question" }
  | { kind: "digest" }
  | { kind: "analysis"; by: string; title: string }
  | { kind: "history" }
  | { kind: "argument"; side: string; rebuttal: boolean }
  | { kind: "paid"; side: string }
  | { kind: "none" };

interface Collected {
  title: Line[];
  question: Line[];
  threshold: Line[];
  digest: Line[];
  analysis?: { by: string; title: string; lines: Line[] };
  history: { heading: string; lines: Line[] };
  arguments: { side: string; rebuttal: boolean; lines: Line[]; footer: string }[];
  paid: { side: string; lines: Line[]; footer: string }[];
}

/** Consecutive large lines close together read as one heading. */
function headings(lines: Line[]): (Line | { heading: string; first: Line })[] {
  const out: (Line | { heading: string; first: Line })[] = [];
  for (const line of lines) {
    const isHead = line.size >= 13 && line.size < 18;
    const last = out[out.length - 1];
    if (isHead && last && "heading" in last) {
      const prev = last.first;
      // Joined only when the previous line was a heading too, in the same flow, close above.
      const lastLine = (last as { lastLine?: Line }).lastLine ?? prev;
      if (
        lastLine.page === line.page &&
        lastLine.column === line.column &&
        lastLine.y - line.y < line.size * 1.6
      ) {
        last.heading = `${last.heading} ${line.text}`;
        (last as { lastLine?: Line }).lastLine = line;
        continue;
      }
    }
    out.push(isHead ? { heading: line.text, first: line } : line);
  }
  return out;
}

function headingMode(heading: string, letter: string): Mode | undefined {
  const h = heading.replace(/[’']/g, "'");
  if (/^Digest by the Ballot Simplification Council$/.test(h)) return { kind: "digest" };
  if (/^Controller's Statement on/.test(h))
    return { kind: "analysis", by: "City Controller", title: heading };
  const impartial = /^(.*?)\s*Impartial Analysis of\b/.exec(h);
  if (impartial) {
    const by = heading.slice(0, impartial[1]?.length).trim();
    return { kind: "analysis", by, title: heading.slice(by.length).trim() };
  }
  if (/^How .+ Got on the Ballot$/.test(h)) return { kind: "history" };
  if (h === "Proponent's Argument") return { kind: "argument", side: "Yes", rebuttal: false };
  if (h === "Rebuttal to Proponent's Argument")
    return { kind: "argument", side: "No", rebuttal: true };
  if (h === "Opponent's Argument") return { kind: "argument", side: "No", rebuttal: false };
  if (h === "Rebuttal to Opponent's Argument")
    return { kind: "argument", side: "Yes", rebuttal: true };
  if (/^No .*Were Submitted$|^No .*Was Submitted$/i.test(h)) return { kind: "none" };
  if (/^Paid Arguments in Favor$/i.test(h)) return { kind: "paid", side: "Yes" };
  if (/^Paid Arguments Against$/i.test(h)) return { kind: "paid", side: "No" };
  problems.push(`measure ${letter}: unknown heading "${heading}"`);
  return undefined;
}

function collectMeasure(letter: string, measureParts: PageParts[]): Collected {
  const c: Collected = {
    title: [],
    question: [],
    threshold: [],
    digest: [],
    history: { heading: "", lines: [] },
    arguments: [],
    paid: [],
  };
  let mode: Mode = { kind: "question" };
  for (const part of measureParts) {
    // The ballot's YES / NO boxes beside the question.
    const body = part.body.filter((l) => !(/^(YES|NO)$/.test(l.text) && l.x0 > 450));
    for (const entry of headings(body)) {
      if ("heading" in entry) {
        const next = headingMode(entry.heading, letter);
        if (!next) continue;
        mode = next;
        if (mode.kind === "analysis") c.analysis = { by: mode.by, title: mode.title, lines: [] };
        else if (mode.kind === "history") c.history.heading = entry.heading;
        else if (mode.kind === "argument")
          c.arguments.push({
            side: mode.side,
            rebuttal: mode.rebuttal,
            lines: [],
            footer: part.footer,
          });
        else if (mode.kind === "paid")
          c.paid.push({ side: mode.side, lines: [], footer: part.footer });
        continue;
      }
      const line = entry;
      switch (mode.kind) {
        case "question":
          if (line.size >= 18) c.title.push(line);
          else if (/^This (regional )?measure requires/.test(line.text) || c.threshold.length)
            c.threshold.push(line);
          else c.question.push(line);
          break;
        case "digest":
          c.digest.push(line);
          break;
        case "analysis":
          c.analysis?.lines.push(line);
          break;
        case "history":
          c.history.lines.push(line);
          break;
        case "argument":
          c.arguments[c.arguments.length - 1]?.lines.push(line);
          break;
        case "paid":
          c.paid[c.paid.length - 1]?.lines.push(line);
          break;
        case "none":
          break;
      }
    }
  }
  return c;
}

/** Leading fully bold lines: an argument's headline. */
function splitTitle(lines: Line[]): { title?: string; rest: Line[] } {
  let n = 0;
  while (n < lines.length && lines[n]?.bold) n++;
  if (n === 0 || n === lines.length) return { rest: lines };
  return { title: plain(lines.slice(0, n)), rest: lines.slice(n) };
}

/** A line that reads like a signature rather than a sentence. */
function signatureLike(text: string): boolean {
  return (
    text.length <= 90 &&
    !/[!?:;]$/.test(text) &&
    !/\b[a-z]{2,}\.$/.test(text) &&
    // A sentence ends inside it ("… on our streets. Vote No on F.").
    !/[a-z]{2,}[.!?]["”]?\s+\p{Lu}/u.test(text) &&
    !/^(vote|join|read|please|and|but|so)\b/i.test(text)
  );
}

/**
 * The signatures at the end of an argument: the trailing signature-like lines of its last
 * paragraph, and the footnote printed under them ("*For identification purposes only …").
 */
function splitSigners(lines: Line[]): { body: Line[]; signers: Signer[]; footnote?: string } {
  const groups = paragraphs(lines);
  let footnote: string | undefined;
  let tail = lines.length;
  const lastGroup = groups[groups.length - 1];
  if (lastGroup && /^\*/.test(lastGroup[0]?.text ?? "")) {
    footnote = plain(lastGroup);
    groups.pop();
    tail -= lastGroup.length;
  }
  const last = groups[groups.length - 1];
  if (!last) return { body: lines.slice(0, tail), signers: [], footnote };
  let n = last.length;
  while (n > 0 && signatureLike((last[n - 1] as Line).text)) n--;
  // A wrapped signature line ("of Supervisors") belongs to the one above it. Signers break
  // their own lines, so only a word that clearly couldn't fit counts as a wrap.
  // A signature ending in "*" or "." is complete, and "Name, Title" starts a new one. A
  // capitalised wrap shows itself by carrying the signer's footnote mark ("Development
  // Center*"); geometry alone can't tell, since signers break their own lines.
  const wraps = (i: number) => {
    if (i === 0) return false;
    const prev = last[i - 1] as Line;
    const line = last[i] as Line;
    if (/^\p{Ll}/u.test(line.text)) return true;
    if (/[*.]$/.test(prev.text) || /^[^,]+, /.test(line.text)) return false;
    return /\*$/.test(line.text) && wrapsFrom(prev, line);
  };
  while (n < last.length && wraps(n)) n++;
  const signed = last.slice(n);
  const body = lines.slice(0, tail - signed.length);
  if (signed.length === 0) return { body, signers: [], footnote };
  const merged: string[] = [];
  for (const [i, line] of signed.entries()) {
    if (i > 0 && wraps(n + i)) merged[merged.length - 1] += ` ${line.text}`;
    else merged.push(line.text);
  }
  return {
    body,
    footnote,
    signers: merged.map((text): Signer => {
      const comma = text.indexOf(", ");
      return comma > 0 && !/^(Jr|Sr|Inc|II|III)\b/.test(text.slice(comma + 2))
        ? { name: text.slice(0, comma), title: text.slice(comma + 2) }
        : { name: text };
    }),
  };
}

const ARGUMENT_CAVEAT_RE = /Arguments are the opinions of the authors/;

function toArgument(
  side: string,
  rebuttal: boolean,
  lines: Line[],
  footer: string,
  paid: boolean,
): Argument | undefined {
  if (lines.length === 0) return undefined;
  let funding: string | undefined;
  let content = lines;
  if (paid) {
    const at = lines.findIndex((l) => /^The true source\(s\) of funds/.test(l.text));
    if (at >= 0) {
      funding = plain(lines.slice(at));
      content = lines.slice(0, at);
    }
  }
  const { title, rest } = splitTitle(content);
  const { body, signers, footnote } = splitSigners(rest);
  return {
    side,
    rebuttal,
    ...(title ? { title } : {}),
    blocks: blocksOf(body),
    signers,
    ...(footnote ? { footnote } : {}),
    ...(paid ? { paid: true } : {}),
    ...(funding ? { funding } : {}),
    source: sourceAt(lines[0]?.page ?? 1),
    ...(ARGUMENT_CAVEAT_RE.test(footer) ? { disclaimer: footer } : {}),
  };
}

/** Funding paragraphs after the first: "The three largest contributors…", "The sole contributor…". */
const FUNDING_MORE = /^The (?:\S+ )*?(?:contributors?|true source)\b/;

/** Paid arguments run on one after another; each ends with its funding lines. */
function splitPaid(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let current: Line[] = [];
  let inFunding = false;
  for (const [i, line] of lines.entries()) {
    const prev = lines[i - 1];
    if (inFunding) {
      const continues =
        line.size < 9.6 &&
        prev &&
        (joint(prev, line) !== "paragraph" || FUNDING_MORE.test(line.text));
      if (continues) {
        current.push(line);
        continue;
      }
      out.push(current);
      current = [];
      inFunding = false;
    }
    if (/^The true source\(s\) of funds/.test(line.text)) inFunding = true;
    current.push(line);
  }
  if (current.length) out.push(current);
  return out;
}

/** Digest: "The Way It Is Now", "The Proposal" → summary; what a Yes and a No vote mean → means. */
function splitDigest(lines: Line[]): { summary: Line[]; yes: Line[]; no: Line[] } {
  const out = { summary: [] as Line[], yes: [] as Line[], no: [] as Line[] };
  let target = out.summary;
  for (const line of lines) {
    const lead = segments(line)[0];
    if (lead?.bold) {
      if (/^A “?YES”? Vote Means/i.test(lead.text.trim())) target = out.yes;
      else if (/^A “?NO”? Vote Means/i.test(lead.text.trim())) target = out.no;
      else if (/^(The Way It Is Now|The Proposal)/.test(lead.text.trim())) target = out.summary;
    }
    target.push(line);
  }
  return out;
}

function scrapeMeasure(letter: string, measureParts: PageParts[], legalPage?: number): void {
  const title = measureTitle(letter);
  if (!title) return;
  const item = itemFor(title);
  if (!item) return;
  const c = collectMeasure(letter, measureParts);
  const first = measureParts[0]?.page.number ?? 1;

  const about: Block[] = [];
  if (c.question.length) about.push({ type: "p", text: [{ strong: [plain(c.question)] }] });
  if (c.threshold.length) about.push({ type: "p", text: [plain(c.threshold)] });
  if (c.history.lines.length) {
    about.push({ type: "h", level: 3, text: [c.history.heading] });
    about.push(...blocksOf(c.history.lines));
  }
  if (about.length) item.about = { blocks: about, source: sourceAt(first) };
  else problems.push(`measure ${letter}: no question found`);

  if (c.digest.length) {
    const d = splitDigest(c.digest);
    item.summary = {
      title: "Digest",
      by: "Ballot Simplification Council",
      blocks: blocksOf(d.summary),
      source: sourceAt(d.summary[0]?.page ?? first),
    };
    const means: Record<string, Passage> = {};
    if (d.yes.length)
      means.Yes = { blocks: blocksOf(d.yes), source: sourceAt(d.yes[0]?.page ?? first) };
    if (d.no.length)
      means.No = { blocks: blocksOf(d.no), source: sourceAt(d.no[0]?.page ?? first) };
    if (Object.keys(means).length) item.means = means;
  }
  if (c.analysis?.lines.length) {
    item.analysis = {
      title: c.analysis.title,
      by: c.analysis.by,
      blocks: blocksOf(c.analysis.lines),
      source: sourceAt(c.analysis.lines[0]?.page ?? first),
    };
  }

  const args: Argument[] = [];
  for (const a of c.arguments) {
    const arg = toArgument(a.side, a.rebuttal, a.lines, a.footer, false);
    if (arg) args.push(arg);
  }
  for (const p of c.paid) {
    for (const lines of splitPaid(p.lines)) {
      const arg = toArgument(p.side, false, lines, p.footer, true);
      if (arg) args.push(arg);
      if (arg && !arg.funding)
        problems.push(`measure ${letter}: a paid argument has no funding line`);
    }
  }
  if (args.length) item.arguments = args;

  if (legalPage) {
    item.documents = [
      {
        title: `Legal text of ${/^RTM$/.test(letter) ? "Regional Measure RTM" : `Proposition ${letter}`}`,
        source: PDF_URL,
        mediaType: "application/pdf",
        page: legalPage,
        sha256: retrieved.sha256,
      },
    ];
  } else problems.push(`measure ${letter}: no legal text found`);
}

function scrapeMeasures(): void {
  const byMeasure = new Map<string, PageParts[]>();
  const legal = new Map<string, number>();
  for (const part of parts) {
    const local = /^Local Ballot Measures – Proposition ([A-Z])( – Paid Arguments)?$/.exec(
      part.header,
    );
    const regional = /^Regional Measure ([A-Z]+)$/.exec(part.header);
    const letter = local?.[1] ?? regional?.[1];
    if (letter) byMeasure.set(letter, [...(byMeasure.get(letter) ?? []), part]);
    const text = /^Legal Text – (?:Regional Measure ([A-Z]+)|Propositions? (.+?))(?: \d+)?$/.exec(
      part.header,
    );
    if (text) {
      const letters = text[1] ? [text[1]] : (text[2]?.match(/\b[A-Z]\b/g) ?? []);
      for (const l of letters) if (!legal.has(l)) legal.set(l, part.page.number);
    }
  }
  for (const [letter, measureParts] of byMeasure)
    scrapeMeasure(letter, measureParts, legal.get(letter));
}

// ---------------------------------------------------------------- run

scrapeOffices();
scrapeStatements();
scrapeMeasures();

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
await Bun.write(
  join(OUT, "guide.json"),
  `${JSON.stringify(
    {
      context: {
        election: ELECTION,
        jurisdiction: "us/ca/sf",
        title:
          "San Francisco Voter Information Pamphlet: November 3, 2026 Consolidated General Election",
      },
      attribution: {
        of: {
          name: "San Francisco Department of Elections",
          uri: "https://www.sf.gov/departments--department-elections",
          kind: "election-authority",
        },
        mode: "scraped",
        retrieved_at: retrieved.retrieved_at,
        sources: [PDF_URL],
      },
    },
    null,
    2,
  )}\n`,
);
mkdirSync(EVIDENCE, { recursive: true });
await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

const counts = { races: 0, measures: 0, statements: 0, arguments: 0, paid: 0 };
for (const item of items.values()) {
  if (item.subject.kind === "race") counts.races++;
  else counts.measures++;
  counts.statements += item.candidates?.length ?? 0;
  counts.arguments += item.arguments?.filter((a) => !a.paid).length ?? 0;
  counts.paid += item.arguments?.filter((a) => a.paid).length ?? 0;
}
console.error(`${items.size} items: ${JSON.stringify(counts)}`);
if (notes.length) console.error(`\nnames matched loosely:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
