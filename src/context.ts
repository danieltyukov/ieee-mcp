import { loadConfig, type Config } from './config.js';
import { FullText } from './fulltext/fetcher.js';
import { describeError, IeeeMcpError } from './errors.js';
import { debug, HttpClient, type FetchLike } from './http.js';
import { Library } from './library.js';
import { signIn, type SignInOptions } from './proxy/browser.js';
import { ProxyClient } from './proxy/client.js';
import { SessionStore, UsageStore, type ProxySession } from './proxy/session.js';
import { DoiClient } from './sources/doi.js';
import { IeeeClient } from './sources/ieee.js';
import { OpenAlexClient } from './sources/openalex.js';

export interface AppContext {
  config: Config;
  http: HttpClient;
  library: Library;
  fulltext: FullText;
  proxy: ProxyClient;
  sessions: SessionStore;
  signIn(options: Omit<SignInOptions, 'timeoutMs'> & { timeoutMs?: number }): Promise<ProxySession>;
}

export interface ContextOverrides {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  signIn?: AppContext['signIn'];
}

export function createContext(config: Config = loadConfig(), overrides: ContextOverrides = {}): AppContext {
  const http = new HttpClient({
    timeoutMs: config.timeoutMs,
    ...(config.email ? { email: config.email } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    // OpenAlex asks anonymous clients to wait about half a minute when it is busy.
    maxRetryWaitMs: config.openAlexApiKey ? 20_000 : 45_000,
  });
  const openalex = new OpenAlexClient(http, config.openAlexApiKey, config.email);
  const doi = new DoiClient(http);
  const ieee = config.ieeeApiKey ? new IeeeClient(http, config.ieeeApiKey) : undefined;
  const library = new Library(openalex, doi, ieee);
  const sessions = new SessionStore(config.sessionFile);
  const usage = new UsageStore(config.stateFile);

  const doSignIn: AppContext['signIn'] =
    overrides.signIn ??
    ((options) =>
      signIn(config, sessions, {
        ...options,
        timeoutMs:
          options.timeoutMs ?? (options.headless ? config.silentLoginTimeoutMs : config.loginTimeoutMs),
      }));

  const proxy = new ProxyClient(config, sessions, usage, {
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    renew: async () => {
      try {
        await doSignIn({ headless: true });
        return { ok: true };
      } catch (error) {
        debug(`silent renewal failed: ${describeError(error)}`);
        const reason = error instanceof IeeeMcpError ? error.message : describeError(error).split('\n')[0]!;
        return { ok: false, reason: reason.slice(0, 300) };
      }
    },
  });
  const fulltext = new FullText(config, http, proxy);
  return { config, http, library, fulltext, proxy, sessions, signIn: doSignIn };
}
