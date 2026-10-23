#!/usr/bin/env bun
// Build county/oc/ from the Orange County Registrar of Voters' published material for one
// election: every candidate statement (Congress, the Legislature, and every local office; one
// small PDF each) and each local measure's question, what a Yes and a No vote mean, the impartial
// analysis (with who signed it), the arguments and rebuttals (with their signers), and where its
// full text starts in the measure's PDF.
//
// Which race each filing-log contest is, and where each statement PDF lives, come from the OC
// ballot source in the public endorsements catalog (`contest-subjects.json` and the filing log
// saved in its evidence), so the guide files everything under races the app already shows.
// Congress and Legislature districts take the Secretary of State's titles.
//
// The PDFs are cached in .cache/ (ignored by git); each one's URL, SHA-256 and retrieval time,
// and the text read from it, are kept under evidence/county/oc/. Full texts are linked by page:
// their tables and amendment markup don't survive text extraction.
//
//   bun scripts/scrape-oc.ts [--refresh]

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Argument,
  type BallotRace,
  type Block,
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
import { blockReader } from "./lib/pdf-blocks";
import { type Line, pdfPages } from "./lib/pdf-layout";

const OUT = "county/oc";
const EVIDENCE = "evidence/county/oc";
const CACHE = ".cache/county/oc";
const CATALOG = `https://cinderblock.github.io/openslate-public-endorsements/orgs/oc-registrar-of-voters/${ELECTION}`;
const FILING_LOG_PAGE = "https://ocvote.gov/candidates/candidate-filing-log-with-statements";
const MEASURES_PAGE = `https://ocvote.gov/elections/${ELECTION.slice(0, 4)}-general-election-measures-on-the-ballot`;
const USER_AGENT = "Mozilla/5.0 (compatible; openslate-ballot-scraper; +https://openslate.us)";
const PAUSE_MS = 400;
const refresh = process.argv.includes("--refresh");

// ---------------------------------------------------------------- fetching, cached

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

async function pdf(
  url: string,
  cacheFile: string,
): Promise<{ bytes: Uint8Array; retrieved: Retrieved }> {
  const path = join(CACHE, cacheFile);
  if (refresh || !existsSync(path) || !index[url]) {
    const bytes = new Uint8Array(await (await fetchOk(url, USER_AGENT)).arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    const sha256 = sha256Hex(bytes);
    const prior = index[url];
    index[url] = prior?.sha256 === sha256 ? prior : { url, sha256, retrieved_at: now() };
    await sleep(PAUSE_MS);
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const retrieved = index[url] as Retrieved;
  if (sha256Hex(bytes) !== retrieved.sha256)
    throw new Error(`${path} doesn't match ${url}'s recorded hash`);
  return { bytes, retrieved };
}

async function keep(file: string, text: string): Promise<void> {
  const path = join(EVIDENCE, file);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text.endsWith("\n") ? text : `${text}\n`);
}

// ---------------------------------------------------------------- subjects

interface FilingContest {
  contestId: number;
  office: string;
  body: string;
  seat: string;
  candidates: { name: string; designation: string; qualified: boolean; statementPdf?: string }[];
}
const { contests } = (await (await fetchOk(`${CATALOG}/evidence/filing-log.json`)).json()) as {
  contests: FilingContest[];
};
const { measures: measureList } = (await (
  await fetchOk(`${CATALOG}/evidence/measures.json`)
).json()) as {
  measures: { letter: string; body: string; title: string; pdf: string }[];
};
const contestSubjects = (await (await fetchOk(`${CATALOG}/contest-subjects.json`)).json()) as {
  contests: Record<string, Subject>;
  measures: Record<string, Subject>;
};
const races = new Map<string, BallotRace>([
  ...(await loadRaces(ballotSourceUrl("ca-secretary-of-state"))),
  ...(await loadRaces(ballotSourceUrl("oc-registrar-of-voters"))),
]);

/** Congress and Legislature districts, in the Secretary of State's titles. */
function stateDistrict(office: string): string | undefined {
  const n = (s: string) => s.replace(/(st|nd|rd|th)$/, "");
  let m = /^UNITED STATES REPRESENTATIVE (\d+\w*) District$/.exec(office);
  if (m) return `US House of Representatives, California District ${n(m[1] as string)}`;
  m = /^STATE SENATOR (\d+\w*) District$/.exec(office);
  if (m) return `California State Senate, District ${n(m[1] as string)}`;
  m = /^MEMBER OF THE STATE ASSEMBLY (\d+\w*) District$/.exec(office);
  if (m) return `California State Assembly, District ${n(m[1] as string)}`;
  return undefined;
}

const items = new Map<string, Item>();
const problems: string[] = [];
const notes: string[] = [];
function itemFor(subject: Subject, retrieved_at: string): Item {
  // A measure's parenthesis describes it; a race's ("(Short Term)") names a different seat.
  const title =
    subject.kind === "measure" ? subject.title.replace(/\s*\(.*\)\s*$/, "") : subject.title;
  const key = slug(title);
  let item = items.get(key);
  if (!item) {
    item = { v: 1, subject, retrieved_at };
    items.set(key, item);
  }
  if (retrieved_at > item.retrieved_at) item.retrieved_at = retrieved_at;
  return item;
}

// ---------------------------------------------------------------- statements

const STATEMENT_CAVEAT =
  "Statements are volunteered by the candidates and have not been checked for accuracy by any official agency.";

async function scrapeStatements(): Promise<void> {
  for (const contest of contests) {
    const subject =
      contestSubjects.contests[String(contest.contestId)] ??
      (() => {
        const title = stateDistrict(contest.office);
        return title ? races.get(title)?.subject : undefined;
      })();
    if (!subject) continue;
    const race = races.get(subject.title);
    if (!race) {
      problems.push(`${contest.office}: no race titled "${subject.title}" in the ballot sources`);
      continue;
    }
    for (const candidate of contest.candidates) {
      if (!candidate.qualified || !candidate.statementPdf) continue;
      const choice = matchChoice(candidate.name, race.choices);
      if (!choice) {
        problems.push(
          `${subject.title}: "${candidate.name}" isn't on the ballot (${race.choices.join(", ")})`,
        );
        continue;
      }
      if (normName(choice) !== normName(candidate.name))
        notes.push(`${subject.title}: "${candidate.name}" → "${choice}"`);
      const file = candidate.statementPdf.split("/").pop() as string;
      const { bytes, retrieved } = await pdf(candidate.statementPdf, `statements/${file}`);
      const pages = await pdfPages(bytes);
      const lines = pages.flatMap((p) => p.lines);
      // The name (bold) and ballot designation head the page; the contest number sits at its foot.
      // The name heads the page in bold; the contest number sits at its foot.
      const body = lines.filter((l, i) => !(i < 2 && l.bold) && !/^\d+$/.test(l.text));
      const text = lines.map((l) => l.text).join("\n");
      await keep(`statements/${file.replace(/\.pdf$/, ".txt")}`, text);
      const reader = blockReader(pages.map((p) => ({ page: p.number, lines: p.lines })));
      const blocks = reader.blocksOf(body);
      if (blocks.length === 0) {
        problems.push(`${subject.title}: ${choice}'s statement is empty`);
        continue;
      }
      const item = itemFor(subject, retrieved.retrieved_at);
      item.candidates ??= [];
      item.candidates.push({
        choice,
        statement: {
          by: choice,
          blocks,
          source: candidate.statementPdf,
          disclaimer: STATEMENT_CAVEAT,
        },
      });
    }
  }
}

// ---------------------------------------------------------------- measures

/** A signature line: "s/ Name", "/s/ Name" or "/s Name". */
const SIGNED = /^\/?s\/?\s+/i;

/** "s/ Tom Arnold" + "Former Interim Costa Mesa Fire Chief" → a signer. */
function signersFrom(lines: Line[]): { body: Line[]; signers: Signer[] } {
  const first = lines.findIndex((l) => SIGNED.test(l.text));
  if (first < 0) return { body: lines, signers: [] };
  const signers: Signer[] = [];
  for (let i = first; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (!SIGNED.test(line.text)) continue;
    const name = line.text.replace(SIGNED, "").trim();
    const next = lines[i + 1];
    const title = next && !SIGNED.test(next.text) ? next.text.trim() : undefined;
    signers.push({ name, ...(title ? { title } : {}) });
  }
  return { body: lines.slice(0, first), signers };
}

/** A sign-off line: short, not a sentence ("/s/", "Dated: July 30, 2026", "City Attorney"). */
function isSignoff(line: Line): boolean {
  return line.text.length < 60 && !/[.;]$/.test(line.text.replace(/\b[A-Z]\.$/, ""));
}

/** "MATTHEW E. RICHARDSON" → "Matthew E. Richardson". */
function titleCaseName(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s\-'’(])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_m, c: string) => `Mc${c.toUpperCase()}`);
}

const HEADER_Y = 660;

async function scrapeMeasure(
  entry: { letter: string; pdf: string },
  subject: Subject,
): Promise<void> {
  const { bytes, retrieved } = await pdf(entry.pdf, `measures/${entry.letter}.pdf`);
  const pages = await pdfPages(bytes);
  const reader = blockReader(
    pages.map((p) => ({ page: p.number, lines: p.lines.filter((l) => l.y < HEADER_Y) })),
  );
  // Below the running header; a lone letter is a decorative drop cap.
  const lines = pages.flatMap((p) =>
    p.lines.filter((l) => l.y < HEADER_Y && !/^\p{Lu}$/u.test(l.text)),
  );
  await keep(`measures/${entry.letter}.txt`, lines.map((l) => `p${l.page} ${l.text}`).join("\n"));
  const item = itemFor(subject, retrieved.retrieved_at);
  const source = (page: number) => `${entry.pdf}#page=${page}`;

  type Section = { kind: string; heading: string; lines: Line[] };
  const sections: Section[] = [{ kind: "question", heading: "", lines: [] }];
  for (const line of lines) {
    const t = line.text;
    let kind: string | undefined;
    if (line.bold && /^What your vote means$/i.test(t)) kind = "means";
    else if (line.bold && /^For and against$/i.test(t)) kind = "for-against";
    else if (line.bold && /^Full Text of /i.test(t)) kind = "text";
    else if (line.bold && /^Impartial Analysis/i.test(t)) kind = "analysis";
    else if (line.bold && /^Rebuttal to (the )?Argument in Favor/i.test(t)) kind = "rebuttal-no";
    else if (line.bold && /^Rebuttal to (the )?Argument Against/i.test(t)) kind = "rebuttal-yes";
    else if (line.bold && /^Argument in Favor/i.test(t)) kind = "argument-yes";
    else if (line.bold && /^Argument Against/i.test(t)) kind = "argument-no";
    else if (/^No (argument|rebuttal)/i.test(t)) kind = "none";
    if (kind) sections.push({ kind, heading: t, lines: [] });
    else (sections[sections.length - 1] as Section).lines.push(line);
  }

  // The question: what follows the measure's name, which is set large.
  const question = sections[0]?.lines.filter((l) => l.size < 13) ?? [];
  if (question.length)
    item.about = { blocks: reader.blocksOf(question), source: source(question[0]?.page ?? 1) };
  else problems.push(`Measure ${entry.letter}: no question`);

  // What a Yes and a No vote mean: two columns under "YES" and "NO"; lines can merge across.
  // The two columns are side by side, so in reading order the No column comes after "For and
  // against"; take the band between the two headings by position instead.
  const meansHead = lines.find((l) => l.bold && /^What your vote means$/i.test(l.text));
  const forAgainst = lines.find((l) => l.bold && /^For and against$/i.test(l.text));
  const means = meansHead
    ? {
        lines: lines.filter(
          (l) =>
            l.page === meansHead.page &&
            l.y < meansHead.y &&
            (!forAgainst || forAgainst.page !== l.page || l.y > forAgainst.y),
        ),
      }
    : undefined;
  if (means) {
    const no = means.lines.find(
      (l) => /^NO$/.test(l.text) || l.runs.some((r) => /^\s*NO\s*$/.test(r.text)),
    );
    const split = no ? (no.runs.find((r) => /NO/.test(r.text))?.x ?? no.x0) - 4 : undefined;
    const yesText: string[] = [];
    const noText: string[] = [];
    for (const line of means.lines) {
      for (const run of line.runs) {
        if (/^\s*(YES|NO)\s*$/.test(run.text)) continue;
        (split !== undefined && run.x >= split ? noText : yesText).push(run.text);
      }
    }
    const para = (parts: string[]): Block[] => {
      const t = parts.join(" ").replace(/\s+/g, " ").trim();
      return t ? [{ type: "p", text: [t] }] : [];
    };
    item.means = {
      Yes: { blocks: para(yesText), source: source(means.lines[0]?.page ?? 1) },
      No: { blocks: para(noText), source: source(means.lines[0]?.page ?? 1) },
    };
    if (!yesText.length || !noText.length)
      problems.push(`Measure ${entry.letter}: a vote meaning is empty`);
  }

  const analysis = sections.find((s) => s.kind === "analysis");
  if (analysis) {
    // Its own heading continues on bold lines ("City of Costa Mesa", "Measure C"). It ends with
    // the publisher's notice ("The above statement is an impartial analysis …"), then a sign-off
    // ("/s/", "Dated: …", a name, a title); without a notice, the sign-off is its last short
    // lines ("Nathalie Adourian" / "City Attorney").
    let body = analysis.lines;
    while (body[0]?.bold && body[0].size <= 9) body = body.slice(1);
    const noticeAt = body.findIndex((l) =>
      /^THE ABOVE STATEMENT IS AN IMPARTIAL ANALYSIS/i.test(l.text),
    );
    const TITLE = /Attorney|Counsel|Clerk|Superintendent/i;
    // The sign-off may come before the notice ("Dated …", "s/ …") or after it ("/s/", a name).
    const end = noticeAt >= 0 ? noticeAt : body.length;
    let signoffAt = end;
    while (signoffAt > 0 && end - signoffAt < 3 && isSignoff(body[signoffAt - 1] as Line)) {
      signoffAt--;
    }
    if (!body.slice(signoffAt, end).some((l) => SIGNED.test(l.text) || TITLE.test(l.text))) {
      signoffAt = end;
    }
    const tail = body.slice(signoffAt);
    const noticeLines =
      noticeAt >= 0 ? body.slice(noticeAt).filter((l, i) => i === 0 || !isSignoff(l)) : [];
    const signoff = tail
      .filter(isSignoff)
      .map((l) =>
        l.text
          .replace(SIGNED, "")
          .replace(/^\/s\/?$/i, "")
          .trim(),
      )
      .filter((t) => t && !/^Dated\b/i.test(t));
    const by = signoff.length
      ? signoff
          .map((t) => (t === t.toUpperCase() ? titleCaseName(t) : t))
          .join(", ")
          .replace(/ for the, /, " for the ")
      : undefined;
    const notice = noticeLines.length ? reader.plain(noticeLines) : undefined;
    const content = body.slice(0, signoffAt);
    item.analysis = {
      title: "Impartial Analysis",
      ...(by ? { by } : {}),
      blocks: reader.blocksOf(content),
      source: source(content[0]?.page ?? analysis.lines[0]?.page ?? 1),
      ...(notice ? { disclaimer: notice } : {}),
    };
  } else problems.push(`Measure ${entry.letter}: no impartial analysis`);

  const args: Argument[] = [];
  for (const section of sections) {
    const m = /^(argument|rebuttal)-(yes|no)$/.exec(section.kind);
    if (!m || section.lines.length === 0) continue;
    const { body, signers } = signersFrom(section.lines);
    args.push({
      side: m[2] === "yes" ? "Yes" : "No",
      rebuttal: m[1] === "rebuttal",
      blocks: reader.blocksOf(body),
      signers,
      source: source(section.lines[0]?.page ?? 1),
    });
  }
  if (args.length) item.arguments = args;

  const text = sections.find((s) => s.kind === "text");
  if (text) {
    const page = lines.find((l) => l.text === text.heading)?.page ?? 1;
    item.documents = [
      {
        title: `Full text of Measure ${entry.letter}`,
        source: entry.pdf,
        mediaType: "application/pdf",
        page,
        sha256: retrieved.sha256,
      },
    ];
  } else problems.push(`Measure ${entry.letter}: no full text`);
}

async function scrapeMeasures(): Promise<void> {
  for (const entry of measureList) {
    const subject = contestSubjects.measures[entry.letter];
    if (!subject || !races.has(subject.title)) {
      problems.push(`Measure ${entry.letter}: no subject in the OC ballot source`);
      continue;
    }
    await scrapeMeasure(entry, subject);
  }
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
        jurisdiction: "us/ca/orange-county",
        title:
          "Orange County: candidate statements and local measures, November 3, 2026 General Election",
      },
      attribution: {
        of: {
          name: "Orange County Registrar of Voters",
          uri: "https://ocvote.gov/",
          kind: "election-authority",
        },
        mode: "scraped",
        retrieved_at: retrieved.at(-1) ?? now(),
        sources: [FILING_LOG_PAGE, MEASURES_PAGE],
      },
    },
    null,
    2,
  )}\n`,
);

const counts = { races: 0, measures: 0, statements: 0, arguments: 0 };
for (const item of items.values()) {
  if (item.subject.kind === "measure") counts.measures++;
  else counts.races++;
  counts.statements += item.candidates?.length ?? 0;
  counts.arguments += item.arguments?.length ?? 0;
}
console.error(`${items.size} items: ${JSON.stringify(counts)}`);
if (process.argv.includes("--verbose") && notes.length)
  console.error(`\nnotes:\n  ${notes.join("\n  ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
