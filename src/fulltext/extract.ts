import { Worker } from 'node:worker_threads';
import { IeeeMcpError } from '../errors.js';

export interface PdfText {
  text: string;
  pages: number;
  warnings: string[];
}

const MAX_TEXT = 2_000_000;

/** The worker is plain JavaScript next to this module in src and next to cli.js in dist. */
function workerUrl(): URL {
  return new URL('./pdf-worker.js', import.meta.url);
}

/** PDF text extraction in a worker thread with time and memory limits and no network access. */
export async function extractPdf(bytes: Uint8Array, timeoutMs = 60_000): Promise<PdfText> {
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), {
      workerData: { bytes: data, maxPages: 400, maxTextLength: MAX_TEXT },
      transferList: [data.buffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: IeeeMcpError, result?: PdfText): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().finally(() => (error ? reject(error) : resolve(result!)));
    };
    const timer = setTimeout(
      () => finish(new IeeeMcpError('DOCUMENT_PARSE_FAILED', 'PDF text extraction took too long.')),
      timeoutMs,
    );
    worker.once(
      'message',
      (message: { result?: { text: string; pages: number; extractedPages: number }; error?: string }) => {
        if (!message.result) {
          const reason = message.error ? ` (${message.error.slice(0, 120)})` : '';
          finish(
            new IeeeMcpError(
              'DOCUMENT_PARSE_FAILED',
              `This PDF could not be parsed${reason}. It may be damaged or encrypted.`,
            ),
          );
          return;
        }
        const { text, pages, extractedPages } = message.result;
        const warnings: string[] = [];
        if (extractedPages < pages)
          warnings.push(`Only the first ${extractedPages} of ${pages} pages were extracted.`);
        if (text.replace(/\[Page \d+\]/g, '').trim().length < 40 * Math.max(1, Math.min(pages, 3))) {
          warnings.push('Very little text was found; this PDF may be scanned images.');
        }
        finish(undefined, { text: tidy(text), pages, warnings });
      },
    );
    worker.once('error', (error) =>
      finish(
        new IeeeMcpError(
          'DOCUMENT_PARSE_FAILED',
          `PDF extraction stopped unexpectedly or ran out of memory (${error.message.slice(0, 120)}).`,
        ),
      ),
    );
    worker.once('exit', () =>
      finish(new IeeeMcpError('DOCUMENT_PARSE_FAILED', 'PDF extraction ended without a result.')),
    );
  });
}

/** Join words split across lines, collapse justified spacing and drop IEEE's per-page licence footer. */
export function tidy(text: string): string {
  return text
    .replace(/Authorized licensed use limited to:[^\n]*Restrictions apply\.?/g, '')
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
