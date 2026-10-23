// The images a PDF draws, where it draws them, as JPEG files. pdf.js decodes each through its
// colour space first: a pamphlet's photos may be stored as ink amounts for one separation, which
// passed through as they are would show as negatives.

import { encode } from "jpeg-js";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfImage {
  /** 1-based page number. */
  page: number;
  /** Where it's drawn, in PDF units from the page's bottom left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its own size, in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  jpeg: Uint8Array;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** pdf.js's decoded image: grey (1 bit), RGB or RGBA pixels. */
interface Decoded {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}
function toRgba(image: Decoded): Uint8Array {
  const { width, height, kind, data } = image;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (kind === 3) {
      rgba.set(data.subarray(i * 4, i * 4 + 4), i * 4);
    } else if (kind === 2) {
      rgba.set(data.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = 255;
    } else {
      // One bit per pixel, rows padded to a byte.
      const row = Math.floor(i / width);
      const col = i % width;
      const byte = data[row * Math.ceil(width / 8) + (col >> 3)] ?? 0;
      const v = byte & (0x80 >> (col & 7)) ? 255 : 0;
      rgba.set([v, v, v, 255], i * 4);
    }
  }
  return rgba;
}

/** Every image drawn on the chosen pages at least `minWidth` units wide (skips rules and dots). */
export async function pdfImages(
  bytes: Uint8Array,
  options: { pages?: (n: number) => boolean; minWidth?: number; quality?: number } = {},
): Promise<PdfImage[]> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    // Decoded pixels rather than a browser bitmap.
    isOffscreenCanvasSupported: false,
  });
  const doc = await task.promise;
  const images: PdfImage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (options.pages && !options.pages(n)) continue;
    const page = await doc.getPage(n);
    const operators = await page.getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const saved: Matrix[] = [];
    for (const [i, fn] of operators.fnArray.entries()) {
      const args = (operators.argsArray[i] ?? []) as unknown[];
      if (fn === OPS.save) saved.push(ctm);
      else if (fn === OPS.restore) ctm = saved.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
      else if (fn === OPS.paintImageXObject) {
        const width = Math.hypot(ctm[0], ctm[1]);
        const height = Math.hypot(ctm[2], ctm[3]);
        if (width < (options.minWidth ?? 0)) continue;
        const name = args[0] as string;
        const decoded = (
          page.objs.has(name) ? page.objs.get(name) : page.commonObjs.get(name)
        ) as Decoded;
        const { data } = encode(
          { data: toRgba(decoded), width: decoded.width, height: decoded.height },
          options.quality ?? 85,
        );
        images.push({
          page: n,
          x: ctm[4],
          y: ctm[5],
          width,
          height,
          pixelWidth: decoded.width,
          pixelHeight: decoded.height,
          jpeg: new Uint8Array(data),
        });
      }
    }
    page.cleanup();
  }
  await task.destroy();
  return images;
}
