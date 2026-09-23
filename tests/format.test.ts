import { describe, expect, it } from 'vitest';
import { formatHit, formatPage, formatPaper } from '../src/format.js';
import type { Paper } from '../src/types.js';

const paper: Paper = {
  source: 'openalex',
  title: 'A Paper',
  doi: '10.1109/x.1',
  articleNumber: '123',
  openAlexId: 'W1',
  authors: [
    { name: 'A. One', affiliations: ['TU Delft'] },
    { name: 'B. Two', affiliations: [] },
    { name: 'C. Three', affiliations: [] },
    { name: 'D. Four', affiliations: [] },
    { name: 'E. Five', affiliations: [], orcid: '0000-0001' },
  ],
  abstract: 'word '.repeat(100).trim(),
  venue: 'IEEE Trans. X',
  volume: '1',
  pages: '1-10',
  year: 2020,
  citedBy: 5,
  keywords: ['k1'],
  isOpenAccess: true,
  oaPdfUrls: ['https://arxiv.org/pdf/1'],
};

describe('formatHit', () => {
  it('puts identifiers on their own line and truncates the abstract', () => {
    const lines = formatHit(paper, 3, 40).split('\n');
    expect(lines[0]).toBe('[3] A Paper (2020)');
    expect(lines[1]).toBe('    A. One, B. Two, C. Three, D. Four et al. (5 authors)');
    expect(lines[2]).toBe('    IEEE Trans. X, vol. 1, pp. 1-10 | cited by 5 | open access');
    expect(lines[3]).toBe('    DOI 10.1109/x.1 | IEEE 123 | OpenAlex W1');
    expect(lines[4]!.endsWith('...')).toBe(true);
    expect(lines[4]!.length).toBeLessThan(50);
  });
});

describe('formatPage', () => {
  it('handles unknown totals', () => {
    const output = formatPage(
      { source: 'openalex', page: 2, limit: 10, papers: [paper], hasMore: true },
      'Hits',
    );
    expect(output.split('\n')[0]).toBe('Hits: showing 11-11 (source: OpenAlex).');
    expect(output).toContain('page=3');
  });

  it('handles empty pages and notices', () => {
    const output = formatPage(
      { source: 'ieee', page: 1, limit: 10, total: 0, papers: [], notice: 'N.' },
      'Hits',
    );
    expect(output).toBe('Hits: no results on page 1 (source: IEEE Xplore API).\nNote: N.');
  });
});

describe('formatPaper abstract check', () => {
  it('flags an abstract that shares no words with the title, whatever the source', () => {
    const output = formatPaper({
      ...paper,
      source: 'ieee',
      title: 'Toward unique identifiers',
      abstract: 'Additive manufacturing with X-ray tomography.',
    });
    expect(output).toContain('may belong to a different record');
    expect(formatPaper({ ...paper, abstract: 'A Paper about papers.' })).not.toContain('different record');
  });
});

describe('formatPaper', () => {
  it('lists affiliations, access and links', () => {
    const output = formatPaper({ ...paper, isRetracted: true }, { proxy: 'https://proxy/document/123' });
    expect(output).toContain('**This paper has been retracted.**');
    expect(output).toContain(
      'Authors: A. One (TU Delft); B. Two; C. Three; D. Four; E. Five (ORCID 0000-0001)',
    );
    expect(output).toContain(
      'Access: open access (open PDF: https://arxiv.org/pdf/1) | institutional proxy configured',
    );
    expect(output).toContain(
      'Links: https://ieeexplore.ieee.org/document/123 | https://doi.org/10.1109/x.1 | https://proxy/document/123 (via your institution)',
    );
  });
});
