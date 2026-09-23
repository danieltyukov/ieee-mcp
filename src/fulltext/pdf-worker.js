// @ts-check
// Plain JavaScript so Node can start this worker without a TypeScript loader.
import { parentPort, workerData } from 'node:worker_threads';

// pdfjs uses Promise.withResolvers, which Node 20 does not have.
const PromiseCtor = /** @type {PromiseConstructor & { withResolvers?: unknown }} */ (Promise);
if (typeof PromiseCtor.withResolvers !== 'function') {
  PromiseCtor.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Extraction runs on bytes that are already downloaded; PDFs must not trigger network access.
globalThis.fetch = async () => {
  throw new Error('Network access is disabled during document extraction.');
};

/**
 * @typedef {{ bytes: Uint8Array; maxPages: number; maxTextLength: number }} Input
 */

/**
 * @returns {Promise<{ text: string; pages: number; extractedPages: number }>}
 */
async function extract() {
  const { bytes, maxPages, maxTextLength } = /** @type {Input} */ (workerData);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    useWorkerFetch: false,
  });
  try {
    const pdf = await task.promise;
    /** @type {string[]} */
    const parts = [];
    const count = Math.min(pdf.numPages, maxPages);
    let length = 0;
    let extractedPages = 0;
    for (let i = 1; i <= count && length <= maxTextLength; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      /** @type {string[]} */
      const lines = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        } else if (item.str && !item.str.endsWith(' ')) line += ' ';
      }
      if (line) lines.push(line);
      const text = `[Page ${i}]\n${lines
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim()}`;
      parts.push(text);
      length += text.length;
      extractedPages++;
      page.cleanup();
    }
    return { text: parts.join('\n\n').slice(0, maxTextLength), pages: pdf.numPages, extractedPages };
  } finally {
    await task.destroy();
  }
}

void extract().then(
  (result) => parentPort?.postMessage({ result }),
  (error) => parentPort?.postMessage({ error: error instanceof Error ? error.message : 'failed' }),
);
