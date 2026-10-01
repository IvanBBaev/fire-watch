/**
 * Bulgarian ↔ Latin for settlement search. The official Streamlined System
 * (Transliteration Act 2009) for display, and a lossy *fold* for matching, so a reader
 * typing "Sofiya", "Elkhovo", "Veliko Tŭrnovo" or "софия" finds the same place.
 *
 * `infra/geodata/transform.ts` carries the same table to decide which GeoNames Latin
 * names are worth storing as aliases; a drift between the two costs an alias, never a
 * result, because the Cyrillic name is always folded here at runtime.
 */

const STREAMLINED: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

/**
 * Case-preserving Streamlined transliteration for display ("Велико Търново" →
 * "Veliko Tarnovo", "София" → "Sofia"). The Act's one positional rule — word-final
 * "ия" is "ia" — is applied; everything else is a per-letter table.
 */
export function transliterate(text: string): string {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const lower = ch.toLowerCase();
    const next = chars[i + 1];
    const afterNext = chars[i + 2];
    if (
      lower === 'и' &&
      next !== undefined &&
      next.toLowerCase() === 'я' &&
      (afterNext === undefined || !/\p{L}/u.test(afterNext))
    ) {
      out += ch === lower ? 'ia' : 'Ia';
      i++;
      continue;
    }
    const latin = STREAMLINED[lower];
    if (latin === undefined) {
      out += ch;
    } else if (ch === lower) {
      out += latin;
    } else {
      // Capital: only the first letter of a digraph is upper-cased ("Жеравна" → "Zheravna").
      out += latin.charAt(0).toUpperCase() + latin.slice(1);
    }
  }
  return out;
}

/**
 * The search key: Streamlined Latin, lower case, no diacritics, punctuation to single
 * spaces, plus three folds so the other romanisations people use meet the Streamlined
 * one: `ŭ`→`a` (BGN/PCGN and scholarly `ъ`), `kh`→`h` (BGN `х`) and `iya`→`ia` (the
 * Act's word-final rule, applied everywhere so "Sofiya" meets "Sofia").
 */
export function foldName(name: string): string {
  const lower = name.toLowerCase();
  let latin = '';
  for (const ch of lower) latin += STREAMLINED[ch] ?? ch;
  return latin
    .replace(/ŭ/g, 'a')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/kh/g, 'h')
    .replace(/iya/g, 'ia')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
