import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseProxyUrl } from '../src/config.js';

describe('parseProxyUrl', () => {
  it('keeps only the origin of a pasted proxy URL', () => {
    expect(parseProxyUrl('https://ieeexplore-ieee-org.tudelft.idm.oclc.org/Xplore/home.jsp')).toBe(
      'https://ieeexplore-ieee-org.tudelft.idm.oclc.org',
    );
  });

  it('accepts a bare host', () => {
    expect(parseProxyUrl('ieeexplore.ieee.org.proxy.example.edu')).toBe(
      'https://ieeexplore.ieee.org.proxy.example.edu',
    );
  });

  it('rejects http and credentials', () => {
    expect(() => parseProxyUrl('http://proxy.example.edu')).toThrow(/https/);
    expect(() => parseProxyUrl('https://user:pw@proxy.example.edu')).toThrow(/credentials/);
  });
});

describe('loadConfig', () => {
  it('uses defaults under IEEE_MCP_HOME', () => {
    const config = loadConfig({ IEEE_MCP_HOME: '/tmp/ieee-home' });
    expect(config.sessionFile).toBe(join(resolve('/tmp/ieee-home'), 'session.json'));
    expect(config.cacheDir).toBe(join(resolve('/tmp/ieee-home'), 'cache'));
    expect(config.ieeeApiKey).toBeUndefined();
    expect(config.proxyOrigin).toBeUndefined();
    expect(config.proxyDailyLimit).toBe(40);
  });

  it('reads keys and trims blanks', () => {
    const config = loadConfig({
      IEEE_MCP_HOME: '/tmp/x',
      IEEE_API_KEY: '  ',
      OPENALEX_API_KEY: 'oa-key',
      IEEE_PROXY_URL: 'https://ieeexplore-ieee-org.tudelft.idm.oclc.org/',
      IEEE_MCP_PROXY_DAILY_LIMIT: '5',
    });
    expect(config.ieeeApiKey).toBeUndefined();
    expect(config.openAlexApiKey).toBe('oa-key');
    expect(config.proxyOrigin).toBe('https://ieeexplore-ieee-org.tudelft.idm.oclc.org');
    expect(config.proxyDailyLimit).toBe(5);
  });

  it('rejects a bad daily limit', () => {
    expect(() => loadConfig({ IEEE_MCP_PROXY_DAILY_LIMIT: 'lots' })).toThrow(/non-negative integer/);
  });
});
