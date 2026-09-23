import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IeeeMcpError } from '../errors.js';
import { mergeCookies, type Cookie } from './cookies.js';

export interface ProxySession {
  origin: string;
  cookies: Cookie[];
  /** User agent of the browser that signed in; reused so the proxy sees one client. */
  userAgent?: string;
  savedAt: string;
}

export interface ProxyUsage {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  count: number;
  lastAt: number;
}

/** Write JSON atomically with owner-only permissions. */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

async function readJson<T>(file: string, damaged: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IeeeMcpError('INTERNAL_ERROR', `${file} is damaged. ${damaged}`);
  }
}

/**
 * Run a task while holding a lock file, so several server processes (one per client window)
 * never interleave a read-modify-write of the same state file.
 */
export async function withFileLock<T>(
  lockFile: string,
  task: () => Promise<T>,
  options: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(String(process.pid)).finally(() => handle.close());
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockFile).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new IeeeMcpError(
          'INTERNAL_ERROR',
          `Timed out waiting for ${lockFile}. Delete it if no other ieee-xplore-mcp is running.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockFile, { force: true });
  }
}

/** The saved proxy sign-in. One file, owner-only permissions, writes serialised across processes. */
export class SessionStore {
  private readonly lock: string;

  constructor(readonly file: string) {
    this.lock = `${file}.lock`;
  }

  async load(): Promise<ProxySession | undefined> {
    const data = await readJson<{ version?: number; proxy?: ProxySession }>(
      this.file,
      'Run "ieee-xplore-mcp logout" and sign in again.',
    );
    return data?.version === 1 ? data.proxy : undefined;
  }

  async save(session: ProxySession): Promise<void> {
    await withFileLock(this.lock, () => writePrivateJson(this.file, { version: 1, proxy: session }));
  }

  /**
   * Merge cookies the proxy refreshed during a request into the saved session, unless a newer
   * sign-in replaced it meanwhile. Returns false when the session changed and nothing was written.
   */
  async mergeCookies(savedAt: string, updates: Cookie[]): Promise<boolean> {
    return withFileLock(this.lock, async () => {
      const current = await this.load();
      if (!current || current.savedAt !== savedAt) return false;
      await writePrivateJson(this.file, {
        version: 1,
        proxy: { ...current, cookies: mergeCookies(current.cookies, updates) },
      });
      return true;
    });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** Download counters for the proxy, kept across restarts and shared by all server processes. */
export class UsageStore {
  readonly lock: string;

  constructor(readonly file: string) {
    this.lock = `${file}.lock`;
  }

  /** Fails closed: a damaged file stops downloads instead of resetting the daily count. */
  async load(): Promise<ProxyUsage | undefined> {
    const data = await readJson<{ proxy?: ProxyUsage }>(
      this.file,
      'Delete it to reset the proxy download counter.',
    );
    return data?.proxy;
  }

  async save(usage: ProxyUsage): Promise<void> {
    await writePrivateJson(this.file, { proxy: usage });
  }
}
