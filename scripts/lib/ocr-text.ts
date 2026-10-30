// Turns what Windows OCR read from a filed scan (scripts/ocr-smc.ts) into guide text: the body of
// an analysis or argument as paragraphs, and the signers where the filing prints them typed.
//
// Nothing here corrects what the OCR read. It only decides which of a filing's pages are the
// text (the county's submission and signature forms are not), drops the county's receiving
// stamp and the line numbers in a margin, and keeps a signer only when the form was typed: a
// name written by hand reads as noise, so it isn't a name.

import type { Block, Signer } from "./guide-common";

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrPage {
  page: number;
  width: number;
  height: number;
  lines: OcrLine[];
}
export interface Ocr {
  engine: string;
  scale: number;
  pages: OcrPage[];
}

/** What the county's own printed forms say, shown with the text: the reading is a machine's. */
export const MACHINE_READ =
  "Read from a scan by machine (Windows OCR) and not corrected: errors are likely, especially in names and numbers. The original scan is linked from this page.";

export type PageKind = "submission" | "signers" | "authorization" | "text";

const flat = (page: OcrPage) => page.lines.map((line) => line.text).join(" ");

export function pageKind(page: OcrPage): PageKind {
  const text = flat(page);
  // The county's forms have fixed wording; a scan can lose a heading but not all of it.
  if (
    /Argument Signers Form|signatures shall appear with any argument|Type information clearly|alternate signers attached/i.test(
      text,
    )
  )
    return "signers";
  if (
    /Authorization Form for Change in Signers|hereby authorize\(s\) the following individual/i.test(
      text,
    )
  )
    return "authorization";
  if (
    /Argument Submission Form|Ballot Measure (Primary|Rebuttal) Argument|argument will not be accepted unless accompanied by this completed|Word count limit for (Primary|Rebuttal)/i.test(
      text,
    )
  )
    return "submission";
  return "text";
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) > 0.8;
}

// ---------------------------------------------------------------- the typed signer list

/** "1. Chris Clements: Police Captain (retired)": a filing that types out its handwritten signers. */
const TYPED_SIGNER = /^\s*\d\s*[.)]\s*([^:]{3,60}?)\s*:\s+(\S.*)$/;
const typedSigners = (page: OcrPage) => page.lines.filter((line) => TYPED_SIGNER.test(line.text));

function isTypedList(page: OcrPage): boolean {
  return pageKind(page) === "text" && typedSigners(page).length >= 2;
}

// ---------------------------------------------------------------- body text

/** The county's receiving stamp and the scan's own marks, which aren't part of the text. */
const STAMP =
  /^(received|filed\b.*|aug\b.*|.*\bcity clerk.*|.*clerk'?s office.*|city of [a-z ]+|.*elections? (division|officer).*|.*\bdeput.*|.*\bfficer\b.*|.*(starts|ends) here\]?)$/i;

function cleanLines(page: OcrPage): OcrLine[] {
  const long = page.lines.filter((line) => line.text.length >= 40);
  const edge = long.map((line) => line.x + line.w).sort((a, b) => a - b)[
    Math.floor(long.length * 0.9)
  ];
  return page.lines
    .filter((line) => {
      // Numbers and marks in the right margin.
      if (edge && line.text.length <= 5 && line.x > edge - 30) return false;
      // The stamp, at the top or bottom of the page.
      const nearEdge = line.y < page.height * 0.12 || line.y > page.height * 0.75;
      if (nearEdge && line.text.length < 45 && STAMP.test(line.text.trim())) return false;
      return true;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Lines on one row of the page, read left to right as one line. The OCR splits a line at a
 * gap (a blank where a handwritten letter goes), and the halves can differ by a few pixels
 * in height, which a sort by height alone would put in the wrong order.
 */
function rows(lines: OcrLine[]): OcrLine[] {
  const heights = lines.map((line) => line.h).sort((a, b) => a - b);
  const tolerance = (heights[Math.floor(heights.length / 2)] ?? 30) * 0.6;
  const out: OcrLine[][] = [];
  for (const line of lines) {
    const row = out.at(-1);
    const top = row?.[0]?.y ?? Number.NEGATIVE_INFINITY;
    if (row && Math.abs(line.y - top) <= tolerance) row.push(line);
    else out.push([line]);
  }
  return out.map((row) => {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const first = sorted[0] as OcrLine;
    return {
      text: sorted.map((line) => line.text.trim()).join(" "),
      x: first.x,
      y: Math.min(...sorted.map((line) => line.y)),
      w: Math.max(...sorted.map((line) => line.x + line.w)) - first.x,
      h: Math.max(...sorted.map((line) => line.h)),
    };
  });
}

/** A page's lines as paragraphs: a gap larger than the usual line spacing starts a new one. */
function paragraphs(lines: OcrLine[]): string[] {
  const gaps = lines
    .slice(1)
    .map((line, i) => line.y - (lines[i]?.y ?? 0))
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const out: string[] = [];
  let current: string[] = [];
  lines.forEach((line, i) => {
    const gap = i > 0 ? line.y - (lines[i - 1]?.y ?? 0) : 0;
    if (current.length && pitch && gap > pitch * 1.45) {
      out.push(current.join(" "));
      current = [];
    }
    current.push(line.text.trim());
  });
  if (current.length) out.push(current.join(" "));
  return out;
}

/** "A filing's heading", which the guide shows as the argument's own label. */
const HEADING =
  /^(rebuttal to )?(the )?(primary )?argument (in favor|against)( of| to)?( the)?( measure)?( [A-Z]{1,3}\b)?[ .:_-]*$|^rebuttal to the argument (in favor|against) measure [A-Z]{1,3}$/i;

/** The county attorney's word count after a paragraph or at the end: "[237 words]", "[291". */
const COUNT = /\s*\[\s*\d{1,4}\s*(words\s*\]|[\]1Il|)])?\s*$/i;

/**
 * The text of a filing as paragraph blocks: the pages that aren't the county's forms, without
 * a page that repeats an earlier one (some are filed twice, with and without the stamp).
 */
export function textBlocks(ocr: Ocr): Block[] {
  const kept: OcrPage[] = [];
  for (const page of ocr.pages) {
    if (pageKind(page) !== "text" || isTypedList(page)) continue;
    if (flat(page).length < 120) continue;
    if (kept.some((earlier) => similar(flat(earlier), flat(page)))) continue;
    kept.push(page);
  }
  const blocks: Block[] = [];
  for (const page of kept) {
    for (const [i, paragraph] of paragraphs(rows(cleanLines(page))).entries()) {
      const text = paragraph.replace(COUNT, "").trim();
      // A heading the scan carries as a file-name-like line ("Rebuttal-Argument-in-Favor-of-…").
      const filename = /(?:[^\s-]+-){3,}/.test(text) && text.split(/\s+/).length <= 8;
      if (!text || (i === 0 && (HEADING.test(text) || filename))) continue;
      blocks.push({ type: "p", text: [text] });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------- signers

const FIELD = /^(\d\s*\.\s*)?(name|phone|address|signature|title|email|date|pronouns)\b/i;
/** "Name:", "2. Name:", and the OCR's "Nam e:" and "ame:"; a typed name may follow on the line. */
const NAME_LABEL = /^(?:\d\s*[.,]?\s*)?(?:na\s?m\s?e|ame)\s*(?:[:;]\s*(.*))?$/i;

/** Form labels the OCR ran into a typed value: "Rick Bonilla Phon Sig", "(Councilmember He/His:)". */
const LABELS =
  /\s+(phon\w*|sig\w*|addres\w*|email|title|date|name|pronouns|he\s*\/\s*his|she\s*\/\s*her|they\s*\/\s*them)\b.*$/i;
const unlabeled = (text: string) => text.replace(LABELS, "").trim();

/** A printed personal name: two to five words, letters and the usual marks, no digits. */
function plausibleName(text: string): boolean {
  const tokens = text.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 5) return false;
  // Noise reads as short capitalized scraps ("Ph Ad Si"); a name has a word of some length.
  if (!tokens.some((token) => token.replace(/[^\p{L}]/gu, "").length >= 4)) return false;
  return tokens.every(
    (token) =>
      // "Chris", "Cwirko-Godycki", "O'Connell", "McDonald", "OConnell" (the OCR drops marks), "W.A.".
      /^\p{Lu}\p{Ll}+(?:[-'’]\p{Lu}\p{Ll}+)*$/u.test(token) ||
      /^(?:Mc|Mac|O)\p{Lu}\p{Ll}+$/u.test(token) ||
      /^(?:\p{Lu}\.)+$/u.test(token),
  );
}

/** A printed title: words, not a fragment that stops short. */
function plausibleTitle(text: string): boolean {
  if (text.length < 3 || text.length > 140) return false;
  if (/[|{}[\]~_<>;]/.test(text)) return false;
  // A word the OCR broke ("Lea ue", "Ph sical") leaves one- and two-letter scraps.
  const SMALL = /^(of|in|to|at|on|by|or|as|an|a|vp|ii|iii|jr|sr|dr|mr|ms|ca|us|pm|am|no)$/i;
  for (const token of text.split(/\s+/)) {
    const letters = token.replace(/[^\p{L}]/gu, "");
    if (letters && letters.length <= 2 && !SMALL.test(letters) && letters !== letters.toUpperCase())
      return false;
  }
  if (/(^|\s)(of|for|the|and|to|at|in|on|a|an|-|,)$/i.test(text)) return false;
  return (text.match(/[A-Za-z]/g)?.length ?? 0) / text.length > 0.7;
}

/**
 * Signers from a "Signers Form" page: each "Name:" label has what was typed under it, and the
 * "Title:" label beside it, in the right-hand column, has the title. A signer whose name
 * isn't a plausible printed name is dropped, so handwriting never becomes a person.
 */
function formSigners(page: OcrPage): Signer[] {
  const lines = [...page.lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const titleLabels = lines.filter((line) => /^title\s*[:;]?$/i.test(line.text.trim()));
  const split = titleLabels.length
    ? Math.min(...titleLabels.map((line) => line.x)) - 60
    : page.width / 2;
  const left = lines.filter((line) => line.x < split);
  const right = lines.filter((line) => line.x >= split && line.x < page.width * 0.8);
  const signers: Signer[] = [];
  for (const [i, label] of left.entries()) {
    const labelText = label.text.trim();
    const match = NAME_LABEL.exec(labelText);
    if (!match) continue;
    const next = left
      .slice(i + 1)
      .find((line) => FIELD.test(line.text.trim()) && line.y > label.y + 25);
    const bottom = next?.y ?? label.y + 120;
    // What's typed beside or under the label, up to the next label (Phone:).
    const typed = [
      match[1] ?? "",
      ...left
        .filter((line) => line !== label && line.y >= label.y - 20 && line.y < bottom - 15)
        .filter((line) => !FIELD.test(line.text.trim()))
        .map((line) => line.text),
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const name = unlabeled(typed);
    if (!plausibleName(name)) continue;
    const titleLabel = titleLabels.find((t) => Math.abs(t.y - label.y) < 60);
    let title: string | undefined;
    if (titleLabel) {
      const below = right.find(
        (line) => line.y > titleLabel.y + 25 && /^(email|date)\b/i.test(line.text),
      );
      const text = right
        .filter(
          (line) =>
            line !== titleLabel &&
            line.y >= titleLabel.y - 20 &&
            line.y < (below?.y ?? titleLabel.y + 100) - 15 &&
            !FIELD.test(line.text.trim()),
        )
        .map((line) => line.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (plausibleTitle(unlabeled(text))) title = unlabeled(text);
    }
    signers.push({ name, ...(title ? { title } : {}) });
  }
  return signers;
}

/** The signers a filing prints typed: on its signature forms, or on a page that lists them. */
export function signersOf(ocr: Ocr): Signer[] {
  const signers: Signer[] = [];
  const add = (signer: Signer) => {
    if (!signers.some((s) => s.name === signer.name)) signers.push(signer);
  };
  for (const page of ocr.pages) {
    if (pageKind(page) === "signers") for (const signer of formSigners(page)) add(signer);
    else if (isTypedList(page))
      for (const line of typedSigners(page)) {
        const m = TYPED_SIGNER.exec(line.text);
        if (m?.[1] && plausibleName(m[1].trim())) add({ name: m[1].trim(), title: m[2]?.trim() });
      }
  }
  return signers.slice(0, 5);
}
