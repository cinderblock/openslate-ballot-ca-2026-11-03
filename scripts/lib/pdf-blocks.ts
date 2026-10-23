// Lines of a laid-out PDF (scripts/lib/pdf-layout.ts) into the guide's blocks: paragraphs,
// bulleted lists, bold and italic runs, and line breaks where the text was broken on purpose
// (a list of names, a signature) rather than wrapped. Column edges, which decide wrapping,
// are measured from the document itself, so build one reader per document.

import type { Block, Inline } from "./guide-common";
import type { Line } from "./pdf-layout";

export interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
}

export function blockReader(pages: { page: number; lines: Line[] }[]) {
  /** A line's runs as styled text, spaced the way the line reads. */
  function segments(line: Line): Segment[] {
    const out: Segment[] = [];
    let end: number | undefined;
    let before = "";
    for (const run of line.runs) {
      let text = run.text.replace(/\s+/g, " ");
      // One space between runs: the PDF's own, or one where it leaves a gap instead.
      if (/\s$/.test(before)) text = text.trimStart();
      else if (end !== undefined && run.x - end > 1.5 && !/^\s/.test(text)) text = ` ${text}`;
      if (text !== "") before = text;
      end = run.x + run.width;
      const last = out[out.length - 1];
      const bold = run.bold && text.trim() !== "";
      const italic = run.italic && text.trim() !== "";
      if (last && (last.bold === bold || text.trim() === "") && last.italic === italic)
        last.text += text;
      else out.push({ text, bold: bold || (text.trim() === "" && !!last?.bold), italic });
    }
    return out;
  }

  /**
   * Where a column's text box ends, near enough: the 90th percentile of where lines on that page
   * and column end (a stray wider line, such as a vote threshold spilling past the column, would
   * throw off a maximum). Text boxes differ by section (a digest's columns are narrower than a
   * statement's), so this is per page; but a column holding only a list of names never reaches
   * its edge, so a page edge well short of the pamphlet's usual one gives way to that.
   */
  function percentile(values: number[], q: number): number | undefined {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  }
  const usualEdge = new Map<Line["column"], number>();
  for (const column of ["left", "right", "full"] as const) {
    const ends = pages.flatMap((p) => p.lines.filter((l) => l.column === column).map((l) => l.x1));
    usualEdge.set(column, percentile(ends, 0.9) ?? 0);
  }
  const pageEdge = new Map<string, number>();
  for (const { page, lines } of pages) {
    for (const column of ["left", "right", "full"] as const) {
      const ends = lines.filter((l) => l.column === column).map((l) => l.x1);
      if (ends.length >= 6) pageEdge.set(`${page}:${column}`, percentile(ends, 0.9) ?? 0);
    }
  }
  function rightEdgeOf(line: Line): number {
    const usual = usualEdge.get(line.column) ?? line.x1;
    const local = pageEdge.get(`${line.page}:${line.column}`) ?? usual;
    return local >= usual - 30 ? local : usual;
  }

  /**
   * Whether the line after `prev` is a wrap of it: the typesetter only moves a word to the next
   * line when it doesn't fit, so if the next line's first word would clearly have fit, the line
   * was broken on purpose (a list of names, a signature, an address). The text is ragged right,
   * so the true edge is only known to within several points; anything short of clearly fitting
   * counts as a wrap, which keeps body text flowing.
   */
  const CLEARLY_FITS = 25;
  function wrapsFrom(prev: Line, line: Line): boolean {
    const edge = rightEdgeOf(prev);
    const first = line.text.split(" ")[0] ?? "";
    const perChar = (line.x1 - line.x0) / Math.max(line.text.length, 1);
    // A space is about half an average character wide.
    return prev.x1 + perChar * (first.length + 0.5) > edge - CLEARLY_FITS;
  }

  /** How two consecutive lines join: same paragraph (space or line break), or a new one. */
  function joint(prev: Line, line: Line): "space" | "break" | "paragraph" {
    const sameFlow = prev.page === line.page && prev.column === line.column;
    if (sameFlow && prev.y - line.y > Math.max(prev.size, line.size) * 1.5) return "paragraph";
    if (!sameFlow && !wrapsFrom(prev, line) && /[.!?:"”)]$/.test(prev.text)) return "paragraph";
    if (isBullet(line)) return "paragraph";
    if (prev.bold !== line.bold && (prev.bold || line.bold)) return "paragraph";
    return wrapsFrom(prev, line) ? "space" : "break";
  }

  const BULLET = /^(?:[•●▪]|-(?=\s))\s*/;
  function isBullet(line: Line): boolean {
    return BULLET.test(line.text);
  }

  /** Text joins without a space after a line ending in a hyphen, slash, or a URL's dot. */
  function glue(prev: string, next: string): string {
    if (/[-/]$/.test(prev) || /\b(?:www|https?:\/\/)\S*\.$/.test(prev)) return "";
    if (/\S—$/.test(prev) || /^—/.test(next)) return "";
    return " ";
  }

  function tidy(runs: Inline[]): Inline[] {
    const out: Inline[] = [];
    for (const run of runs) {
      const last = out[out.length - 1];
      // One space where a line that ends in a space meets the space that joins it to the next.
      if (typeof run === "string" && typeof last === "string")
        out[out.length - 1] = / $/.test(last) ? last + run.replace(/^ +/, "") : last + run;
      else if (run !== "") out.push(run);
    }
    // Trim the paragraph's outer whitespace, inside styled runs too.
    const trimEdge = (r: Inline, side: "start" | "end"): Inline => {
      const trim = (s: string) => (side === "start" ? s.trimStart() : s.trimEnd());
      if (typeof r === "string") return trim(r);
      if ("strong" in r) {
        const inner = [...r.strong];
        const i = side === "start" ? 0 : inner.length - 1;
        if (inner[i] !== undefined) inner[i] = trimEdge(inner[i] as Inline, side);
        return { strong: inner };
      }
      const inner = [...r.em];
      const i = side === "start" ? 0 : inner.length - 1;
      if (inner[i] !== undefined) inner[i] = trimEdge(inner[i] as Inline, side);
      return { em: inner };
    };
    if (out.length > 0) {
      out[0] = trimEdge(out[0] as Inline, "start");
      out[out.length - 1] = trimEdge(out[out.length - 1] as Inline, "end");
    }
    return out.filter((r) => r !== "");
  }

  /**
   * How each line joins the one before it. In a paragraph that is mostly line breaks (a list of
   * names), an uncertain join is a break too, unless the line above is partway through a
   * comma-separated run or the next line carries on in lower case.
   */
  function joints(lines: Line[]): ("space" | "break")[] {
    const out = lines
      .slice(1)
      .map((line, i) => (joint(lines[i] as Line, line) === "break" ? "break" : "space"));
    const breaks = out.filter((j) => j === "break").length;
    if (out.length < 3 || breaks / out.length < 0.5) return out;
    return out.map((j, i) => {
      const prev = (lines[i] as Line).text;
      const next = (lines[i + 1] as Line).text;
      if (j === "break" || /, /.test(prev) || /[,;:–-]$/.test(prev) || /^\p{Ll}/u.test(next))
        return j;
      return "break";
    });
  }

  function inlinesOf(lines: Line[]): Inline[] {
    const runs: Inline[] = [];
    const how = joints(lines);
    let prevText: string | undefined;
    for (const [i, line] of lines.entries()) {
      if (i > 0 && prevText !== undefined) {
        runs.push(how[i - 1] === "break" ? "\n" : glue(prevText, line.text));
      }
      for (const seg of segments(line)) {
        const text = seg.text;
        if (seg.bold) runs.push({ strong: [text] });
        else if (seg.italic) runs.push({ em: [text] });
        else runs.push(text);
      }
      prevText = line.text;
    }
    return tidy(runs);
  }

  /** Lines grouped into paragraphs (each a list of lines), in order. */
  function paragraphs(lines: Line[]): Line[][] {
    const groups: Line[][] = [];
    for (const line of lines) {
      const group = groups[groups.length - 1];
      const prev = group?.[group.length - 1];
      if (!group || !prev || joint(prev, line) === "paragraph") groups.push([line]);
      else group.push(line);
    }
    return groups;
  }

  function blocksOf(lines: Line[]): Block[] {
    const blocks: Block[] = [];
    for (const group of paragraphs(lines)) {
      const first = group[0] as Line;
      if (isBullet(first)) {
        const stripped = group.map((l, i) =>
          i === 0 ? { ...l, text: l.text.replace(BULLET, ""), runs: stripRuns(l) } : l,
        );
        const item: Block[] = [{ type: "p", text: inlinesOf(stripped) }];
        const last = blocks[blocks.length - 1];
        if (last?.type === "ul") last.items.push(item);
        else blocks.push({ type: "ul", items: [item] });
      } else {
        blocks.push({ type: "p", text: inlinesOf(group) });
      }
    }
    return blocks;
  }

  /** A bullet line's runs without the bullet. */
  function stripRuns(line: Line): Line["runs"] {
    const runs = line.runs.map((r) => ({ ...r }));
    const first = runs.find((r) => r.text.trim() !== "");
    // The bullet may be a run of its own ("-", then " Reverse …"), so no space need follow it.
    if (first) first.text = first.text.replace(/^\s*(?:[•●▪]|-)\s*/, "");
    return runs.filter((r) => r.text !== "");
  }

  function plain(lines: Line[]): string {
    return lines
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { segments, wrapsFrom, joint, isBullet, paragraphs, inlinesOf, blocksOf, plain };
}
