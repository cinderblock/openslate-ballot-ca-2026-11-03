// Text lines from a PDF in reading order, with the font facts a parser needs (size, bold,
// italic). Voter pamphlets are laid out in two columns with full-width headings between them,
// and pdf.js returns text runs in drawing order, not reading order: this module groups runs
// into lines, sorts each page into bands split by full-width lines, and reads a band's left
// column before its right.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface Run {
  text: string;
  font: string;
  bold: boolean;
  italic: boolean;
  size: number;
  x: number;
  width: number;
}

export interface Line {
  /** 1-based page number in the PDF. */
  page: number;
  x0: number;
  x1: number;
  /** Baseline, in PDF units from the bottom of the page. */
  y: number;
  /** Largest run height on the line, roughly the font size. */
  size: number;
  bold: boolean;
  runs: Run[];
  text: string;
  column: "full" | "left" | "right";
}

export interface Page {
  number: number;
  width: number;
  height: number;
  /** Lines in reading order. */
  lines: Line[];
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/** Runs closer than this vertically share a line. */
const SAME_LINE = 2;
/** A horizontal gap wider than this splits a line (it crosses the gutter between columns). */
const GUTTER = 12;

export async function pdfPages(bytes: Uint8Array): Promise<Page[]> {
  // pdf.js takes ownership of the buffer it is given; hand it a copy.
  const task = getDocument({
    data: new Uint8Array(bytes),
    fontExtraProperties: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: Page[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Fonts are only resolved once the page's operators have been loaded.
    await page.getOperatorList();
    const fontNames = new Map<string, string>();
    const fontOf = (id: string): string => {
      const known = fontNames.get(id);
      if (known !== undefined) return known;
      const font = page.commonObjs.has(id) ? (page.commonObjs.get(id) as { name?: string }) : {};
      const name = font.name ?? "";
      fontNames.set(id, name);
      return name;
    };

    const runs: (Run & { y: number })[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as TextItem;
      if (item.str === "" || item.height === 0) continue;
      const font = fontOf(item.fontName);
      runs.push({
        text: item.str,
        font,
        bold: /Black|Bold|Heavy|Semibold|Demi/i.test(font),
        italic: /Italic|Oblique/i.test(font),
        size: item.height,
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        width: item.width,
      });
    }

    pages.push({ number: n, width, height, lines: readingOrder(toLines(runs, n, width), width) });
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

function toLines(runs: (Run & { y: number })[], page: number, width: number): Line[] {
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: (Run & { y: number })[][] = [];
  for (const run of runs) {
    const row = rows.find((r) => Math.abs((r[0]?.y ?? 0) - run.y) < SAME_LINE);
    if (row) row.push(run);
    else rows.push([run]);
  }
  const lines: Line[] = [];
  const mid = width / 2;
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let current: (Run & { y: number })[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const first = current[0] as Run & { y: number };
      const last = current[current.length - 1] as Run & { y: number };
      const x0 = first.x;
      const x1 = last.x + last.width;
      const text = joinRuns(current);
      if (text.trim() !== "") {
        lines.push({
          page,
          x0,
          x1,
          y: first.y,
          size: Math.max(...current.map((r) => r.size)),
          bold: current.filter((r) => r.text.trim()).every((r) => r.bold),
          runs: current.map(({ y: _y, ...r }) => r),
          text,
          column: x1 <= mid + 6 ? "left" : x0 >= mid - 6 ? "right" : "full",
        });
      }
      current = [];
    };
    for (const run of row) {
      const prev = current[current.length - 1];
      if (prev && run.x - (prev.x + prev.width) > GUTTER) flush();
      current.push(run);
    }
    flush();
  }
  return lines;
}

/** Concatenate runs on one line, adding a space where the PDF leaves a gap instead of one. */
function joinRuns(runs: Run[]): string {
  let out = "";
  let end: number | undefined;
  for (const run of runs) {
    if (end !== undefined && run.x - end > 1.5 && !/\s$/.test(out) && !/^\s/.test(run.text)) {
      out += " ";
    }
    out += run.text;
    end = run.x + run.width;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Top to bottom; a full-width line ends a band, and within a band the left column is read
 * before the right.
 */
function readingOrder(lines: Line[], _width: number): Line[] {
  lines.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const out: Line[] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    if (line.column === "full") {
      flush();
      out.push(line);
    } else if (line.column === "left") left.push(line);
    else right.push(line);
  }
  flush();
  return out;
}

/** A debugging view: one line per text line, with page, column, size and boldness. */
export function describeLine(line: Line): string {
  const col = line.column[0]?.toUpperCase();
  const size = line.size.toFixed(0).padStart(2);
  return `p${line.page} ${col} ${size}${line.bold ? "B" : " "} y${line.y.toFixed(0).padStart(3)} x${line.x0.toFixed(0).padStart(3)} | ${line.text}`;
}
