#!/usr/bin/env bun
// Assemble dist/ for GitHub Pages: each guide (items, photos, figures, PDFs) with the signed
// manifest produced by `openslate guide sign` at its root, the public key, and a human-readable
// index.html per guide. The state guide (guide/) is published at the site root and each county's
// (county/<name>/) under county/<name>/. Paths in a manifest are relative to it, so each guide's
// layout is kept as is.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

interface Guide {
  /** Source directory, relative to the repo. */
  dir: string;
  /** Published path under dist/, "" for the root. */
  path: string;
}
const COUNTIES = join(ROOT, "county");
const guides: Guide[] = [
  { dir: "guide", path: "" },
  ...(existsSync(COUNTIES) ? readdirSync(COUNTIES).sort() : []).map((name) => ({
    dir: `county/${name}`,
    path: `county/${name}`,
  })),
];

for (const { dir } of guides) {
  if (!existsSync(join(ROOT, dir, "guide.jws"))) {
    throw new Error(
      `${dir}/guide.jws is missing: run \`openslate guide sign ${dir} --key …\` first`,
    );
  }
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const { dir, path } of guides) {
  cpSync(join(ROOT, dir), join(DIST, path), { recursive: true });
}
cpSync(join(ROOT, "keys"), join(DIST, "keys"), { recursive: true });

interface Subject {
  title: string;
  kind?: string;
}
interface Item {
  subject: Subject;
  retrieved_at: string;
  candidates?: { choice: string; photo?: unknown; statement?: unknown }[];
  arguments?: { paid?: boolean }[];
  documents?: { title: string; file?: string; source: string; page?: number }[];
}
interface Meta {
  context: { title: string; election: string };
  attribution: { of: { name: string; uri?: string }; retrieved_at: string; sources?: string[] };
}

const publicKey = (
  (await Bun.file(join(ROOT, "keys/guide-public.json")).json()) as { publicKey: string }
).publicKey;

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function describe(item: Item): string {
  const parts: string[] = [];
  const statements = item.candidates?.filter((c) => c.statement).length ?? 0;
  const photos = item.candidates?.filter((c) => c.photo).length ?? 0;
  const official = item.arguments?.filter((a) => !a.paid).length ?? 0;
  const paid = item.arguments?.filter((a) => a.paid).length ?? 0;
  if (statements) parts.push(`${statements} statement${statements === 1 ? "" : "s"}`);
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (official) parts.push(`${official} arguments`);
  if (paid) parts.push(`${paid} paid argument${paid === 1 ? "" : "s"}`);
  return parts.join(" &middot; ") || "&mdash;";
}

function documentLink(d: NonNullable<Item["documents"]>[number]): string {
  const href = d.file ?? (d.page ? `${d.source}#page=${d.page}` : d.source);
  const where = d.file ? "" : d.page ? ` (original, p.&nbsp;${d.page})` : " (original)";
  return ` &middot; <a href="${escapeHtml(href)}">${escapeHtml(d.title)}</a>${where}`;
}

const STYLE = `    body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #ddd; } a { color: #8ab4f8; } th, td { border-color: #333 !important; } }
    h1 { font-size: 1.5rem; margin-bottom: .25rem; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    code { font-size: .9em; word-break: break-all; }
    .meta { color: #777; }`;

/** One guide's index.html; `others` lists the other guides published beside it. */
async function renderIndex(guide: Guide, others: { href: string; title: string }[]): Promise<void> {
  const meta = (await Bun.file(join(ROOT, guide.dir, "guide.json")).json()) as Meta;
  const items: { file: string; item: Item }[] = [];
  for (const name of readdirSync(join(ROOT, guide.dir, "items")).sort()) {
    items.push({
      file: `items/${name}`,
      item: (await Bun.file(join(ROOT, guide.dir, "items", name)).json()) as Item,
    });
  }
  const keyHref = `${guide.path ? "../".repeat(guide.path.split("/").length) : ""}keys/guide-public.json`;
  const rows = items
    .map(({ file, item }) => {
      const docs = (item.documents ?? []).map(documentLink).join("");
      return `      <tr>
        <td>${escapeHtml(item.subject.title)}</td>
        <td>${describe(item)}</td>
        <td><a href="${escapeHtml(file)}">item</a>${docs}</td>
      </tr>`;
    })
    .join("\n");
  const otherList = others.length
    ? `  <h2>Also published here</h2>
  <ul>
${others.map((o) => `    <li><a href="${escapeHtml(o.href)}">${escapeHtml(o.title)}</a></li>`).join("\n")}
  </ul>
`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(meta.context.title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
${STYLE}
  </style>
</head>
<body>
  <h1>${escapeHtml(meta.context.title)}</h1>
  <p class="meta">
    What the <a href="${escapeHtml(meta.attribution.of.uri ?? "")}">${escapeHtml(meta.attribution.of.name)}</a>
    published about each race and measure, mirrored from
    ${(meta.attribution.sources ?? []).map((s) => `<a href="${escapeHtml(s)}">${escapeHtml(s)}</a>`).join(", ")}
    on ${escapeHtml(meta.attribution.retrieved_at.slice(0, 10))}, for the
    <a href="https://openslate.us">OpenSlate</a> app. Reference material, not endorsements:
    candidate statements and ballot arguments are their authors' own words and were not checked
    for accuracy by any official agency.
  </p>
  <p class="meta">
    Signed manifest: <a href="guide.jws">guide.jws</a>, by <code>${escapeHtml(publicKey)}</code>
    (<a href="${keyHref}">key</a>). Every file it lists carries its SHA-256.
  </p>
  <table>
    <thead><tr><th>Race or measure</th><th>Material</th><th>Files</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
${otherList}</body>
</html>
`;
  await Bun.write(join(DIST, guide.path, "index.html"), html);
  console.error(`built ${guide.path || "/"} with ${items.length} items`);
}

const titles = new Map<string, string>();
for (const guide of guides) {
  const meta = (await Bun.file(join(ROOT, guide.dir, "guide.json")).json()) as Meta;
  titles.set(guide.path, meta.context.title);
}
for (const guide of guides) {
  // The root links every county guide; a county guide links back to the root.
  const others = guide.path
    ? [{ href: "../".repeat(guide.path.split("/").length), title: titles.get("") ?? "State guide" }]
    : guides
        .filter((g) => g.path)
        .map((g) => ({ href: `${g.path}/`, title: titles.get(g.path) ?? g.path }));
  await renderIndex(guide, others);
}
