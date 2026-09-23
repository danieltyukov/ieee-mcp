import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { IeeeMcpError } from '../errors.js';
import { debug, HttpError, type HttpClient } from '../http.js';
import { AuthRequired, isPdf, type ProxyClient } from '../proxy/client.js';
import { titleCoverage } from '../text.js';
import { extractPdf, type PdfText } from './extract.js';

export interface PaperRef {
  articleNumber?: string;
  doi?: string;
  /** Why the article number is missing, when a lookup failed rather than there being none. */
  lookupNote?: string;
  /** Used to check that an open-access copy is really this paper. */
  title?: string;
  oaPdfUrls: string[];
  /** Repository pages to look for a PDF link on, when no direct PDF is known. */
  oaLandingUrls?: string[];
}

export type PdfOrigin = 'cache' | 'open-access' | 'proxy';

export interface PdfFile {
  bytes: Uint8Array;
  /** Cached copy on disk; missing when the cache could not be written. */
  path?: string;
  origin: PdfOrigin;
  /** Where an open-access copy came from. */
  url?: string;
  /** Text already extracted while verifying the file. */
  text?: PdfText;
  warnings: string[];
}

export interface PaperText extends PdfText {
  origin: PdfOrigin;
  /** Where the text first came from; kept for cached copies so provenance is never lost. */
  source?: Exclude<PdfOrigin, 'cache'>;
  url?: string;
}

interface CachedText extends PdfText {
  source?: Exclude<PdfOrigin, 'cache'>;
  url?: string;
}

const EXPECTED_DOWNLOAD_FAILURES = new Set([
  'TIMEOUT',
  'UPSTREAM_ERROR',
  'FILE_TOO_LARGE',
  'DOCUMENT_PARSE_FAILED',
]);

/** A short reason for one failed open-access copy, or undefined if the error is not an expected one. */
function downloadFailure(error: unknown): string | undefined {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof IeeeMcpError && EXPECTED_DOWNLOAD_FAILURES.has(error.code)) return error.message;
  return undefined;
}

/** A filesystem-safe cache key: the article number when known, otherwise the DOI. */
export function cacheKey(ref: PaperRef): string {
  if (ref.articleNumber) return `ieee-${ref.articleNumber}`;
  if (ref.doi) return `doi-${ref.doi.replace(/[^a-z0-9._-]+/gi, '_')}`;
  throw new IeeeMcpError('INVALID_ARGUMENT', 'The paper has neither an IEEE article number nor a DOI.');
}

/**
 * Whether extracted text looks like the paper with this title. Open-access locations in
 * OpenAlex are occasionally attached to the wrong work; this keeps a different document from
 * being returned as the requested paper.
 */
export function titleMatches(title: string, text: string): boolean {
  return titleCoverage(title, text.slice(0, 8000).replace(/-\n/g, '')) >= 0.6;
}

/**
 * The PDF a repository page declares for indexers in a citation_pdf_url meta tag (the Google
 * Scholar convention that DSpace, EPrints and most institutional repositories follow).
 */
export function citationPdfUrl(html: string, base: URL): string | undefined {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']citation_pdf_url["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.replace(/&amp;/g, '&').trim();
    if (!content) continue;
    try {
      const url = new URL(content, base);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // not a usable link; keep looking
    }
  }
  return undefined;
}

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/** Read a cache file. The cache is best effort: an unreadable one counts as a miss. */
async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR')
      console.error(`[ieee-mcp] could not read the cache: ${String(error)}`);
    return undefined;
  }
}

/** Finds a PDF for a paper (cache, open access, institutional proxy) and extracts its text. */
export class FullText {
  /** Requests in progress, so two calls for one paper share a single download. */
  private readonly inflight = new Map<string, Promise<PdfFile>>();

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
    private readonly proxy: ProxyClient,
  ) {}

  /** Write the PDF (and its text) to the cache. A failure is reported, never fatal. */
  private async cache(
    key: string,
    bytes: Uint8Array | undefined,
    text?: CachedText,
  ): Promise<{ path?: string; warnings: string[] }> {
    try {
      await mkdir(this.config.cacheDir, { recursive: true, mode: 0o700 });
      let path: string | undefined;
      if (bytes) {
        path = join(this.config.cacheDir, `${key}.pdf`);
        await writeFile(path, bytes, { mode: 0o600 });
      }
      if (text)
        await writeFile(join(this.config.cacheDir, `${key}.json`), JSON.stringify(text), { mode: 0o600 });
      return path ? { path, warnings: [] } : { warnings: [] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[ieee-mcp] could not write the cache: ${reason}`);
      return {
        warnings: [
          `The cache could not be written (${reason}); the paper will be downloaded again next time.`,
        ],
      };
    }
  }

  async pdf(ref: PaperRef): Promise<PdfFile> {
    const key = cacheKey(ref);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.findPdf(ref, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async findPdf(ref: PaperRef, key: string): Promise<PdfFile> {
    const cachedPath = join(this.config.cacheDir, `${key}.pdf`);
    const cached = await readIfExists(cachedPath);
    if (cached && isPdf(cached)) {
      return { bytes: new Uint8Array(cached), path: cachedPath, origin: 'cache', warnings: [] };
    }

    const failures: string[] = [];
    let mismatched = 0;
    // Direct PDF links first, then repository pages that point to one.
    const candidates = [
      ...ref.oaPdfUrls.slice(0, 4).map((url) => ({ url, landing: false })),
      ...(ref.oaLandingUrls ?? []).slice(0, 2).map((url) => ({ url, landing: true })),
    ];
    for (const candidate of candidates) {
      const host = hostOf(candidate.url);
      if (!host) {
        failures.push('an invalid link');
        continue;
      }
      let url = candidate.url;
      let bytes: Uint8Array;
      let text: PdfText;
      try {
        if (candidate.landing) {
          const page = await this.http.getPage(url, { maxBytes: 2 * 1024 * 1024 });
          const pdfUrl = citationPdfUrl(page.text, new URL(page.url));
          if (!pdfUrl) {
            failures.push(`${host}: no PDF link on the page`);
            continue;
          }
          url = pdfUrl;
        }
        bytes = await this.http.getBytes(url, {
          accept: 'application/pdf',
          maxBytes: this.config.maxPdfBytes,
        });
        if (!isPdf(bytes)) {
          failures.push(`${host}: not a PDF`);
          continue;
        }
        text = await extractPdf(bytes);
      } catch (error) {
        const reason = downloadFailure(error);
        if (!reason) throw error;
        debug(`open-access copy from ${host} failed: ${reason}`);
        failures.push(`${host}: ${reason}`);
        continue;
      }
      if (ref.title && !titleMatches(ref.title, text.text)) {
        mismatched++;
        failures.push(`${host}: a different document`);
        continue;
      }
      const stored = await this.cache(key, bytes, { ...text, source: 'open-access', url });
      return { bytes, ...stored, origin: 'open-access', url, text };
    }

    const tried = failures.length ? ` Open-access copies tried: ${failures.join('; ')}.` : '';
    if (!this.proxy.origin) {
      throw new IeeeMcpError(
        'NO_FULL_TEXT',
        mismatched
          ? `The open-access copies listed for this paper are different documents (a metadata error at OpenAlex), and no institutional proxy is configured (IEEE_PROXY_URL).${tried}`
          : ref.oaPdfUrls.length || ref.oaLandingUrls?.length
            ? `The open-access copies could not be downloaded, and no institutional proxy is configured (IEEE_PROXY_URL).${tried}`
            : "No open-access copy exists. Set IEEE_PROXY_URL to read it through your institution's subscription.",
      );
    }
    if (!ref.articleNumber) {
      throw new IeeeMcpError(
        'NO_FULL_TEXT',
        `${ref.lookupNote ?? 'This paper has no IEEE article number, so the proxy cannot fetch it.'}${tried}`,
      );
    }
    try {
      const bytes = await this.proxy.fetchPdf(ref.articleNumber);
      return { bytes, ...(await this.cache(key, bytes)), origin: 'proxy' };
    } catch (error) {
      if (error instanceof AuthRequired || !(error instanceof IeeeMcpError)) throw error;
      const link = this.proxy.documentUrl(ref.articleNumber);
      throw new IeeeMcpError(
        error.code,
        `${error.message}${link ? ` You can open it yourself at ${link}` : ''}`,
      );
    }
  }

  async text(ref: PaperRef): Promise<PaperText> {
    const key = cacheKey(ref);
    const cached = await readIfExists(join(this.config.cacheDir, `${key}.json`));
    if (cached) {
      try {
        const parsed = JSON.parse(cached.toString('utf8')) as CachedText;
        if (typeof parsed.text === 'string')
          return { ...parsed, warnings: parsed.warnings ?? [], origin: 'cache' };
      } catch {
        debug(`cached text for ${key} is damaged; extracting again`);
      }
    }
    const file = await this.pdf(ref);
    const source = file.origin === 'cache' ? undefined : file.origin;
    let extracted = file.text;
    const warnings = [...file.warnings];
    if (!extracted) {
      extracted = await extractPdf(file.bytes);
      const stored = await this.cache(key, undefined, {
        ...extracted,
        ...(source ? { source } : {}),
        ...(file.url ? { url: file.url } : {}),
      });
      warnings.push(...stored.warnings);
    }
    return {
      ...extracted,
      warnings: [...extracted.warnings, ...warnings],
      origin: file.origin,
      ...(source ? { source } : {}),
      ...(file.url ? { url: file.url } : {}),
    };
  }
}

/** A slice of a long text that ends on a line break when one is near. */
export function chunk(text: string, offset: number, maxChars: number): { text: string; next?: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const lineBreak = text.lastIndexOf('\n', end);
    if (lineBreak > start + maxChars * 0.8) end = lineBreak + 1;
  }
  return { text: text.slice(start, end), ...(end < text.length ? { next: end } : {}) };
}
