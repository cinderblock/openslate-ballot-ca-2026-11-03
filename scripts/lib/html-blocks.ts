// HTML into the guide's block model: paragraphs, headings, lists, tables and images, with
// emphasis kept and everything else (scripts, forms, a site's chrome) left out. There is never
// raw HTML in a guide; renderers build elements from these blocks.

import { type DefaultTreeAdapterMap, parse, parseFragment } from "parse5";
import type { Block, Inline } from "./guide-common";

export type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];

/** Blocks from an HTML fragment (e.g. a statement or a measure's text served as HTML). */
export function htmlBlocks(html: string, ctx: BlockContext = {}): Block[] {
  return blocks(parseFragment(html).childNodes as Node[], ctx);
}

/** A whole HTML document, for walking with the helpers below. */
export function parseDocument(html: string): Element {
  return parse(html) as unknown as Element;
}

export function isElement(node: Node): node is Element {
  return "tagName" in node;
}
export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}
export function classes(el: Element): string[] {
  return (attr(el, "class") ?? "").split(/[\s;]+/).filter(Boolean);
}
export function hasClass(el: Element, name: string): boolean {
  return classes(el).includes(name);
}
export function children(el: Element): Element[] {
  return el.childNodes.filter(isElement);
}
export function findAll(el: Element, test: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (const child of children(e)) {
      if (test(child)) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}
export function find(el: Element, test: (e: Element) => boolean): Element | undefined {
  return findAll(el, test)[0];
}
export function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (!isElement(node)) return "";
  if (node.tagName === "br") return "\n";
  return node.childNodes.map(textOf).join("");
}
export function clean(text: string): string {
  return text.replace(/[ \t\r\n ]+/g, " ").trim();
}

// ---------------------------------------------------------------- HTML → guide blocks

const INLINE_PASSTHROUGH = new Set([
  "a",
  "span",
  "sup",
  "sub",
  "u",
  "font",
  "abbr",
  "small",
  "big",
  "label",
]);
const BLOCK_CONTAINERS = new Set([
  "div",
  "section",
  "center",
  "blockquote",
  "article",
  "main",
  "aside",
  "dl",
  "dt",
  "dd",
  "header",
  "footer",
  "tbody",
  "thead",
]);
const SKIP_TAGS = new Set([
  "hr",
  "script",
  "style",
  "nav",
  "form",
  "select",
  "option",
  "noscript",
  "iframe",
  "input",
  "button",
]);

export function inlines(nodes: Node[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      out.push((node as DefaultTreeAdapterMap["textNode"]).value.replace(/[ \t\r\n ]+/g, " "));
    } else if (isElement(node)) {
      const tag = node.tagName;
      if (tag === "br") out.push("\n");
      else if (tag === "em" || tag === "i") out.push({ em: inlines(node.childNodes) });
      else if (tag === "strong" || tag === "b") out.push({ strong: inlines(node.childNodes) });
      else if (INLINE_PASSTHROUGH.has(tag)) out.push(...inlines(node.childNodes));
    }
  }
  return tidy(out);
}

/** Merge adjacent strings, drop empties, and keep spacing sane around line breaks. */
export function tidy(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const run of runs) {
    if (typeof run === "string") {
      const last = out.at(-1);
      if (typeof last === "string")
        out[out.length - 1] = (last + run).replace(/ ?\n ?/g, "\n").replace(/ {2,}/g, " ");
      else out.push(run.replace(/ ?\n ?/g, "\n"));
    } else {
      const inner = "em" in run ? run.em : run.strong;
      if (inner.length === 0 || inner.every((r) => typeof r === "string" && r.trim() === "")) {
        if (inner.some((r) => typeof r === "string" && r.length > 0)) out.push(" ");
        continue;
      }
      out.push(run);
    }
  }
  return out.filter((r) => typeof r !== "string" || r.length > 0);
}

/** Trim leading and trailing whitespace off a run of inlines, descending into emphasis. */
export function trimRuns(runs: Inline[]): Inline[] {
  const edge = (list: Inline[], start: boolean): Inline[] => {
    if (list.length === 0) return list;
    const index = start ? 0 : list.length - 1;
    const run = list[index] as Inline;
    let next: Inline | undefined;
    if (typeof run === "string") {
      const trimmed = start ? run.replace(/^[\s]+/, "") : run.replace(/[\s]+$/, "");
      next = trimmed.length > 0 ? trimmed : undefined;
    } else {
      const inner = edge("em" in run ? run.em : run.strong, start);
      next = inner.length > 0 ? ("em" in run ? { em: inner } : { strong: inner }) : undefined;
    }
    const copy = [...list];
    if (next === undefined) {
      copy.splice(index, 1);
      return edge(copy, start);
    }
    copy[index] = next;
    return copy;
  };
  return edge(edge(runs, true), false);
}

export function plain(runs: Inline[]): string {
  return runs.map((r) => (typeof r === "string" ? r : plain("em" in r ? r.em : r.strong))).join("");
}

export interface BlockContext {
  /** Elements with any of these classes are left out (a site's navigation and chrome). */
  skipClasses?: string[];
  /** Where an image goes in the guide: its file path, or undefined to leave it out. */
  image?: (src: string) => string | undefined;
}

export function blocks(nodes: Node[], ctx: BlockContext): Block[] {
  const out: Block[] = [];
  let loose: Node[] = [];
  const flush = () => {
    const text = trimRuns(inlines(loose));
    if (plain(text).trim()) out.push({ type: "p", text });
    loose = [];
  };
  for (const node of nodes) {
    if (!isElement(node)) {
      loose.push(node);
      continue;
    }
    const tag = node.tagName;
    if (
      INLINE_PASSTHROUGH.has(tag) &&
      !find(node, (e) => e.tagName === "img" || e.tagName === "p")
    ) {
      loose.push(node);
      continue;
    }
    if (["em", "i", "strong", "b", "br"].includes(tag)) {
      loose.push(node);
      continue;
    }
    flush();
    if (
      SKIP_TAGS.has(tag) ||
      (ctx.skipClasses ?? []).some((c) => hasClass(node, c)) ||
      attr(node, "id") === "crmbs"
    )
      continue;
    if (tag === "p") {
      const text = trimRuns(inlines(node.childNodes));
      if (plain(text).trim()) out.push({ type: "p", text });
      out.push(
        ...blocks(
          children(node).filter((c) => c.tagName === "img"),
          ctx,
        ),
      );
    } else if (/^h[1-6]$/.test(tag)) {
      const level = tag === "h1" || tag === "h2" ? 2 : tag === "h3" ? 3 : 4;
      const text = trimRuns(inlines(node.childNodes));
      if (plain(text).trim()) out.push({ type: "h", level, text });
    } else if (tag === "ul" || tag === "ol") {
      const items = children(node)
        .filter((li) => li.tagName === "li")
        .map((li) => blocks(li.childNodes, ctx))
        .filter((item) => item.length > 0);
      if (items.length > 0) out.push({ type: tag, items });
    } else if (tag === "table") {
      const rows = findAll(node, (e) => e.tagName === "tr").map((tr) =>
        children(tr)
          .filter((c) => c.tagName === "td" || c.tagName === "th")
          .map((c) => ({
            ...(c.tagName === "th" ? { header: true } : {}),
            text: trimRuns(inlines(c.childNodes)),
          })),
      );
      const caption = find(node, (e) => e.tagName === "caption");
      out.push({ type: "table", ...(caption ? { caption: clean(textOf(caption)) } : {}), rows });
    } else if (tag === "img") {
      const src = attr(node, "src");
      const file = src ? ctx.image?.(src) : undefined;
      if (!file) continue;
      const alt = attr(node, "alt");
      out.push({ type: "img", file, ...(alt ? { alt } : {}) });
    } else if (BLOCK_CONTAINERS.has(tag) || INLINE_PASSTHROUGH.has(tag)) {
      out.push(...blocks(node.childNodes, ctx));
    }
  }
  flush();
  return out;
}
