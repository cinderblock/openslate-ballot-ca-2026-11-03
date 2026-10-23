#!/usr/bin/env bun
// Build county/alameda/ from Alameda County's Voter Information Guide for one election: every
// candidate statement (Congress, the Legislature, and every local office, with the photos
// Berkeley and Oakland print) and each measure's question, impartial analysis, arguments and
// rebuttals (with their signers), and where its full text starts.
//
// Alameda prints one guide for the whole county (about 965 pages, cached in .cache/, never
// committed). Each contest's pages carry a code at their foot ("CD10-1", "BCC1-1", "RTM-2").
// A statement page goes to the race whose candidates it names, a measure to the measure its
// heading names, both as the Alameda ballot source in the endorsements catalog has them.
//
// The measure pages are set in fonts that pdf.js reads as glyph numbers ("WUD൶F" for "traffic");
// scripts/lib/pdf-layout.ts decodes them.
//
//   bun scripts/scrape-alameda.ts [--refresh] [--subjects contest-subjects.json --ballot positions.json]

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  ELECTION,
  type Item,
  type Signer,
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
import {
  countItems,
  itemStore,
  joinBullets,
  measureParts,
  nameCase,
  raceFor,
  readerFor,
  votesMean,
  wordCase,
  writeGuide,
} from "./lib/pamphlet";
import { pdfImages } from "./lib/pdf-images";
import { type Line, pdfPages } from "./lib/pdf-layout";

const OUT = "county/alameda";
const EVIDENCE = "evidence/county/alameda";
const CACHE = ".cache/county/alameda";
const CATALOG = `https://cinderblock.github.io/openslate-public-endorsements/orgs/alameda-registrar-of-voters/${ELECTION}`;
const GUIDE_URL = `https://acvote.alamedacountyca.gov/acvote-assets/02_election_information/PDFs/${ELECTION.replaceAll("-", "")}/Voter%20Information%20Guide/vig_nov${ELECTION.slice(0, 4)}_eng.pdf`;
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const refresh = process.argv.includes("--refresh");
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;

// ---------------------------------------------------------------- inputs

const subjectsArg = argAfter("--subjects");
const contestSubjects = (
  subjectsArg
    ? await Bun.file(subjectsArg).json()
    : await (await fetchOk(`${CATALOG}/contest-subjects.json`)).json()
) as { contests: Record<string, Subject>; measures: Record<string, Subject> };
const races = new Map<string, BallotRace>([
  ...(await loadRaces(ballotSourceUrl("ca-secretary-of-state"))),
  ...(await loadRaces(argAfter("--ballot") ?? ballotSourceUrl("alameda-registrar-of-voters"))),
]);

const cached = join(CACHE, "vig.pdf");
const retrievedPath = join(EVIDENCE, "guide-pdf.json");
if (refresh || !existsSync(cached) || !existsSync(retrievedPath)) {
  const bytes = new Uint8Array(await (await fetchOk(GUIDE_URL, USER_AGENT)).arrayBuffer());
  mkdirSync(dirname(cached), { recursive: true });
  await Bun.write(cached, bytes);
  const sha256 = sha256Hex(bytes);
  const prior = existsSync(retrievedPath) ? await Bun.file(retrievedPath).json() : undefined;
  mkdirSync(EVIDENCE, { recursive: true });
  await Bun.write(
    retrievedPath,
    `${JSON.stringify(
      prior?.sha256 === sha256
        ? prior
        : { url: GUIDE_URL, sha256, bytes: bytes.length, retrieved_at: now() },
      null,
      2,
    )}\n`,
  );
}
const retrieved = (await Bun.file(retrievedPath).json()) as {
  sha256: string;
  retrieved_at: string;
};
const bytes = new Uint8Array(await Bun.file(cached).arrayBuffer());

// ---------------------------------------------------------------- the guide's sections

const pages = await pdfPages(bytes, { repairGlyphFonts: true });
/** Where candidate statements start: the first "Candidate’s Statement" heading. */
const firstStatement = pages.find((p) =>
  p.lines.some((l) => /^Candidate[’']s Statement$/.test(l.text)),
)?.number;
if (!firstStatement) throw new Error("no candidate statements in the guide");
/** A contest's code at a page's foot ("CD10-1"), and the section-tab digit beside it. */
const CODE = /^([A-Z][A-Z0-9-]*?)-(\d+)$/;
const FOOTER_Y = 36;

const sections = new Map<string, Line[]>();
const seenPages = new Set<string>();
for (const page of pages) {
  if (page.number < firstStatement) continue;
  const code = page.lines
    .filter((l) => l.y < FOOTER_Y && l.size < 9)
    // The guide misprints some as "BMX-BMX-4".
    .map((l) => CODE.exec(l.text)?.[1]?.replace(/^(.+)-\1$/, "$1"))
    .find(Boolean);
  if (!code) continue;
  const body = page.lines.filter(
    (l) =>
      l.y >= FOOTER_Y &&
      // The section tab at the page's edge ("4", "CANDIDATE STATEMENTS").
      l.x0 < page.width - 40,
  );
  // A contest's page printed twice (Water District Ward 2 again among Newark's) reads once.
  const text = body.map((l) => l.text).join("\n");
  if (seenPages.has(text)) continue;
  seenPages.add(text);
  sections.set(code, [...(sections.get(code) ?? []), ...body]);
}

const photos = await pdfImages(bytes, {
  pages: (n) => n >= firstStatement,
  minWidth: 100,
});

// ---------------------------------------------------------------- items

const { items, itemFor } = itemStore();
const problems: string[] = [];
const notes: string[] = [];
const source = (page: number) => `${GUIDE_URL}#page=${page}`;
// As the guide words them, ahead of its statements and measures.
const STATEMENT_CAVEAT =
  "Statements have been printed as submitted by the candidates, including any typographical, spelling, or grammatical errors. The statements have not been checked for accuracy by the Registrar of Voters’ office.";
const ARGUMENT_CAVEAT =
  "Arguments in support of or in opposition to the proposed laws are the opinions of the authors.";
/** Berkeley's and Oakland's statements open "I, NAME, hereby declare…". */
const DECLARES = /^I, .+?, hereby declare/;
/** Bullets, and bullets in symbol fonts that pdf.js reads as other characters (Ɣ, ƒ, ƕ, භ, ō). */
const BULLETS = /^(?:[\u2022\u25cf\u0194\u0192\u0195\u0db7\u014d]|\u0366)$/;

/** A statement for a race's candidate, matching the printed name to the ballot's. */
function addStatement(
  item: Item,
  race: BallotRace,
  printed: string,
  statement: Item["candidates"] extends (infer C)[] | undefined ? NonNullable<C> : never,
) {
  item.candidates ??= [];
  if (item.candidates.some((c) => c.choice === statement.choice)) {
    problems.push(`${race.subject.title}: two statements for ${statement.choice} ("${printed}")`);
    return;
  }
  if (normName(statement.choice) !== normName(printed)) {
    notes.push(`${race.subject.title}: "${printed}" → "${statement.choice}"`);
  }
  item.candidates.push(statement);
}

/**
 * The standard statement: each candidate's name in capitals, "Occupation:", sometimes "Age:",
 * then the statement ("My education and qualifications are: …"), in two columns.
 */
function readStatements(code: string, lines: Line[]) {
  const reader = readerFor(lines);
  const isName = (i: number) =>
    /^Occupation:/.test(lines[i + 1]?.text ?? "") &&
    (lines[i] as Line).text === (lines[i] as Line).text.toUpperCase();
  const firstName = lines.findIndex((_, i) => isName(i));
  const header = lines
    .slice(0, Math.max(firstName, 0))
    .map((l) => l.text)
    .filter((t) => !/^Candidate[’']s Statement$/.test(t))
    .join(" / ");
  const candidates: { printed: string; lines: Line[] }[] = [];
  for (const [i, line] of lines.entries()) {
    if (i < firstName) continue;
    if (isName(i)) candidates.push({ printed: line.text, lines: [] });
    else candidates[candidates.length - 1]?.lines.push(line);
  }
  if (candidates.length === 0) {
    problems.push(`${code}: no candidates under "${header}"`);
    return;
  }
  const found = raceFor(
    candidates.map((c) => c.printed),
    header,
    races,
  );
  if ("problem" in found) {
    problems.push(`${code} ${found.problem}`);
    return;
  }
  const { race } = found;
  const item = itemFor(race.subject, retrieved.retrieved_at);
  for (const c of candidates) {
    const body = c.lines.filter((l) => !/^(Occupation|Age):/.test(l.text));
    addStatement(item, race, c.printed, {
      choice: matchChoice(c.printed, race.choices) as string,
      statement: {
        by: matchChoice(c.printed, race.choices) as string,
        blocks: reader.blocksOf(joinBullets(body, BULLETS)),
        source: source(c.lines[0]?.page ?? lines[0]?.page ?? 1),
        disclaimer: STATEMENT_CAVEAT,
      },
    });
  }
}

/**
 * Berkeley's and Oakland's form: one candidate a page, a photo at the top left, and a declaration
 * ("I, JOHN “STEVE” KROMER, hereby declare…") of numbered items, signed "s NAME/".
 */
function readDeclaration(code: string, lines: Line[]) {
  const reader = readerFor(lines);
  const declares = lines.findIndex((l) => DECLARES.test(l.text));
  const printed = /^I, (.+?), hereby declare/.exec(lines[declares]?.text ?? "")?.[1];
  if (declares < 0 || !printed) {
    problems.push(`${code}: no declaration`);
    return;
  }
  const header = lines
    .slice(0, declares)
    .map((l) => l.text)
    .join(" / ");
  const found = raceFor([printed], header, races);
  if ("problem" in found) {
    problems.push(`${code} ${found.problem}`);
    return;
  }
  const { race } = found;
  const choice = matchChoice(printed, race.choices) as string;
  // Its signature closes it. Each numbered item is a paragraph, however its lines fall.
  const body = lines.slice(declares).filter((l) => !signedBy(l.text));
  const paragraphs: Line[][] = [];
  for (const line of body) {
    const last = paragraphs[paragraphs.length - 1];
    if (!last || /^\d+\.\s/.test(line.text)) paragraphs.push([line]);
    else last.push(line);
  }
  const page = lines[0]?.page ?? 1;
  const photo = photos.find((p) => p.page === page);
  const item = itemFor(race.subject, retrieved.retrieved_at);
  addStatement(item, race, printed, {
    choice,
    ...(photo
      ? {
          photo: {
            file: `img/candidates/${slug(race.subject.title)}/${slug(choice)}.jpg`,
            alt: choice,
            source: source(page),
            credit: "Printed in Alameda County's Voter Information Guide",
          },
        }
      : {}),
    statement: {
      by: choice,
      blocks: paragraphs.map((p) => ({ type: "p" as const, text: reader.inlinesOf(p) })),
      source: source(page),
      disclaimer: STATEMENT_CAVEAT,
    },
  });
  if (photo)
    photoFiles.set(`img/candidates/${slug(race.subject.title)}/${slug(choice)}.jpg`, photo.jpeg);
  else notes.push(`${race.subject.title}: no photo for ${choice}`);
}
const photoFiles = new Map<string, Uint8Array>();

/**
 * Who signed, from a signature line: "s/ TIM SBRANTI", or "s ZAC UNGER/" where the "/" is drawn
 * over the name and so read after it.
 */
function signedBy(text: string): string | undefined {
  const m = /^\/?s\/\s*(.+?)\s*$|^s\s+(.+?)\s*\/$/.exec(text);
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * Signers, at an argument's end: a signature and the title indented beneath it; or for an
 * organization, "s/ League of Women Voters Bay Area" and "by NAME, Title".
 */
function signersFrom(lines: Line[]): { body: Line[]; signers: Signer[] } {
  const first = lines.findIndex((l) => signedBy(l.text));
  if (first < 0) return { body: lines, signers: [] };
  const signers: Signer[] = [];
  let current: { signed: string; under: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const by = /^by\s+(.+?)(?:,\s*(.+))?$/.exec(current.under[0] ?? "");
    const caps = (t: string) => (t === t.toUpperCase() ? nameCase(t) : t);
    if (by) {
      signers.push({
        name: caps(by[1] as string),
        ...(by[2] || current.under.length > 1
          ? { title: [by[2], ...current.under.slice(1)].filter(Boolean).join(" ") }
          : {}),
        organization: current.signed,
      });
    } else {
      const title = current.under.join(" ");
      signers.push({ name: caps(current.signed), ...(title ? { title } : {}) });
    }
  };
  for (const line of lines.slice(first)) {
    const signed = signedBy(line.text);
    if (signed) {
      flush();
      current = { signed, under: [] };
    } else current?.under.push(line.text);
  }
  flush();
  return { body: lines.slice(0, first), signers };
}

function readMeasure(code: string, sectionLines: Line[]) {
  const lines = joinBullets(sectionLines, BULLETS);
  const reader = readerFor(lines);
  const first = lines[0]?.page ?? 1;
  const top = lines.filter((l) => l.page === first && l.column === "full" && l.size >= 13);
  const name = top
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const subject = contestSubjects.measures[name];
  if (!subject) {
    problems.push(`${code}: no measure "${name}" in the Alameda ballot source`);
    return;
  }
  const item = itemFor(subject, retrieved.retrieved_at);
  const parts = measureParts(lines.filter((l) => !top.includes(l)));
  const page = (p: (typeof parts)[number]) => source(p.lines[0]?.page ?? first);

  // The ballot's question, set beside the measure's letter in large type and the YES/NO boxes.
  const question = (parts[0] as (typeof parts)[number]).lines
    .map((l) => ({
      ...l,
      runs: l.runs.filter((r) => r.size < 20 && !/^(YES|NO)$/.test(r.text.trim())),
    }))
    .filter((l) => l.runs.length > 0);
  if (question.length) {
    const text = question
      .map((l) => l.runs.map((r) => r.text).join(" "))
      // A label set letter-spaced ("H A Y W A R D") reads as its word.
      .map((t) => (/^(?:\S ){2,}\S$/.test(t.trim()) ? t.replace(/ /g, "") : t))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    item.about = {
      blocks: [{ type: "p", text: [text] }],
      source: page(parts[0] as (typeof parts)[number]),
    };
  } else problems.push(`${code} ${name}: no question`);

  const analysis = parts.find((p) => p.kind === "analysis");
  if (analysis) {
    const { body, signers } = signersFrom(analysis.lines);
    const { content, means } = votesMean(body, reader, page(analysis));
    if (means) item.means = means;
    const tax = parts.filter((p) => p.kind === "tax");
    const author = signers[0];
    item.analysis = {
      title: "Impartial Analysis",
      ...(author ? { by: [author.name, author.title].filter(Boolean).join(", ") } : {}),
      blocks: [
        ...reader.blocksOf(content),
        ...tax.flatMap((p) => [
          { type: "h" as const, level: 3 as const, text: [wordCase(p.heading)] },
          ...reader.blocksOf(p.lines),
        ]),
      ],
      source: page(analysis),
    };
  } else notes.push(`${name}: no impartial analysis`);

  const args: Argument[] = [];
  for (const p of parts) {
    const m = /^(argument|rebuttal)-(yes|no)$/.exec(p.kind);
    if (!m || p.lines.length === 0) continue;
    const { body, signers } = signersFrom(p.lines);
    if (signers.length === 0) problems.push(`${code} ${name}: no signers for "${p.heading}"`);
    args.push({
      side: m[2] === "yes" ? "Yes" : "No",
      rebuttal: m[1] === "rebuttal",
      blocks: reader.blocksOf(body),
      signers,
      source: page(p),
      disclaimer: ARGUMENT_CAVEAT,
    });
  }
  if (args.length) item.arguments = args;

  const text = parts.find((p) => p.kind === "text");
  if (text) {
    item.documents = [
      {
        title: `Full text of ${wordCase(name.replace(/^.*?((?:BOND )?MEASURE [A-Z]+)$/, "$1")).replace(/^Bond /, "")}`,
        source: GUIDE_URL,
        mediaType: "application/pdf",
        page: text.lines[0]?.page ?? first,
        sha256: retrieved.sha256,
      },
    ];
  } else notes.push(`${name}: no full text`);
}

// ---------------------------------------------------------------- run

for (const [code, lines] of sections) {
  if (lines.some((l) => /^Candidate[’']s Statement$/.test(l.text))) readStatements(code, lines);
  else if (lines.some((l) => DECLARES.test(l.text))) {
    // A page each; a page with no declaration of its own carries on the one before.
    const declarations: Line[][] = [];
    for (const page of new Set(lines.map((l) => l.page))) {
      const on = lines.filter((l) => l.page === page);
      if (on.some((l) => DECLARES.test(l.text)) || declarations.length === 0) declarations.push(on);
      else declarations[declarations.length - 1]?.push(...on);
    }
    for (const declaration of declarations) readDeclaration(code, declaration);
  } else if (lines.some((l) => l.size >= 13 && / MEASURE [A-Z]{1,3}$/.test(l.text)))
    readMeasure(code, lines);
  else notes.push(`${code}: not a statement or a measure (${lines[0]?.text ?? "empty"})`);
}

for (const [file, jpeg] of photoFiles) {
  const path = join(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, jpeg);
}
await writeGuide(OUT, items, {
  context: {
    election: ELECTION,
    jurisdiction: "us/ca/alameda-county",
    title: "Alameda County Voter Information Guide: November 3, 2026 General Election",
  },
  attribution: {
    of: {
      name: "Alameda County Registrar of Voters",
      uri: "https://acvote.alamedacountyca.gov/",
      kind: "election-authority",
    },
    mode: "scraped",
    retrieved_at: retrieved.retrieved_at,
    sources: [GUIDE_URL],
  },
});

console.error(
  `${items.size} items: ${JSON.stringify({ ...countItems(items), sections: sections.size })}`,
);
if (process.argv.includes("--verbose") && notes.length)
  console.error(`\nnotes:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
