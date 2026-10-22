#!/usr/bin/env bun
// Assemble dist/ for GitHub Pages: the guide (items, photos, figures, PDFs) with the signed
// manifest produced by `openslate guide sign` at its root, the public key, and a human-readable
// index.html. Paths in the manifest are relative to it, so the guide's layout is kept as is.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const GUIDE = join(ROOT, "guide");

if (!existsSync(join(GUIDE, "guide.jws"))) {
  throw new Error("guide/guide.jws is missing: run `openslate guide sign guide --key …` first");
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(GUIDE, DIST, { recursive: true });
cpSync(join(ROOT, "keys"), join(DIST, "keys"), { recursive: true });

interface Subject {
  title: string;
  kind?: string;
}
interface Item {
  subject: Subject;
  retrieved_at: string;
  candidates?: { choice: string; photo?: unknown; statement?: unknown }[];
  arguments?: unknown[];
  documents?: { title: string; file: string }[];
}

const meta = (await Bun.file(join(GUIDE, "guide.json")).json()) as {
  context: { title: string; election: string };
  attribution: { of: { name: string; uri?: string }; retrieved_at: string; sources?: string[] };
};
const publicKey = (
  (await Bun.file(join(ROOT, "keys/guide-public.json")).json()) as { publicKey: string }
).publicKey;

const items: { file: string; item: Item }[] = [];
for (const name of readdirSync(join(GUIDE, "items")).sort()) {
  items.push({
    file: `items/${name}`,
    item: (await Bun.file(join(GUIDE, "items", name)).json()) as Item,
  });
}

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
  if (statements) parts.push(`${statements} statement${statements === 1 ? "" : "s"}`);
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (item.arguments?.length) parts.push(`${item.arguments.length} arguments`);
  return parts.join(" · ") || "&mdash;";
}

const rows = items
  .map(({ file, item }) => {
    const docs = (item.documents ?? [])
      .map((d) => ` &middot; <a href="${escapeHtml(d.file)}">${escapeHtml(d.title)}</a>`)
      .join("");
    return `      <tr>
        <td>${escapeHtml(item.subject.title)}</td>
        <td>${describe(item)}</td>
        <td><a href="${escapeHtml(file)}">item</a>${docs}</td>
      </tr>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(meta.context.title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #ddd; } a { color: #8ab4f8; } th, td { border-color: #333 !important; } }
    h1 { font-size: 1.5rem; margin-bottom: .25rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    code { font-size: .9em; word-break: break-all; }
    .meta { color: #777; }
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
    (<a href="keys/guide-public.json">key</a>). Every file it lists carries its SHA-256.
  </p>
  <table>
    <thead><tr><th>Race or measure</th><th>Material</th><th>Files</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
await Bun.write(join(DIST, "index.html"), html);
console.error(`built dist/ with ${items.length} items`);
