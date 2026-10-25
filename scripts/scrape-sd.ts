#!/usr/bin/env bun
// Build county/sd/ from San Diego County's Voter Information Pamphlets for one election: every
// candidate statement (Congress, the Legislature, and every local office) and each local
// measure's question, impartial analysis, arguments and rebuttals (with their signers), and
// where its full text starts.
//
// San Diego publishes one pamphlet per ballot type, each assembled from shared sections whose
// code is printed at the foot of every page ("CS-J03030-1-ENG" for a contest's statements,
// "PR-Q00001-2-ENG" for a measure's pages). scripts/sd-index.ts records each ballot type's
// bookmarks; this picks the fewest pamphlets whose bookmarks together cover every contest and
// measure, downloads only those (cached in .cache/, never committed), and reads each section
// once. A statement section goes to the race whose candidates it names; a measure section to the
// measure its header names, both as the SD ballot source in the endorsements catalog has them.
//
//   bun scripts/scrape-sd.ts [--refresh] [--subjects contest-subjects.json --ballot positions.json]

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  ELECTION,
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
import { type Line, pdfPages } from "./lib/pdf-layout";
import type { BallotType } from "./sd-index";

const OUT = "county/sd";
const EVIDENCE = "evidence/county/sd";
const CACHE = ".cache/county/sd";
const CATALOG = `https://cinderblock.github.io/openslate-public-endorsements/orgs/sd-registrar-of-voters/${ELECTION}`;
const PAMPHLETS_PAGE = "https://www.sdvote.com/content/rov/en/sample-ballot-info-lookup.html";
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const refresh = process.argv.includes("--refresh");
const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;

// ---------------------------------------------------------------- inputs

const ballotTypes = Object.values(
  JSON.parse(await Bun.file(join(EVIDENCE, "ballot-types.json")).text()) as Record<
    string,
    BallotType
  >,
);
const subjectsArg = argAfter("--subjects");
const contestSubjects = (
  subjectsArg
    ? await Bun.file(subjectsArg).json()
    : await (await fetchOk(`${CATALOG}/contest-subjects.json`)).json()
) as { contests: Record<string, Subject>; measures: Record<string, Subject> };
const ballotArg = argAfter("--ballot");
const races = new Map<string, BallotRace>([
  ...(await loadRaces(ballotSourceUrl("ca-secretary-of-state"))),
  ...(await loadRaces(ballotArg ?? ballotSourceUrl("sd-registrar-of-voters"))),
]);

// ---------------------------------------------------------------- which pamphlets

/** Bookmarks every pamphlet has (instructions, dates) say nothing about which contests it covers. */
const everywhere = new Set(
  ballotTypes[0]?.outline.filter((title) => ballotTypes.every((t) => t.outline.includes(title))),
);
/** Greedy cover: keep taking the pamphlet with the most bookmarks not yet covered. */
function choosePamphlets(): BallotType[] {
  const uncovered = new Set(
    ballotTypes.flatMap((t) => t.outline).filter((x) => !everywhere.has(x)),
  );
  const chosen: BallotType[] = [];
  while (uncovered.size > 0) {
    let best: BallotType | undefined;
    let gain = 0;
    for (const t of ballotTypes) {
      const g = new Set(t.outline.filter((x) => uncovered.has(x))).size;
      if (g > gain) {
        gain = g;
        best = t;
      }
    }
    if (!best) break;
    chosen.push(best);
    for (const x of best.outline) uncovered.delete(x);
  }
  return chosen;
}

// ---------------------------------------------------------------- fetching, cached

interface Retrieved {
  url: string;
  sha256: string;
  bytes: number;
  retrieved_at: string;
}
const indexPath = join(EVIDENCE, "pamphlets.json");
const index: Record<string, Retrieved> = existsSync(indexPath)
  ? JSON.parse(await Bun.file(indexPath).text())
  : {};

async function pamphlet(t: BallotType): Promise<{ bytes: Uint8Array; retrieved: Retrieved }> {
  const path = join(CACHE, `SB-ENG-${t.type}.pdf`);
  if (refresh || !existsSync(path) || !index[t.url]) {
    const bytes = new Uint8Array(await (await fetchOk(t.url, USER_AGENT)).arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    const sha256 = sha256Hex(bytes);
    const prior = index[t.url];
    index[t.url] =
      prior?.sha256 === sha256
        ? prior
        : { url: t.url, sha256, bytes: bytes.length, retrieved_at: now() };
    console.error(`downloaded SB-ENG-${t.type} (${(bytes.length / 1e6).toFixed(1)} MB)`);
    await Bun.sleep(1000);
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { bytes, retrieved: index[t.url] as Retrieved };
}

async function keep(file: string, text: string): Promise<void> {
  const path = join(EVIDENCE, file);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text.endsWith("\n") ? text : `${text}\n`);
}

// ---------------------------------------------------------------- items

const { items, itemFor } = itemStore();
const problems: string[] = [];
const notes: string[] = [];
/** Each measure's short title, by its heading ("SAN DIEGO COUNTY MEASURE A"). */
const measureTitles: Record<string, string> = {};
// ---------------------------------------------------------------- sections

const CODE = /^((?:CS|PR)-[A-Z]\d{5})-\d+-ENG$/;
const FOOTER_Y = 40;
// As the pamphlet words them, ahead of its statements and arguments.
const STATEMENT_CAVEAT =
  "The statements are the opinions of the authors and have not been checked for accuracy by any official agency.";
const ARGUMENT_CAVEAT =
  "Arguments in support of or in opposition to the proposed measures are the opinions of the authors and have not been checked for accuracy by any official agency.";

const AGE = /^AGE:\s*\d+$/;
const isName = (l: Line) =>
  l.bold &&
  l.size >= 8.5 &&
  l.column !== "full" &&
  !AGE.test(l.text) &&
  l.text === l.text.toUpperCase() &&
  /\p{Lu}{2}/u.test(l.text);

function readStatements(code: string, sectionLines: Line[], source: string, retrieved_at: string) {
  // "AGE: 44" is set beside a name, apart from it.
  const lines = sectionLines.filter((l) => !AGE.test(l.text));
  const reader = readerFor(lines);
  // The contest's own heading: the bold lines centred across the page above the first name.
  const firstName = lines.findIndex(isName);
  const header = lines
    .slice(0, Math.max(firstName, 0))
    .filter((l) => l.bold)
    .map((l) => l.text)
    .join(" / ");
  // Each candidate: a name in bold capitals, the ballot designation in bold (a line or two),
  // then the statement.
  const candidates: { printed: string; lines: Line[] }[] = [];
  for (const [i, line] of lines.entries()) {
    if (i < firstName) continue;
    const prev = lines[i - 1];
    if (isName(line) && (i === firstName || !prev?.bold || prev.column !== line.column)) {
      candidates.push({ printed: line.text, lines: [] });
      continue;
    }
    candidates[candidates.length - 1]?.lines.push(line);
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
  const item = itemFor(race.subject, retrieved_at);
  for (const c of candidates) {
    const choice = matchChoice(c.printed, race.choices) as string;
    if (normName(choice) !== normName(c.printed)) {
      notes.push(`${race.subject.title}: "${c.printed}" → "${choice}"`);
    }
    const start = c.lines.findIndex((l) => !l.bold);
    const body = start < 0 ? [] : c.lines.slice(start);
    item.candidates ??= [];
    if (item.candidates.some((x) => x.choice === choice)) continue;
    item.candidates.push({
      choice,
      statement: {
        by: choice,
        blocks: reader.blocksOf(joinBullets(body)),
        source: `${source}#page=${c.lines[0]?.page ?? lines[0]?.page ?? 1}`,
        disclaimer: STATEMENT_CAVEAT,
      },
    });
  }
}

/**
 * Could this line be a signer's name? Pamphlets set them in capitals ("JIM ROSS") or in bold
 * ("Rocky Chavez"), short, with no closing punctuation.
 */
function isSignerName(l: Line): boolean {
  const t = l.text.trim();
  if (t.length > 40 || !/\p{L}{2,}.*\s.*\p{L}/u.test(t)) return false;
  if (t === t.toUpperCase()) return /\p{Lu}{2,}/u.test(t);
  return l.bold && /^\p{Lu}/u.test(t) && (!/[.!?:,;]$/.test(t) || /\b(Jr|Sr)\.$/.test(t));
}

/**
 * The argument's signers, at its end (at most five, by law). Each is a name with its title
 * below it at the same indent, a line or a few; some pamphlets set them two across, so a title
 * belongs to the nearest name above it in its own column. A title's lines are one phrase where
 * it wraps ("Training Director," / "Sheet Metal Apprenticeship") and separate roles where it
 * doesn't ("Retired Oceanside School Teacher" / "Community Advocate").
 */
function signersFrom(
  lines: Line[],
  wraps: (prev: Line, line: Line) => boolean,
): { body: Line[]; signers: Signer[] } {
  /** The signers if lines[start..] are all signers' names and titles, else undefined. */
  function block(start: number): Signer[] | undefined {
    const names = lines.slice(start).filter(isSignerName);
    if (names.length === 0 || names.length > 5 || lines[start] !== names[0]) return undefined;
    const titles = new Map<Line, Line[]>(names.map((n) => [n, []]));
    for (const line of lines.slice(start)) {
      if (names.includes(line)) continue;
      const above = names
        .filter(
          (n) =>
            n.page === line.page &&
            Math.abs(n.x0 - line.x0) < 4 &&
            n.y > line.y &&
            n.y - line.y < 40,
        )
        .sort((a, b) => a.y - b.y)[0];
      if (!above) return undefined;
      titles.get(above)?.push(line);
    }
    if ([...titles.values()].some((t) => t.length > 3)) return undefined;
    return names.map((n) => {
      const title = (titles.get(n) ?? [])
        .map((l, i, all) => {
          const prev = all[i - 1];
          if (!prev) return l.text;
          return /[,–-]$/.test(prev.text) || wraps(prev, l) ? ` ${l.text}` : `, ${l.text}`;
        })
        .join("");
      const printed = n.text.trim();
      return {
        name: printed === printed.toUpperCase() ? nameCase(printed) : printed,
        ...(title ? { title } : {}),
      };
    });
  }
  for (let start = Math.max(1, lines.length - 20); start < lines.length; start++) {
    const signers = block(start);
    if (signers) return { body: lines.slice(0, start), signers };
  }
  return { body: lines, signers: [] };
}

/** Printed atop every argument page: the caveat, kept as the arguments' disclaimer. */
const CAVEAT_LINE =
  /^(arguments in support (of )?or (in )?opposition( to| of the proposed)?|(the proposed )?laws are the opinions of the( authors)?|authors)$/i;

function readMeasure(code: string, sectionLines: Line[], source: string, retrieved_at: string) {
  const lines = sectionLines.filter((l) => l.text !== "`" && !CAVEAT_LINE.test(l.text));
  const reader = readerFor(lines);
  // "SAN DIEGO COUNTY" / "MEASURE A" across the top of the first page.
  const first = lines[0]?.page;
  const top = lines.filter(
    (l) => l.page === first && l.column === "full" && l.bold && l.size >= 11,
  );
  const name = top
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // The short title printed in bold under the ballot's "MEASURE A": the ballot source names a
  // measure the catalog doesn't have yet by it.
  const label = lines.findIndex(
    (l) => l.page === first && l.column !== "full" && l.bold && /^MEASURE [A-Z]+$/.test(l.text),
  );
  const shortTitle: string[] = [];
  for (const l of label < 0 ? [] : lines.slice(label + 1)) {
    if (!l.bold || l.size > 10) break;
    shortTitle.push(l.text);
  }
  if (shortTitle.length) measureTitles[name] = shortTitle.join(" ");
  const subject = contestSubjects.measures[name];
  if (!subject) {
    problems.push(`${code}: no measure "${name}" in the SD ballot source`);
    return;
  }
  const item = itemFor(subject, retrieved_at);
  const parts = measureParts(lines.filter((l) => !top.includes(l)));
  const page = (p: (typeof parts)[number]) => `${source}#page=${p.lines[0]?.page ?? first ?? 1}`;

  // The ballot's form of the measure: its name again, a short title in bold, the question and
  // the vote it needs.
  const question = (parts[0] as (typeof parts)[number]).lines.filter(
    (l) =>
      !/appear on the ballot in the following form/i.test(l.text) &&
      !(l.bold && /^MEASURE [A-Z]+$/.test(l.text)) &&
      // The ballot's boxes beside the question ("Tax – YES", "Tax – NO").
      !/^(?:Tax\s*[–-]\s*)?(?:YES|NO)$/.test(l.text.trim()),
  );
  if (question.length)
    item.about = {
      blocks: reader.blocksOf(question),
      source: page(parts[0] as (typeof parts)[number]),
    };
  else problems.push(`${code} ${name}: no question`);

  const analysis = parts.find((p) => p.kind === "analysis");
  if (analysis) {
    // What a yes or a no vote means closes the analysis.
    const { content, means } = votesMean(analysis.lines, reader, page(analysis));
    if (means) item.means = means;
    const by = /^(.*?)\s*IMPARTIAL ANALYSIS/.exec(analysis.heading)?.[1]?.trim();
    const tax = parts.filter((p) => p.kind === "tax");
    item.analysis = {
      title: "Impartial Analysis",
      ...(by ? { by: wordCase(by) } : {}),
      blocks: [
        ...reader.blocksOf(joinBullets(content)),
        ...tax.flatMap((p) => [
          { type: "h" as const, level: 3 as const, text: [wordCase(p.heading)] },
          ...reader.blocksOf(joinBullets(p.lines)),
        ]),
      ],
      source: page(analysis),
    };
  } else notes.push(`${name}: no impartial analysis`);

  const args: Argument[] = [];
  for (const p of parts) {
    const m = /^(argument|rebuttal)-(yes|no)$/.exec(p.kind);
    if (!m || p.lines.length === 0) continue;
    const { body, signers } = signersFrom(p.lines, reader.wrapsFrom);
    if (signers.length === 0) problems.push(`${code} ${name}: no signers for "${p.heading}"`);
    args.push({
      side: m[2] === "yes" ? "Yes" : "No",
      rebuttal: m[1] === "rebuttal",
      blocks: reader.blocksOf(joinBullets(body)),
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
        title: `Full text of ${wordCase(name.replace(/^.* (MEASURE [A-Z]+)$/, "$1"))}`,
        source,
        mediaType: "application/pdf",
        page: text.lines[0]?.page ?? first ?? 1,
        sha256: index[source]?.sha256 ?? "",
      },
    ];
  } else notes.push(`${name}: no full text`);
}

// ---------------------------------------------------------------- run

const chosen = choosePamphlets();
console.error(
  `${ballotTypes.length} ballot types indexed; ${chosen.length} pamphlets cover every bookmark`,
);
const seen = new Set<string>();
try {
  for (const t of chosen) {
    const { bytes, retrieved } = await pamphlet(t);
    const pages = await pdfPages(bytes);
    // Each page's section code, at its foot.
    const sections = new Map<string, Line[]>();
    for (const page of pages) {
      const code = page.lines.map((l) => CODE.exec(l.text)?.[1]).find(Boolean);
      if (!code || seen.has(code)) continue;
      const body = page.lines.filter((l) => l.y > FOOTER_Y && !/^SD \d{3}-\d{3}$/.test(l.text));
      sections.set(code, [...(sections.get(code) ?? []), ...body]);
    }
    for (const [code, lines] of sections) {
      seen.add(code);
      await keep(`sections/${code}.txt`, lines.map((l) => `p${l.page} ${l.text}`).join("\n"));
      if (code.startsWith("CS-")) readStatements(code, lines, t.url, retrieved.retrieved_at);
      else readMeasure(code, lines, t.url, retrieved.retrieved_at);
    }
  }
} finally {
  mkdirSync(EVIDENCE, { recursive: true });
  await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const titles = Object.entries(measureTitles).sort(([a], [b]) => a.localeCompare(b));
  await Bun.write(
    join(EVIDENCE, "measure-titles.json"),
    `${JSON.stringify(Object.fromEntries(titles), null, 2)}\n`,
  );
}

const retrieved = Object.values(index)
  .map((e) => e.retrieved_at)
  .sort();
await writeGuide(OUT, items, {
  context: {
    election: ELECTION,
    jurisdiction: "us/ca/san-diego-county",
    title:
      "San Diego County Voter Information Pamphlet: November 3, 2026 Gubernatorial General Election",
  },
  attribution: {
    of: {
      name: "San Diego County Registrar of Voters",
      uri: "https://www.sdvote.com/",
      kind: "election-authority",
    },
    mode: "scraped",
    retrieved_at: retrieved.at(-1) ?? now(),
    sources: [PAMPHLETS_PAGE],
  },
});

const counts = { ...countItems(items), sections: seen.size };
console.error(`${items.size} items: ${JSON.stringify(counts)}`);
if (process.argv.includes("--verbose") && notes.length)
  console.error(`\nnotes:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
