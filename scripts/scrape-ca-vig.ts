#!/usr/bin/env bun
// Build guide/ from California's Official Voter Information Guide (voterguide.sos.ca.gov) for
// one general election: statewide candidates' statements and photos, each proposition's
// summary, "what your vote means", official title and summary, Legislative Analyst's analysis,
// arguments and rebuttals (with their signers) and full text, and each justice's statement of
// qualifications. Subjects come from the CA Secretary of State ballot source in the public
// endorsements catalog, so every item lines up with a race the app already shows.
//
// Pages are cached under evidence/ (with when each was fetched) so a rebuild is reproducible;
// photos, figures and PDFs are mirrored into guide/. Pass --refresh to fetch everything again.
//
//   bun scripts/scrape-ca-vig.ts [--refresh]

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  type BallotRace,
  type Block,
  ELECTION,
  type Inline,
  type Item,
  type Passage,
  ballotSourceUrl,
  fetchOk,
  loadRaces,
  matchChoice,
  normName,
  now,
  slug,
} from "./lib/guide-common";
import {
  type BlockContext,
  type Element,
  type Node,
  attr,
  blocks,
  children,
  clean,
  find,
  findAll,
  hasClass,
  inlines,
  isElement,
  parseDocument,
  plain,
  textOf,
  trimRuns,
} from "./lib/html-blocks";

const BASE = "https://voterguide.sos.ca.gov";
const BALLOT_SOURCE = ballotSourceUrl("ca-secretary-of-state");
const GUIDE = "guide";
const EVIDENCE = "evidence";
const refresh = process.argv.includes("--refresh");

// ---------------------------------------------------------------- fetching and the evidence cache

interface Fetched {
  url: string;
  file: string;
  retrieved_at: string;
}
const evidenceIndexPath = join(EVIDENCE, "index.json");
const evidenceIndex: Record<string, Fetched> = existsSync(evidenceIndexPath)
  ? JSON.parse(await Bun.file(evidenceIndexPath).text())
  : {};

/** A guide page's HTML, from the evidence cache unless --refresh. */
async function page(path: string): Promise<{ doc: Element; url: string; retrieved_at: string }> {
  const url = new URL(path, BASE).href;
  let entry = evidenceIndex[url];
  if (!entry || refresh || !existsSync(join(EVIDENCE, entry.file))) {
    const html = await (await fetchOk(url)).text();
    const file = `${new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "/index.htm")}`;
    await Bun.write(join(EVIDENCE, file), html);
    entry = { url, file, retrieved_at: now() };
    evidenceIndex[url] = entry;
  }
  const html = await Bun.file(join(EVIDENCE, entry.file)).text();
  return { doc: parseDocument(html), url, retrieved_at: entry.retrieved_at };
}

/** Files the guide will publish (relative to guide/) → the URL each was mirrored from. */
const mirrored = new Map<string, string>();

function mirror(url: string, file: string): string {
  mirrored.set(file, url);
  return file;
}

async function downloadMirrors(): Promise<void> {
  for (const [file, url] of mirrored) {
    const path = join(GUIDE, file);
    if (existsSync(path) && !refresh) continue;
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, await (await fetchOk(url)).arrayBuffer());
    console.error(`mirrored ${url}`);
  }
}

// ---------------------------------------------------------------- page helpers

function mainCont(doc: Element): Element {
  const main = find(doc, (e) => attr(e, "id") === "mainCont");
  if (!main) throw new Error("page has no #mainCont");
  return main;
}

const SKIP_CLASSES = [
  "bckToTp",
  "propTitle",
  "relatedLinks",
  "clear",
  "disclaimer",
  "titleSumPrepared",
  "summaryHeadings",
];

/** How the state guide's pages want their passages read: its chrome skipped, images mirrored. */
function context(imageDir: string, baseUrl: string): BlockContext {
  return {
    skipClasses: SKIP_CLASSES,
    image: (src) => {
      if (/arrow-up|no-photo/.test(src)) return undefined;
      const url = new URL(src, baseUrl).href;
      return mirror(url, `${imageDir}/${new URL(url).pathname.split("/").pop()}`);
    },
  };
}

// ---------------------------------------------------------------- the ballot source's subjects

const races = await loadRaces(BALLOT_SOURCE);
function race(title: string): BallotRace {
  const found = races.get(title);
  if (!found) throw new Error(`the ballot source has no race titled ${JSON.stringify(title)}`);
  return found;
}

// ---------------------------------------------------------------- items

const items = new Map<string, Item>();
const problems: string[] = [];

/** Short, stable file names: prop-39, governor-of-california, …-retain-justice-joshua-groban. */
function itemKey(title: string): string {
  const prop = /^California — Proposition (\d+) \(/.exec(title);
  return prop ? `prop-${prop[1]}` : slug(title);
}
function itemFor(r: BallotRace, retrieved_at: string): Item {
  const key = itemKey(r.subject.title);
  let item = items.get(key);
  if (!item) {
    item = { v: 1, subject: r.subject, retrieved_at };
    items.set(key, item);
  }
  if (retrieved_at > item.retrieved_at) item.retrieved_at = retrieved_at;
  return item;
}
function disclaimerOf(doc: Element): string | undefined {
  const p = find(doc, (e) => e.tagName === "p" && hasClass(e, "disclaimer"));
  return p ? clean(textOf(p)) : undefined;
}

// Candidate statements: one page per statewide office (Board of Equalization: all four districts).
const OFFICES: Record<string, string> = {
  "governor-candidate-statements.htm": "Governor of California",
  "lt-governor-candidate-statements.htm": "Lieutenant Governor of California",
  "sos-candidate-statements.htm": "California Secretary of State",
  "controller-candidate-statements.htm": "California Controller",
  "treasurer-candidate-statements.htm": "California Treasurer",
  "attorney-general-candidate-statements.htm": "Attorney General of California",
  "insurance-commissioner-candidate-statements.htm": "California Insurance Commissioner",
  "superintendent-candidate-statements.htm": "California Superintendent of Public Instruction",
  "boe-candidate-statements.htm": "California State Board of Equalization, District {n}",
};

async function scrapeStatements(file: string, titlePattern: string): Promise<void> {
  const { doc, url, retrieved_at } = await page(`/candidates/${file}`);
  const main = find(doc, (e) => attr(e, "role") === "main") ?? mainCont(doc);
  const disclaimer = disclaimerOf(doc);

  // What the office does: the intro paragraph and bullet list above the candidates.
  const intro = mainCont(doc);
  const description = children(intro).filter(
    (e) => (e.tagName === "p" || e.tagName === "ul") && !hasClass(e, "bckToTp"),
  );
  const office = find(intro, (e) => e.tagName === "h2" && /office/i.test(textOf(e)));
  const aboutBlocks: Block[] = [
    ...(office ? [{ type: "p" as const, text: [clean(textOf(office))] }] : []),
    ...blocks(description, context("img/offices", url)),
  ];

  // Candidates in page order; a district heading switches the race (Board of Equalization).
  let current: BallotRace | undefined = titlePattern.includes("{n}")
    ? undefined
    : race(titlePattern);
  const walk = (el: Element) => {
    for (const child of children(el)) {
      if (child.tagName === "h2" && hasClass(child, "district")) {
        const n = /DISTRICT\s+(\d+)/i.exec(textOf(child))?.[1];
        if (n) current = race(titlePattern.replace("{n}", n));
        continue;
      }
      const left = children(child).find((c) => hasClass(c, "grid-30"));
      const right = children(child).find((c) => hasClass(c, "grid-70"));
      if (child.tagName === "div" && hasClass(child, "grid-parent") && left && right) {
        candidate(child, left, right);
        continue;
      }
      walk(child);
    }
  };
  const candidate = (_block: Element, left: Element, right: Element) => {
    if (!current) throw new Error(`${url}: a candidate before any district heading`);
    const heading = find(right, (e) => e.tagName === "h2");
    const name = clean(textOf(heading ?? right).split("|")[0] ?? "");
    const choice = matchChoice(name, current.choices);
    if (!choice) {
      problems.push(
        `${url}: "${name}" is not a candidate for ${current.subject.title} (${current.choices.join(", ")})`,
      );
      return;
    }
    const item = itemFor(current, retrieved_at);
    if (aboutBlocks.length > 0 && !item.about) item.about = { blocks: aboutBlocks, source: url };
    const entry: NonNullable<Item["candidates"]>[number] = { choice };

    const img = find(left, (e) => e.tagName === "img");
    const src = img && attr(img, "src");
    if (src && !src.includes("no-photo")) {
      const photoUrl = new URL(src, url).href;
      const ext = photoUrl.split(".").pop()?.toLowerCase() ?? "jpg";
      entry.photo = {
        file: mirror(
          photoUrl,
          `img/candidates/${slug(current.subject.title)}/${slug(choice)}.${ext}`,
        ),
        alt: choice,
        source: photoUrl,
        credit: "Submitted by the candidate to the California Secretary of State",
      };
    }

    const paragraphs = children(right).filter((e) => e.tagName === "p");
    const last = paragraphs.at(-1);
    const contactP =
      paragraphs.length > 1 && last && find(last, (e) => e.tagName === "br") ? last : undefined;
    const statementPs = paragraphs.filter((p) => p !== contactP);
    const statementBlocks = blocks(statementPs, context("img/candidates", url));
    if (
      statementBlocks.length > 0 &&
      !/^no candidate statement\.?$/i.test(clean(statementPs.map(textOf).join(" ")))
    ) {
      entry.statement = {
        by: choice,
        blocks: statementBlocks,
        source: url,
        ...(disclaimer ? { disclaimer } : {}),
      };
      if (contactP) {
        entry.contact = textOf(contactP).split("\n").map(clean).filter(Boolean);
      }
    }
    // A candidate with neither photo nor statement has nothing to show; the race page says so.
    if (entry.photo || entry.statement) item.candidates = [...(item.candidates ?? []), entry];
  };
  walk(main);
}

// Propositions.
const SIDE_BY_HEADING: [RegExp, { side: string; rebuttal: boolean }][] = [
  [/^REBUTTAL TO ARGUMENT IN FAVOR/i, { side: "No", rebuttal: true }],
  [/^REBUTTAL TO ARGUMENT AGAINST/i, { side: "Yes", rebuttal: true }],
  [/^ARGUMENT IN FAVOR/i, { side: "Yes", rebuttal: false }],
  [/^ARGUMENT AGAINST/i, { side: "No", rebuttal: false }],
];

/** "<strong>Name</strong>, Title<br>Organization<br>…" → signers. */
function signers(p: Element): { name: string; title?: string; organization?: string }[] {
  const out: { name: string; title?: string; organization?: string }[] = [];
  let line: { strong?: string; text: string } = { text: "" };
  const lines: { strong?: string; text: string }[] = [];
  for (const node of p.childNodes) {
    if (isElement(node) && node.tagName === "br") {
      lines.push(line);
      line = { text: "" };
    } else if (isElement(node) && (node.tagName === "strong" || node.tagName === "b")) {
      line.strong = (line.strong ?? "") + textOf(node);
    } else {
      line.text += textOf(node);
    }
  }
  lines.push(line);
  for (const l of lines) {
    const text = clean(l.text).replace(/^,\s*/, "");
    if (l.strong !== undefined) {
      out.push({ name: clean(l.strong).replace(/,$/, ""), ...(text ? { title: text } : {}) });
    } else if (text && out.length > 0) {
      const last = out[out.length - 1] as { organization?: string };
      last.organization = last.organization ? `${last.organization}, ${text}` : text;
    }
  }
  return out;
}

async function scrapeProposition(n: string): Promise<void> {
  const title = [...races.keys()].find((t) => t.startsWith(`California — Proposition ${n} (`));
  if (!title) {
    problems.push(`Proposition ${n} is not in the ballot source`);
    return;
  }
  const r = race(title);
  const imageDir = `img/prop-${n}`;

  // Overview: the summary, what a Yes and a No vote mean, and the full-text PDF.
  {
    const { doc, url, retrieved_at } = await page(`/propositions/${n}/`);
    const item = itemFor(r, retrieved_at);
    const main = mainCont(doc);
    const by = find(main, (e) => hasClass(e, "preparedByPS"));
    const summaryP = find(main, (e) => e.tagName === "p" && hasClass(e, "noIndent"));
    if (summaryP) {
      item.about = {
        ...(by ? { by: clean(textOf(by)) } : {}),
        blocks: blocks([summaryP], context(imageDir, url)),
        source: url,
      };
    }
    const meansHeading = find(
      main,
      (e) => e.tagName === "h3" && /WHAT YOUR VOTE MEANS/i.test(textOf(e)),
    );
    const grid = meansHeading && main.childNodes.length ? nextElement(meansHeading) : undefined;
    for (const p of grid ? findAll(grid, (e) => e.tagName === "p") : []) {
      const label = find(p, (e) => hasClass(e, "yesNoProCon"));
      const side = label ? clean(textOf(label)) : "";
      const choice = side === "YES" ? "Yes" : side === "NO" ? "No" : undefined;
      if (!choice || !label) continue;
      const rest = trimRuns(inlines(p.childNodes.filter((c) => c !== label)));
      item.means = {
        ...item.means,
        [choice]: { blocks: [{ type: "p", text: rest }], source: url },
      };
    }
    const pdf = findAll(doc, (e) => e.tagName === "a").find((a) =>
      /text-proposed-laws?\.pdf$/i.test(attr(a, "href") ?? ""),
    );
    if (pdf) {
      const pdfUrl = new URL(attr(pdf, "href") as string, url).href;
      item.documents = [
        {
          title: `Text of Proposition ${n}`,
          file: mirror(pdfUrl, `pdf/prop-${n}-text.pdf`),
          source: pdfUrl,
          mediaType: "application/pdf",
        },
      ];
    } else {
      problems.push(`Proposition ${n}: no link to the text of the proposed law`);
    }
  }

  // Official title and summary, by the Attorney General.
  {
    const { doc, url, retrieved_at } = await page(`/propositions/${n}/title-summary.htm`);
    const item = itemFor(r, retrieved_at);
    const content = blocks(mainCont(doc).childNodes, context(imageDir, url));
    item.summary = { by: "Attorney General", blocks: content, source: url };
  }

  // Analysis by the Legislative Analyst.
  {
    const { doc, url, retrieved_at } = await page(`/propositions/${n}/analysis.htm`);
    const item = itemFor(r, retrieved_at);
    const content = blocks(mainCont(doc).childNodes, context(imageDir, url)).filter(
      (b) =>
        !(b.type === "h" && /^ANALYSIS BY THE LEGISLATIVE ANALYST$/i.test(plain(b.text).trim())),
    );
    item.analysis = { by: "Legislative Analyst", blocks: content, source: url };
  }

  // Arguments and rebuttals.
  {
    const { doc, url, retrieved_at } = await page(`/propositions/${n}/arguments-rebuttals.htm`);
    const item = itemFor(r, retrieved_at);
    const disclaimer = disclaimerOf(doc);
    const out: NonNullable<Item["arguments"]> = [];
    for (const column of findAll(doc, (e) => hasClass(e, "argumentsRebuttals"))) {
      let section: { side: string; rebuttal: boolean; nodes: Element[] } | undefined;
      const close = () => {
        if (!section) return;
        const ps = section.nodes;
        // The signers close the section: a paragraph that opens with a name in bold.
        const lastP = ps.at(-1);
        const signerP = lastP && startsWithStrong(lastP) ? lastP : undefined;
        const body = ps.filter((p) => p !== signerP);
        const text = clean(body.map(textOf).join(" "));
        if (body.length > 0 && !/^NO (ARGUMENT|REBUTTAL) .* WAS SUBMITTED\.?$/i.test(text)) {
          out.push({
            side: section.side,
            rebuttal: section.rebuttal,
            blocks: blocks(body, context(imageDir, url)),
            signers: signerP ? signers(signerP) : [],
            source: url,
            ...(disclaimer ? { disclaimer } : {}),
          });
          if (!signerP) problems.push(`${url}: an argument with no signers`);
        }
        section = undefined;
      };
      for (const child of children(column)) {
        if (child.tagName === "h3") {
          close();
          const heading = clean(textOf(child));
          const match = SIDE_BY_HEADING.find(([re]) => re.test(heading));
          if (!match) problems.push(`${url}: unknown heading "${heading}"`);
          else section = { ...match[1], nodes: [] };
        } else if (section && child.tagName === "p") {
          section.nodes.push(child);
        }
      }
      close();
    }
    if (out.length > 0) item.arguments = out;
  }
}

function startsWithStrong(p: Element): boolean {
  const first = p.childNodes.find((c) => !(c.nodeName === "#text" && !clean(textOf(c))));
  return (
    first !== undefined && isElement(first) && (first.tagName === "strong" || first.tagName === "b")
  );
}

function nextElement(el: Element): Element | undefined {
  const siblings = el.parentNode ? (el.parentNode as Element).childNodes.filter(isElement) : [];
  return siblings[siblings.indexOf(el) + 1];
}

// Justices up for retention: the Supreme Court's statements of qualifications, and the Courts of
// Appeal's links to each justice's official biography.
const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];

function retentionRace(court: string, name: string): BallotRace | undefined {
  const want = normName(name);
  const prefix = `${court} — Retain Justice `;
  const titles = [...races.keys()].filter((t) => t.startsWith(prefix));
  const exact = titles.find((t) => normName(t.slice(prefix.length)) === want);
  if (exact) return race(exact);
  const loose = titles.filter((t) => matchChoice(name, [t.slice(prefix.length)]));
  return loose.length === 1 ? race(loose[0] as string) : undefined;
}

async function scrapeSupremeCourt(): Promise<void> {
  const { doc, url, retrieved_at } = await page("/justices/supreme-court-justices/index.htm");
  const main = mainCont(doc);
  const groups: Element[][] = [];
  let inStatements = false;
  for (const child of children(main)) {
    if (child.tagName === "h2" && /Statement of Qualifications/i.test(textOf(child))) {
      inStatements = true;
      groups.push([]);
    } else if (inStatements && child.tagName === "hr") {
      groups.push([]);
    } else if (inStatements && child.tagName !== "h2") {
      groups.at(-1)?.push(child);
    }
  }
  for (const group of groups) {
    const first = group.find((e) => e.tagName === "p" && find(e, (s) => s.tagName === "strong"));
    if (!first) continue;
    const strong = find(first, (s) => s.tagName === "strong") as Element;
    const name = clean(textOf(strong)).replace(/,$/, "");
    const r = retentionRace("California Supreme Court", name);
    if (!r) {
      problems.push(`${url}: no Supreme Court retention race for "${name}"`);
      continue;
    }
    const item = itemFor(r, retrieved_at);
    item.about = {
      by: name,
      blocks: blocks(group, context("img/justices", url)),
      source: url,
    };
  }
}

async function scrapeCourtOfAppeal(district: number): Promise<void> {
  const { doc, url, retrieved_at } = await page(
    `/justices/courts-of-appeal/district${district}.htm`,
  );
  const main = mainCont(doc);
  const court = `California Court of Appeal, ${ORDINALS[district - 1]} District`;
  const sessions = children(main).find((e) => e.tagName === "p");
  let division = "";
  for (const child of children(main)) {
    if (child.tagName === "h2") division = clean(textOf(child));
    if (child.tagName !== "ul") continue;
    for (const li of findAll(child, (e) => e.tagName === "li")) {
      // A justice with a biography links to it; one without is printed in bold, with a note.
      const a = find(li, (e) => e.tagName === "a");
      const label = a ?? find(li, (e) => e.tagName === "strong");
      if (!label) continue;
      const note = a ? undefined : find(li, (e) => hasClass(e, "noBioEmph"));
      const [name, role] = clean(textOf(label)).split(/,\s*/);
      const r = name ? retentionRace(court, name) : undefined;
      if (!r || !name) {
        problems.push(`${url}: no ${court} retention race for "${name}"`);
        continue;
      }
      const item = itemFor(r, retrieved_at);
      const line = [role, division, `${court}.`].filter(Boolean).join(", ");
      item.about = {
        blocks: [
          { type: "p", text: [line] },
          ...(note ? [{ type: "p" as const, text: [clean(textOf(note))] }] : []),
          ...(sessions ? blocks([sessions], context("img/justices", url)) : []),
        ],
        source: (a && attr(a, "href")) || url,
      };
    }
  }
}

// ---------------------------------------------------------------- run

for (const [file, title] of Object.entries(OFFICES)) await scrapeStatements(file, title);

const propIndex = await page("/propositions/");
const props = findAll(mainCont(propIndex.doc), (e) => e.tagName === "a")
  .map((a) => /^\/propositions\/(\d+)\/$/.exec(attr(a, "href") ?? "")?.[1])
  .filter((n): n is string => n !== undefined);
for (const n of props) await scrapeProposition(n);

await scrapeSupremeCourt();
for (let d = 1; d <= ORDINALS.length; d++) await scrapeCourtOfAppeal(d);

for (const r of races.values()) {
  if (/Retain Justice/.test(r.subject.title) && !items.has(itemKey(r.subject.title))) {
    problems.push(`no guide material for ${r.subject.title}`);
  }
}

await downloadMirrors();

// Write items fresh, and drop mirrored files nothing points at any more.
rmSync(join(GUIDE, "items"), { recursive: true, force: true });
for (const [key, item] of [...items].sort(([a], [b]) => a.localeCompare(b))) {
  await Bun.write(join(GUIDE, "items", `${key}.json`), `${JSON.stringify(item, null, 2)}\n`);
}
const walkFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory()
          ? walkFiles(full)
          : [relative(GUIDE, full).split(sep).join("/")];
      })
    : [];
for (const file of [...walkFiles(join(GUIDE, "img")), ...walkFiles(join(GUIDE, "pdf"))]) {
  if (!mirrored.has(file)) {
    rmSync(join(GUIDE, file));
    console.error(`removed ${file} (no longer referenced)`);
  }
}

const retrieved = Object.values(evidenceIndex)
  .map((e) => e.retrieved_at)
  .sort();
await Bun.write(
  join(GUIDE, "guide.json"),
  `${JSON.stringify(
    {
      context: {
        election: ELECTION,
        jurisdiction: "us/ca",
        title: "California Official Voter Information Guide: November 3, 2026 General Election",
      },
      attribution: {
        of: {
          name: "California Secretary of State",
          uri: "https://www.sos.ca.gov/",
          kind: "election-authority",
        },
        mode: "scraped",
        retrieved_at: retrieved.at(-1) ?? now(),
        sources: [`${BASE}/`],
      },
    },
    null,
    2,
  )}\n`,
);
await Bun.write(evidenceIndexPath, `${JSON.stringify(evidenceIndex, null, 2)}\n`);

const counts = { races: 0, measures: 0, statements: 0, photos: 0, arguments: 0 };
for (const item of items.values()) {
  if (item.candidates || item.subject.kind === "race") counts.races++;
  if (item.arguments || item.summary) counts.measures++;
  counts.statements += item.candidates?.filter((c) => c.statement).length ?? 0;
  counts.photos += item.candidates?.filter((c) => c.photo).length ?? 0;
  counts.arguments += item.arguments?.length ?? 0;
}
console.error(`${items.size} items: ${JSON.stringify(counts)}; ${mirrored.size} mirrored files`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
