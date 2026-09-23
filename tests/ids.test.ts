import { describe, expect, it } from 'vitest';
import { normalizeDoi, parsePaperId } from '../src/ids.js';

describe('normalizeDoi', () => {
  it.each([
    ['10.1109/5.771073', '10.1109/5.771073'],
    ['doi:10.1109/JSSC.2020.3024785', '10.1109/jssc.2020.3024785'],
    ['https://doi.org/10.1109/5.771073', '10.1109/5.771073'],
    ['http://dx.doi.org/10.1109/5.771073.', '10.1109/5.771073'],
    ['https://doi.org/10.1109%2F5.771073', '10.1109/5.771073'],
  ])('%s', (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it('rejects non-DOIs', () => {
    expect(normalizeDoi('771073')).toBeUndefined();
    expect(normalizeDoi('11.1109/5.771073')).toBeUndefined();
  });
});

describe('parsePaperId', () => {
  it.each([
    ['10.1109/5.771073', { kind: 'doi', doi: '10.1109/5.771073' }],
    ['771073', { kind: 'ieee', articleNumber: '771073' }],
    ['https://ieeexplore.ieee.org/document/9063000/', { kind: 'ieee', articleNumber: '9063000' }],
    ['https://ieeexplore.ieee.org/abstract/document/9063000', { kind: 'ieee', articleNumber: '9063000' }],
    [
      'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=771073',
      { kind: 'ieee', articleNumber: '771073' },
    ],
    [
      'https://ieeexplore.ieee.org/xpls/abs_all.jsp?arnumber=771073',
      { kind: 'ieee', articleNumber: '771073' },
    ],
    [
      'https://ieeexplore-ieee-org.tudelft.idm.oclc.org/document/771073',
      { kind: 'ieee', articleNumber: '771073' },
    ],
    [
      'https://ieeexplore.ieee.org.proxy.library.example.edu/document/771073',
      { kind: 'ieee', articleNumber: '771073' },
    ],
    ['https://doi-org.tudelft.idm.oclc.org/10.1109/5.771073', { kind: 'doi', doi: '10.1109/5.771073' }],
    ['W2156186462', { kind: 'openalex', id: 'W2156186462' }],
    ['https://openalex.org/W2156186462', { kind: 'openalex', id: 'W2156186462' }],
    ['https://api.openalex.org/works/w2156186462', { kind: 'openalex', id: 'W2156186462' }],
  ])('%s', (input, expected) => {
    expect(parsePaperId(input)).toEqual(expected);
  });

  it('explains what it accepts on bad input', () => {
    expect(() => parsePaperId('not a paper')).toThrow(/DOI .* IEEE article number/);
    expect(() => parsePaperId('   ')).toThrow(/required/);
    expect(() => parsePaperId('https://example.com/paper')).toThrow(/Could not read/);
  });

  it('only trusts IEEE Xplore hosts, not look-alikes', () => {
    expect(() => parsePaperId('https://ieee.org.evil.example/document/123')).toThrow(/Could not read/);
    expect(() => parsePaperId('https://evil.example/ieeexplore.ieee.org/document/123')).toThrow(
      /Could not read/,
    );
    expect(() => parsePaperId('https://notieeexplore.ieee.org.example/document/123')).toThrow(
      /Could not read/,
    );
    expect(() => parsePaperId('https://undoi.org.example/10.1109/5.771073')).toThrow(/Could not read/);
  });
});
