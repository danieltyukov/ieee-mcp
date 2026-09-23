import { describe, expect, it } from 'vitest';
import {
  cookieHeader,
  domainMatches,
  mergeCookies,
  parseSetCookie,
  pathMatches,
  type Cookie,
} from '../src/proxy/cookies.js';

const cookie = (overrides: Partial<Cookie>): Cookie => ({
  name: 'ezproxy',
  value: 'v',
  domain: '.tudelft.idm.oclc.org',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  ...overrides,
});

describe('domainMatches', () => {
  it('matches the domain and its subdomains only', () => {
    expect(domainMatches('ieeexplore-ieee-org.tudelft.idm.oclc.org', '.tudelft.idm.oclc.org')).toBe(true);
    expect(domainMatches('tudelft.idm.oclc.org', 'tudelft.idm.oclc.org')).toBe(true);
    expect(domainMatches('eviltudelft.idm.oclc.org', 'tudelft.idm.oclc.org')).toBe(false);
    expect(domainMatches('login.microsoftonline.com', '.tudelft.idm.oclc.org')).toBe(false);
  });
});

describe('pathMatches', () => {
  it('follows RFC 6265 path rules', () => {
    expect(pathMatches('/stampPDF/getPDF.jsp', '/')).toBe(true);
    expect(pathMatches('/stampPDF/getPDF.jsp', '/stampPDF')).toBe(true);
    expect(pathMatches('/stampPDFx', '/stampPDF')).toBe(false);
  });
});

describe('cookieHeader', () => {
  it('sends matching, live, secure cookies with longer paths first', () => {
    const now = 1_000_000;
    const jar = [
      cookie({ name: 'a', value: '1' }),
      cookie({ name: 'b', value: '2', path: '/stampPDF' }),
      cookie({ name: 'old', value: 'x', expires: now - 1 }),
      cookie({ name: 'other', value: 'y', domain: 'example.com' }),
    ];
    const url = new URL('https://ieeexplore-ieee-org.tudelft.idm.oclc.org/stampPDF/getPDF.jsp');
    expect(cookieHeader(jar, url, now)).toBe('b=2; a=1');
    expect(cookieHeader(jar, new URL('http://ieeexplore-ieee-org.tudelft.idm.oclc.org/'), now)).toBe('');
  });
});

describe('parseSetCookie', () => {
  const url = new URL('https://ieeexplore-ieee-org.tudelft.idm.oclc.org/Xplore/home.jsp');

  it('parses attributes', () => {
    const parsed = parseSetCookie(
      'ezproxyn=abc; Domain=tudelft.idm.oclc.org; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=60',
      url,
      1000,
    );
    expect(parsed).toEqual({
      name: 'ezproxyn',
      value: 'abc',
      domain: '.tudelft.idm.oclc.org',
      path: '/',
      expires: 1060,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
  });

  it('defaults the domain to the host and rejects foreign domains', () => {
    expect(parseSetCookie('x=1', url)?.domain).toBe('ieeexplore-ieee-org.tudelft.idm.oclc.org');
    expect(parseSetCookie('x=1; Domain=evil.com', url)).toBeUndefined();
    expect(parseSetCookie('novalue', url)).toBeUndefined();
  });

  it('treats Max-Age=0 as deletion', () => {
    const parsed = parseSetCookie('x=; Max-Age=0', url, 1000)!;
    expect(mergeCookies([cookie({ name: 'x', domain: parsed.domain })], [parsed], 1000)).toEqual([]);
  });
});

describe('mergeCookies', () => {
  it('replaces by name, domain and path', () => {
    const merged = mergeCookies(
      [cookie({ value: 'old' })],
      [cookie({ domain: 'tudelft.idm.oclc.org', value: 'new' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.value).toBe('new');
  });
});
