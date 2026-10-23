// Open a remote PDF with pdf.js through HTTP range requests, so a small part of a large file
// (its bookmarks, a few pages) costs a fraction of downloading it. Counts what was fetched.

import { PDFDataRangeTransport, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface RemotePdf {
  doc: Awaited<ReturnType<typeof getDocument>["promise"]>;
  length: number;
  fetched: () => { bytes: number; requests: number };
  close: () => Promise<void>;
}

export async function openRemotePdf(
  url: string,
  options: { userAgent: string; chunk?: number },
): Promise<RemotePdf> {
  const chunk = options.chunk ?? 8192;
  const headers = { "user-agent": options.userAgent };
  let bytes = 0;
  let requests = 0;
  const range = async (begin: number, end: number): Promise<Uint8Array> => {
    const response = await fetch(url, {
      headers: { ...headers, range: `bytes=${begin}-${end - 1}` },
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`${url}: HTTP ${response.status} for bytes ${begin}-${end - 1}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    bytes += data.length;
    requests++;
    return data;
  };
  const head = await fetch(url, { method: "HEAD", headers });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const length = Number(head.headers.get("content-length"));
  const transport = new PDFDataRangeTransport(length, await range(0, Math.min(chunk, length)));
  transport.requestDataRange = (begin: number, end: number) => {
    range(begin, end).then((data) => transport.onDataRange(begin, data));
  };
  const task = getDocument({
    range: transport,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: chunk,
    verbosity: 0,
  });
  const doc = await task.promise;
  return {
    doc,
    length,
    fetched: () => ({ bytes, requests }),
    close: async () => {
      await task.destroy();
    },
  };
}

/** A PDF's bookmarks, flattened in order. */
export async function outlineTitles(doc: RemotePdf["doc"]): Promise<string[]> {
  const titles: string[] = [];
  const walk = (items: { title: string; items?: unknown[] }[]) => {
    for (const item of items) {
      titles.push(item.title);
      if (item.items?.length) walk(item.items as { title: string; items?: unknown[] }[]);
    }
  };
  walk(((await doc.getOutline()) ?? []) as { title: string; items?: unknown[] }[]);
  return titles;
}
