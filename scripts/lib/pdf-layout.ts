// Text lines from a PDF in reading order, with the font facts a parser needs (size, bold,
// italic). Voter pamphlets are laid out in two columns with full-width headings between them,
// and pdf.js returns text runs in drawing order, not reading order: this module groups runs
// into lines, sorts each page into bands split by full-width lines, and reads a band's left
// column before its right.

import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
/**
 * A narrower gutter still splits a line where the gap straddles the middle of the page: two
 * columns set close together (Orange County's pamphlet pages leave about 8 pt). A word space is
 * about 2.5 pt, so running text across the middle isn't split.
 */
const NARROW_GUTTER = 6;

export interface PdfPagesOptions {
  /** Only these pages (1-based); the rest come back empty. */
  pages?: (n: number) => boolean;
  /**
   * Decode fonts whose text comes out as glyph numbers rather than characters (a subset font
   * with no Unicode map: "WUD൶F" for "traffic"). See `glyphFonts`.
   */
  repairGlyphFonts?: boolean;
}

export async function pdfPages(bytes: Uint8Array, options: PdfPagesOptions = {}): Promise<Page[]> {
  // pdf.js takes ownership of the buffer it is given; hand it a copy.
  const task = getDocument({
    data: new Uint8Array(bytes),
    fontExtraProperties: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  // Every page's runs first: whether a font needs decoding is decided over the whole document.
  const read: { number: number; width: number; height: number; runs: ReadRun[] }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (options.pages && !options.pages(n)) {
      read.push({ number: n, width: 0, height: 0, runs: [] });
      continue;
    }
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Fonts are only resolved once the page's operators have been loaded.
    const operators = await page.getOperatorList();
    const glyphs = options.repairGlyphFonts ? glyphStreams(operators) : undefined;
    const fontNames = new Map<string, string>();
    const fontOf = (id: string): string => {
      const known = fontNames.get(id);
      if (known !== undefined) return known;
      const font = page.commonObjs.has(id) ? (page.commonObjs.get(id) as { name?: string }) : {};
      const name = font.name ?? "";
      fontNames.set(id, name);
      return name;
    };

    const runs: ReadRun[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as TextItem;
      const stream = glyphs?.get(item.fontName);
      const codes = stream ? alignGlyphs(item.str, stream) : undefined;
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
        ...(codes !== undefined ? { codes } : {}),
      });
    }

    read.push({ number: n, width, height, runs });
    page.cleanup();
  }
  await task.destroy();
  if (options.repairGlyphFonts) {
    const broken = glyphFonts(read.flatMap((p) => p.runs));
    for (const run of read.flatMap((p) => p.runs)) {
      if (broken.has(run.font)) run.text = decodeGlyphs(run.codes ?? run.text);
    }
  }
  return read.map(({ number, width, height, runs }) => ({
    number,
    width,
    height,
    lines: readingOrder(
      toLines(
        runs.map(({ codes: _codes, ...run }) => run),
        number,
        width,
      ),
      width,
    ),
  }));
}

// ---------------------------------------------------------------- fonts without a Unicode map

type ReadRun = Run & {
  y: number;
  /** The run as the font's own character codes (see `alignGlyphs`), when asked to repair. */
  codes?: string;
};

/**
 * Each font's characters in the order the page draws them. pdf.js's text layer turns codes 9
 * to 13 into spaces; in a font without a Unicode map those are glyphs ("(" and ")" among them),
 * so the operator list, which keeps them, is the record.
 */
function glyphStreams(operators: { fnArray: number[]; argsArray: unknown[][] }) {
  const streams = new Map<string, { text: string; at: number }>();
  let font = "";
  const saved: string[] = [];
  for (const [i, fn] of operators.fnArray.entries()) {
    const args = operators.argsArray[i] ?? [];
    if (fn === OPS.save) saved.push(font);
    else if (fn === OPS.restore) font = saved.pop() ?? font;
    else if (fn === OPS.setFont) font = String(args[0]);
    else if (fn === OPS.showText) {
      const stream = streams.get(font) ?? { text: "", at: 0 };
      for (const g of args[0] as unknown[]) {
        if (g && typeof g === "object" && "unicode" in g)
          stream.text += (g as { unicode: string }).unicode;
      }
      streams.set(font, stream);
    }
  }
  return streams;
}

/**
 * A text item's characters with the codes its spaces stand for put back: where the font drew
 * a code from 9 to 13, the item has a space; where it drew nothing, the space is pdf.js's own
 * (a gap between words) and stays.
 */
function alignGlyphs(text: string, stream: { text: string; at: number }): string {
  let out = "";
  for (const c of text) {
    const drawn = stream.text[stream.at];
    if (c === drawn) {
      out += c;
      stream.at++;
    } else if (c === " " && drawn !== undefined && /[\t\n\v\f\r]/.test(drawn)) {
      out += drawn;
      stream.at++;
    } else if (c === " ") {
      out += c;
    } else {
      // Out of step (text the operators draw differently): find this character a little ahead.
      const ahead = stream.text.indexOf(c, stream.at);
      if (ahead >= 0 && ahead - stream.at < 8) stream.at = ahead + 1;
      out += c;
    }
  }
  return out;
}

/** Words common enough that any page of English prose has them. */
const COMMON_WORDS = /\b(the|and|of|to|in|is|that|for|be|by|this|would|on|or|as|with|are)\b/g;

/**
 * Glyph numbers in the standard TrueType order sit 29 below their ASCII letters ("WUD" is
 * "tra"); ligatures and typographic punctuation have numbers of their own. Each pair here was
 * read off its context in Alameda County's November 2026 guide ("e൶ciency", "³SB 63´").
 */
const GLYPH_SPECIALS: Record<string, string> = {
  "¿": "fi",
  À: "fl",
  "൵": "ff",
  "൶": "ffi",
  "৽": "ffi",
  ৼ: "ff",
  "൷": "ffl",
  ò: "½",
  "³": "“",
  "´": "”",
  µ: "‘",
  "¶": "’",
  "±": "–",
  "²": "—",
  "«": "…",
  "\u0086": "§",
  // After the "/" of a signature's "s/": a space.
  "௘": " ",
  Ï: "Ó",
};
function decodeGlyphs(text: string): string {
  return [...text]
    .map((c) => {
      const code = c.charCodeAt(0);
      // pdf.js puts a real space where the PDF leaves a gap; that one isn't a glyph number.
      if (c === " ") return c;
      if (code >= 0x03 && code < 0x7f - 29) return String.fromCharCode(code + 29);
      return GLYPH_SPECIALS[c] ?? c;
    })
    .join("");
}

/**
 * Fonts whose text reads as English only once decoded: plenty of common words after, few
 * before; or, for a font with little text (a few bold subheadings), spaces drawn as code 3,
 * which is the space glyph's number and never a character, and some English once decoded.
 * Prose in other languages decodes to nothing and is left alone.
 */
function glyphFonts(runs: ReadRun[]): Set<string> {
  const count = new Map<string, { raw: number; decoded: number; spaces: number }>();
  for (const run of runs) {
    const text = run.codes ?? run.text;
    const c = count.get(run.font) ?? { raw: 0, decoded: 0, spaces: 0 };
    c.raw += text.toLowerCase().match(COMMON_WORDS)?.length ?? 0;
    c.decoded += decodeGlyphs(text).toLowerCase().match(COMMON_WORDS)?.length ?? 0;
    c.spaces += text.split("\u0003").length - 1;
    count.set(run.font, c);
  }
  return new Set(
    [...count]
      .filter(
        ([, c]) =>
          (c.decoded >= 20 && c.decoded > 5 * c.raw) || (c.spaces >= 3 && c.decoded > c.raw),
      )
      .map(([font]) => font),
  );
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
      const gapStart = prev ? prev.x + prev.width : 0;
      const gap = run.x - gapStart;
      const acrossMiddle = gapStart <= mid + 2 && run.x >= mid - 2;
      if (prev && (gap > GUTTER || (gap > NARROW_GUTTER && acrossMiddle))) flush();
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
