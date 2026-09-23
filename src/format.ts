import { titleCoverage } from './text.js';
import type { Paper, SearchPage } from './types.js';

const SOURCE_NAME = { ieee: 'IEEE Xplore API', openalex: 'OpenAlex' } as const;

function authorList(paper: Paper, max: number): string {
  const names = paper.authors.map((a) => a.name);
  if (!names.length) return 'Unknown authors';
  return names.length > max
    ? `${names.slice(0, max).join(', ')} et al. (${names.length} authors)`
    : names.join(', ');
}

function ids(paper: Paper): string {
  const parts: string[] = [];
  if (paper.doi) parts.push(`DOI ${paper.doi}`);
  if (paper.articleNumber) parts.push(`IEEE ${paper.articleNumber}`);
  if (paper.openAlexId) parts.push(`OpenAlex ${paper.openAlexId}`);
  return parts.join(' | ');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max)}...`;
}

function venueLine(paper: Paper): string | undefined {
  const parts: string[] = [];
  if (paper.venue) parts.push(paper.venue);
  if (paper.volume) parts.push(`vol. ${paper.volume}`);
  if (paper.issue) parts.push(`no. ${paper.issue}`);
  if (paper.pages) parts.push(`pp. ${paper.pages}`);
  return parts.length ? parts.join(', ') : undefined;
}

function flags(paper: Paper): string[] {
  const out: string[] = [];
  if (paper.citedBy !== undefined) out.push(`cited by ${paper.citedBy}`);
  if (paper.isOpenAccess) out.push('open access');
  if (paper.isRetracted) out.push('RETRACTED');
  return out;
}

/** One search hit: identifiers first so follow-up calls can reuse them. */
export function formatHit(paper: Paper, index: number, abstractChars = 280): string {
  const lines = [`[${index}] ${paper.title}${paper.year ? ` (${paper.year})` : ''}`];
  lines.push(`    ${authorList(paper, 4)}`);
  const venue = venueLine(paper);
  const meta = [venue, paper.contentType, ...flags(paper)].filter(Boolean).join(' | ');
  if (meta) lines.push(`    ${meta}`);
  const id = ids(paper);
  if (id) lines.push(`    ${id}`);
  if (paper.abstract && abstractChars > 0) lines.push(`    ${truncate(paper.abstract, abstractChars)}`);
  return lines.join('\n');
}

export function formatPage(
  page: SearchPage,
  heading: string,
  options: { abstractChars?: number } = {},
): string {
  const first = (page.page - 1) * page.limit + 1;
  const last = first + page.papers.length - 1;
  const lines: string[] = [];
  const source = `source: ${SOURCE_NAME[page.source]}`;
  if (!page.papers.length) lines.push(`${heading}: no results on page ${page.page} (${source}).`);
  else if (page.total === undefined) lines.push(`${heading}: showing ${first}-${last} (${source}).`);
  else
    lines.push(
      `${heading}: ${page.total.toLocaleString('en-US')} total, showing ${first}-${last} (${source}).`,
    );
  if (page.notice) lines.push(`Note: ${page.notice}`);
  lines.push('');
  page.papers.forEach((paper, i) => {
    lines.push(formatHit(paper, first + i, options.abstractChars));
    lines.push('');
  });
  const more = page.total === undefined ? page.hasMore : last < page.total && page.papers.length > 0;
  if (more) {
    lines.push(`More results: call again with page=${page.page + 1}.`);
  }
  return lines.join('\n').trimEnd();
}

export interface PaperLinks {
  proxy?: string;
}

export function formatPaper(paper: Paper, links: PaperLinks = {}): string {
  const lines = [`# ${paper.title}`];
  if (paper.isRetracted) lines.push('**This paper has been retracted.**');
  lines.push('');
  const withAffiliations = paper.authors.slice(0, 25).map((a) => {
    const extra = [a.affiliations.join('; '), a.orcid ? `ORCID ${a.orcid}` : ''].filter(Boolean).join(', ');
    return extra ? `${a.name} (${extra})` : a.name;
  });
  if (paper.authors.length > 25) withAffiliations.push(`and ${paper.authors.length - 25} more`);
  lines.push(`Authors: ${withAffiliations.join('; ') || 'Unknown'}`);
  const venue = venueLine(paper);
  if (venue) lines.push(`Published in: ${venue}`);
  if (paper.conference?.location || paper.conference?.dates) {
    lines.push(
      `Conference: ${[paper.conference.location, paper.conference.dates].filter(Boolean).join(', ')}`,
    );
  }
  const when = paper.date ?? (paper.year ? String(paper.year) : undefined);
  if (when) lines.push(`Date: ${when}`);
  if (paper.contentType) lines.push(`Type: ${paper.contentType}`);
  if (paper.publisher) lines.push(`Publisher: ${paper.publisher}`);
  lines.push(`Identifiers: ${ids(paper) || 'none'}`);
  const counts: string[] = [];
  if (paper.citedBy !== undefined) counts.push(`cited by ${paper.citedBy} papers`);
  if (paper.patentCitations) counts.push(`${paper.patentCitations} patents`);
  if (paper.referencesCount !== undefined) counts.push(`${paper.referencesCount} references`);
  if (counts.length) lines.push(`Citations: ${counts.join(', ')}`);
  const access =
    paper.isOpenAccess === undefined ? 'unknown' : paper.isOpenAccess ? 'open access' : 'subscription';
  lines.push(
    `Access: ${access}${
      paper.oaPdfUrls.length
        ? ` (open PDF: ${paper.oaPdfUrls[0]})`
        : paper.oaLandingUrls?.length
          ? ` (open copy: ${paper.oaLandingUrls[0]})`
          : ''
    }${links.proxy ? ' | institutional proxy configured' : ''}`,
  );
  if (paper.keywords.length) lines.push(`Keywords: ${paper.keywords.join(', ')}`);
  const urls: string[] = [];
  if (paper.articleNumber) urls.push(`https://ieeexplore.ieee.org/document/${paper.articleNumber}`);
  if (paper.doi) urls.push(`https://doi.org/${paper.doi}`);
  if (links.proxy) urls.push(`${links.proxy} (via your institution)`);
  if (urls.length) lines.push(`Links: ${urls.join(' | ')}`);
  lines.push('');
  if (paper.abstract) {
    // OpenAlex occasionally attaches another work's abstract, also to records merged with IEEE
    // data; say so rather than present it as fact. A genuine abstract shares words with its title.
    if (titleCoverage(paper.title, paper.abstract) === 0) {
      lines.push('Note: this abstract shares no words with the title and may belong to a different record.');
    }
    lines.push(`Abstract: ${paper.abstract}`);
  } else lines.push('Abstract: not available from the metadata sources.');
  lines.push('');
  lines.push(
    `Source: ${SOURCE_NAME[paper.source]}${paper.source === 'ieee' && paper.openAlexId ? ' with OpenAlex' : ''}.`,
  );
  return lines.join('\n');
}

export function formatPaperRef(paper: Paper): string {
  return `"${paper.title}"${paper.year ? ` (${paper.year})` : ''}, ${ids(paper)}`;
}
