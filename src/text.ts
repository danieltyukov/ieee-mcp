const STOP_WORDS = new Set([
  'with',
  'from',
  'using',
  'based',
  'toward',
  'towards',
  'into',
  'over',
  'under',
  'their',
  'this',
  'that',
  'via',
  'and',
  'for',
  'the',
]);

/** Lower-case ASCII words, accents removed. */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words of a title that identify it, ignoring short and common ones. */
export function titleWords(title: string): string[] {
  const all = words(title);
  const significant = all.filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return significant.length >= 2 ? significant : all.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Share of the title's identifying words that occur in the text (1 when the title has none). */
export function titleCoverage(title: string, text: string): number {
  const wanted = titleWords(title);
  if (!wanted.length) return 1;
  const present = new Set(words(text));
  return wanted.filter((w) => present.has(w)).length / wanted.length;
}
