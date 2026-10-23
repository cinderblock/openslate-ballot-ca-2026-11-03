// What the county pamphlet scrapers (scripts/scrape-sd.ts, scripts/scrape-alameda.ts) share once
// a pamphlet is laid out (scripts/lib/pdf-layout.ts): items keyed by subject and written out as a
// guide; candidates' printed names matched to a race on the ballot; a measure's pages split at
// its headings into question, analysis, arguments and full text.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type BallotRace,
  type Item,
  type Passage,
  type Subject,
  matchChoice,
  normName,
  slug,
} from "./guide-common";
import { blockReader } from "./pdf-blocks";
import type { Line } from "./pdf-layout";

// ---------------------------------------------------------------- items and the guide

/** A guide's items, one per subject; a measure's file name leaves out its short title. */
export function itemStore() {
  const items = new Map<string, Item>();
  function itemFor(subject: Subject, retrieved_at: string): Item {
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
  return { items, itemFor };
}

/** Writes `<out>/items/*.json` (removing any no longer produced) and `<out>/guide.json`. */
export async function writeGuide(
  out: string,
  items: Map<string, Item>,
  guide: Record<string, unknown>,
): Promise<void> {
  mkdirSync(join(out, "items"), { recursive: true });
  const written = new Set<string>();
  for (const [key, item] of items) {
    const file = `${key}.json`;
    written.add(file);
    await Bun.write(join(out, "items", file), `${JSON.stringify(item, null, 2)}\n`);
  }
  for (const file of readdirSync(join(out, "items"))) {
    if (!written.has(file)) {
      rmSync(join(out, "items", file));
      console.error(`removed items/${file} (no longer produced)`);
    }
  }
  await Bun.write(join(out, "guide.json"), `${JSON.stringify(guide, null, 2)}\n`);
}

/** Items, races, measures, statements and arguments, for a scraper's last line. */
export function countItems(items: Map<string, Item>) {
  const counts = { races: 0, measures: 0, statements: 0, photos: 0, arguments: 0 };
  for (const item of items.values()) {
    if (item.subject.kind === "measure") counts.measures++;
    else counts.races++;
    counts.statements += item.candidates?.filter((c) => c.statement).length ?? 0;
    counts.photos += item.candidates?.filter((c) => c.photo).length ?? 0;
    counts.arguments += item.arguments?.length ?? 0;
  }
  return counts;
}

// ---------------------------------------------------------------- text

/** One reader per section: column edges are measured from the section's own pages. */
export function readerFor(lines: Line[]) {
  const pages = [...new Set(lines.map((l) => l.page))];
  return blockReader(pages.map((page) => ({ page, lines: lines.filter((l) => l.page === page) })));
}

/**
 * A bullet printed apart from its item's text (its own run on the same baseline), or in a symbol
 * font that comes out as some other character: one line starting "• ", which the block reader
 * reads as a list item.
 */
export function joinBullets(lines: Line[], symbols = /^[•●]$/): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const lead = line.runs[0];
    if (
      prev &&
      symbols.test(prev.text) &&
      prev.page === line.page &&
      Math.abs(prev.y - line.y) < 2
    ) {
      out[out.length - 1] = {
        ...line,
        x0: prev.x0,
        text: `• ${line.text}`,
        runs: [{ ...(prev.runs[0] ?? lead), text: "• " } as Line["runs"][number], ...line.runs],
      };
    } else if (lead && symbols.test(lead.text.trim()) && line.runs.length > 1) {
      out.push({
        ...line,
        text: `• ${line.text.slice(lead.text.length).trim()}`,
        runs: [{ ...lead, text: "• " }, ...line.runs.slice(1)],
      });
    } else out.push(line);
  }
  return out;
}

/** "MIKE O’DEANE" → "Mike O’Deane". */
export function nameCase(name: string): string {
  return name
    .split(/(\s+)/)
    .map((w) =>
      // Initials, generations and credentials ("RN", "MD") stay as printed.
      /^([A-Z]\.)+,?$|^(II|III|IV|RN|MD|DDS|CPA|ESQ)\.?,?$/.test(w)
        ? w
        : w
            .toLowerCase()
            .replace(/(^|[-'’("“])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase())
            .replace(/^Mc(\p{L})/u, (_m, c: string) => `Mc${c.toUpperCase()}`),
    )
    .join("");
}

/** "COUNTY COUNSEL" → "County Counsel"; "CITY ATTORNEY’S" → "City Attorney’s". */
export const wordCase = (text: string) =>
  text.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());

// ---------------------------------------------------------------- races

/** Congress and Legislature districts, in the Secretary of State's titles. */
export function stateDistrict(
  header: string,
  races: Map<string, BallotRace>,
): BallotRace | undefined {
  const n = /(\d+)(?:st|nd|rd|th)? (?:Congressional |Assembly |Senate )?District/i.exec(
    header,
  )?.[1];
  if (!n) return undefined;
  const title = /UNITED STATES REPRESENTATIVE|CONGRESSIONAL/i.test(header)
    ? `US House of Representatives, California District ${n}`
    : /STATE SENAT/i.test(header)
      ? `California State Senate, District ${n}`
      : /STATE ASSEMBLY/i.test(header)
        ? `California State Assembly, District ${n}`
        : undefined;
  return title ? races.get(title) : undefined;
}

/**
 * How well a race's title matches a contest heading: the heading's words it shares, seat
 * numbers included ("District 6", not "District 4").
 */
export function headingOverlap(title: string, heading: string): number {
  const words = new Set(normName(heading).split(/[^a-z0-9]+/));
  return normName(title)
    .split(/[^a-z0-9]+/)
    .filter((w) => (w.length > 2 || /^\d+$/.test(w)) && words.has(w)).length;
}

/**
 * The race whose candidates a section prints: the Secretary of State's for a district; else the
 * local race naming them all, the one whose title is closest to the heading if several do.
 */
export function raceFor(
  printed: string[],
  header: string,
  races: Map<string, BallotRace>,
): { race: BallotRace } | { problem: string } {
  const district = stateDistrict(header, races);
  if (district) return { race: district };
  const fits = [...races.values()].filter((r) =>
    printed.every((p) => matchChoice(p, r.choices) !== undefined),
  );
  const score = (r: BallotRace) => headingOverlap(r.subject.title, header);
  const best = Math.max(...fits.map(score));
  const closest = fits.filter((r) => score(r) === best);
  if (closest.length === 1 && closest[0]) return { race: closest[0] };
  if (closest.length > 1) {
    return {
      problem: `"${header}": ${printed.join(", ")} fit ${closest.map((r) => r.subject.title).join(" | ")}`,
    };
  }
  return { problem: `"${header}": no race has ${printed.join(", ")}` };
}

// ---------------------------------------------------------------- measures

export type PartKind =
  | "question"
  | "analysis"
  | "tax"
  | "argument-yes"
  | "argument-no"
  | "rebuttal-yes"
  | "rebuttal-no"
  | "text"
  | "none";
export interface Part {
  kind: PartKind;
  heading: string;
  lines: Line[];
}
const HEADINGS: [RegExp, PartKind][] = [
  [/IMPARTIAL ANALYSIS/, "analysis"],
  [/^REBUTTAL TO (THE )?ARGUMENTS? IN FAVOR/, "rebuttal-no"],
  [/^REBUTTAL TO (THE )?ARGUMENTS? AGAINST/, "rebuttal-yes"],
  [/^ARGUMENTS? IN FAVOR/, "argument-yes"],
  [/^ARGUMENTS? AGAINST/, "argument-no"],
  [/^FULL TEXT OF/, "text"],
  [/^TAX RATE STATEMENT/, "tax"],
  // "No Argument Against Measure K was filed…", in capitals or not.
  [/^NO (ARGUMENT|REBUTTAL)/i, "none"],
];

/**
 * A measure's lines split at its headings (bold capitals): the ballot's question first, then the
 * analysis, any tax rate statement, the arguments and rebuttals, and the full text. A heading's
 * second line ("REBUTTAL TO THE ARGUMENT IN FAVOR OF" / "MEASURE A") joins it; "(CONTINUED)"
 * carries on the part already open.
 */
export function measureParts(lines: Line[]): Part[] {
  const parts: Part[] = [{ kind: "question", heading: "", lines: [] }];
  let current = parts[0] as Part;
  let headingContinues = false;
  for (const line of lines) {
    const t = line.text;
    const heading = line.bold && line.size >= 9.5 && t === t.toUpperCase();
    const kind = HEADINGS.find(([re]) => re.test(t) && (heading || /^no /i.test(t)))?.[1];
    if (kind) {
      headingContinues = true;
      if (!(kind === current.kind && /\(CONTINUED\)$/.test(t))) {
        current = { kind, heading: t, lines: [] };
        parts.push(current);
      }
      continue;
    }
    if (headingContinues && heading) {
      current.heading += ` ${t}`;
      continue;
    }
    headingContinues = false;
    current.lines.push(line);
  }
  return parts;
}

/**
 * What a yes and a no vote mean, where the analysis closes with them ("A “yes” vote is…"): the
 * analysis without them, and the two passages.
 */
export function votesMean(
  lines: Line[],
  reader: ReturnType<typeof blockReader>,
  source: string,
): { content: Line[]; means?: Record<string, Passage> } {
  const yesAt = lines.findIndex((l) => /^A [“"]yes[”"] vote/i.test(l.text));
  const noAt = lines.findIndex((l) => /^A [“"]no[”"] vote/i.test(l.text));
  if (!(yesAt > 0 && noAt > yesAt)) return { content: lines };
  const no = lines.slice(noAt);
  const noEnd = no.findIndex((l, i) => i > 0 && !reader.wrapsFrom(no[i - 1] as Line, l));
  return {
    content: [...lines.slice(0, yesAt), ...(noEnd > 0 ? no.slice(noEnd) : [])],
    means: {
      Yes: { blocks: reader.blocksOf(lines.slice(yesAt, noAt)), source },
      No: { blocks: reader.blocksOf(noEnd > 0 ? no.slice(0, noEnd) : no), source },
    },
  };
}
