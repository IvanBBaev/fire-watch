/**
 * Every string an alert can contain, per locale, with its governance (TASKS H6; ADR-004
 * D7; GLOSSARY §3, §3b, §5.2).
 *
 * The catalog is data, not code, and every entry is a plain string with `{slot}` markers.
 * That is what lets three readers agree on one list: the renderer
 * (`alert-templates.ts`) fills the slots, CI-11 (`glossary-sync.test.ts` next to the
 * adapter) compares every `frozen` entry against `docs/GLOSSARY.md` with the slots mapped
 * onto the glossary's own placeholders, and the founder-review register below names
 * every `own-voice` entry that nobody has signed off yet.
 *
 * Three kinds of copy, and they are governed differently:
 *
 *   - **`frozen`** — a GLOSSARY §3/§3b/§5.2 string. Paraphrase is a CI-11 failure; the
 *     only variable parts are the glossary's own placeholders.
 *   - **`licence`** — provider wording owed verbatim on the alert footer (the credits
 *     registry's `alert-footer` surface, CI-13). Read from `@fire-watch/contracts` rather
 *     than retyped, so the text the footer carries is the text CI-13 asserts. The
 *     registry holds it in English only, so the Bulgarian footer carries the English
 *     clause as well; a Bulgarian rendering is a founder (and licence) decision.
 *   - **`own-voice`** — drafted by an implementer. **Every own-voice entry is pending
 *     founder review** ({@link ALERT_COPY_PENDING_FOUNDER_REVIEW}), and a template that
 *     uses a pending entry is not a reviewed template, so the gateway's renderer does not
 *     register it (`adapters/alerts/templates/template-renderer.ts`). Several entries
 *     reuse wording the web catalogs already ship (`tierLabel`, `eventNearPlace`, the
 *     about page's scope sentence); reuse keeps the product consistent, but an alert is a
 *     different surface — a push title is often the only text a recipient reads — so the
 *     alert use is reviewed on its own.
 */

import { CREDITS } from '@fire-watch/contracts';

export const ALERT_LOCALES = ['bg', 'en'] as const;
export type AlertLocale = (typeof ALERT_LOCALES)[number];

export type CopyGovernance = 'frozen' | 'licence' | 'own-voice';

export interface CopyEntry {
  readonly governance: CopyGovernance;
  /** Where the wording comes from — a GLOSSARY row, a credit id, or who drafted it. */
  readonly origin: string;
  readonly text: Readonly<Record<AlertLocale, string>>;
}

function licenceText(creditId: string): string {
  const credit = CREDITS.find((entry) => entry.id === creditId);
  if (credit === undefined) {
    throw new Error(`credits registry has no ${creditId}; the alert footer cannot be built`);
  }
  return credit.text;
}

const LANCE_TACTICAL = licenceText('lance-tactical-disclaimer');
const LANCE_AS_IS = licenceText('lance-as-is');

const DRAFTED = 'H6 draft, pending founder review';

export const ALERT_COPY = {
  // ── Frozen (GLOSSARY) ──────────────────────────────────────────────────────
  'frozen.active': {
    governance: 'frozen',
    origin: 'GLOSSARY §3 active',
    text: {
      en: 'Actively detected — last satellite detection {time}',
      bg: 'Активно засичане — последно сателитно засичане {time}',
    },
  },
  'frozen.officialThenRedetected': {
    governance: 'frozen',
    origin: 'GLOSSARY §3b official_then_redetected',
    text: {
      en: 'New satellite detections on {detectedAt}, after the fire was declared {officialStatus} by authorities on {statementDate} — {source}. Both facts are shown as they stand.',
      bg: 'Нови сателитни засичания на {detectedAt}, след като пожарът беше обявен за {officialStatus} от властите на {statementDate} — {source}. Показваме и двата факта; не преценяваме кой от тях е меродавен.',
    },
  },
  'frozen.officialStatus.contained': {
    governance: 'frozen',
    origin: 'GLOSSARY §3b official_then_redetected <contained|extinguished>',
    text: { en: 'contained', bg: 'локализиран' },
  },
  'frozen.officialStatus.extinguished': {
    governance: 'frozen',
    origin: 'GLOSSARY §3b official_then_redetected <contained|extinguished>',
    text: { en: 'extinguished', bg: 'ликвидиран' },
  },
  'frozen.safetyNoTravel': {
    governance: 'frozen',
    origin: 'GLOSSARY §5.2 safety_no_travel',
    text: {
      en: 'Do not travel toward the fire area — keep roads clear for responders.',
      bg: 'Не пътувайте към района на пожара — пазете пътищата свободни за спасителните екипи.',
    },
  },
  'frozen.agriBurnTag': {
    governance: 'frozen',
    origin: 'GLOSSARY §5.2 agri_burn_tag',
    text: {
      en: 'Cropland — possible agricultural burn.',
      bg: 'Земеделска земя — възможно селскостопанско палене.',
    },
  },

  // ── Licence (credits registry, alert-footer surface) ───────────────────────
  'licence.lanceTactical': {
    governance: 'licence',
    origin: 'credit lance-tactical-disclaimer',
    text: { en: LANCE_TACTICAL, bg: LANCE_TACTICAL },
  },
  'licence.lanceAsIs': {
    governance: 'licence',
    origin: 'credit lance-as-is',
    text: { en: LANCE_AS_IS, bg: LANCE_AS_IS },
  },

  // ── Own voice: footer ──────────────────────────────────────────────────────
  'footer.attribution': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Source: NASA FIRMS satellite fire detections (LANCE near-real-time data).',
      bg: 'Източник: сателитни засичания на пожари от NASA FIRMS (данни в почти реално време от LANCE).',
    },
  },
  'footer.scope': {
    governance: 'own-voice',
    origin: 'web about.paragraphs[2], reused; alert use pending founder review',
    text: {
      en: '{product} is best-effort informational monitoring, not an official warning system. For official information follow the responsible authorities; in an emergency call 112.',
      bg: '{product} е информационно наблюдение с максимални усилия, а не официална система за предупреждение. За официална информация следете отговорните институции; при спешност се обадете на 112.',
    },
  },

  // ── Own voice: shared lines ────────────────────────────────────────────────
  'tier.confirmed': {
    governance: 'own-voice',
    origin: 'web tierLabel.confirmed, reused',
    text: { en: 'Confirmed', bg: 'Потвърден' },
  },
  'tier.likely': {
    governance: 'own-voice',
    origin: 'web tierLabel.likely, reused',
    text: { en: 'Likely', bg: 'Вероятен' },
  },
  'tier.unverified': {
    governance: 'own-voice',
    origin: 'web tierLabel.unverified, reused',
    text: { en: 'Unverified', bg: 'Непотвърден' },
  },
  'line.confidence': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: 'Confidence: {tier}', bg: 'Увереност: {tier}' },
  },
  'line.unverifiedNote': {
    governance: 'own-voice',
    // Not the web's `unverifiedNote`: that one says "a single low-confidence detection",
    // and a single low-confidence detection never alerts (GLOSSARY §2 CI invariant).
    origin: DRAFTED,
    text: {
      en: 'Low confidence — this may be a false positive. Further satellite passes will clarify.',
      bg: 'Ниска увереност — може да е фалшив сигнал. Следващите сателитни наблюдения ще внесат яснота.',
    },
  },
  'line.distance': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: 'Distance from {zone}: {distance}', bg: 'Разстояние от {zone}: {distance}' },
  },
  'line.area': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Burned area estimate: {area} — source: {source}',
      bg: 'Оценка на опожарената площ: {area} — източник: {source}',
    },
  },
  'unit.distanceKm': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: '~{km} km', bg: '~{km} км' },
  },
  'zone.default': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: 'your watch zone', bg: 'вашата зона за наблюдение' },
  },
  'zone.named': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: '“{label}”', bg: '„{label}“' },
  },
  'event.nearPlace': {
    governance: 'own-voice',
    origin: 'web eventNearPlace, reused',
    text: { en: 'Fire near {place}', bg: 'Пожар край {place}' },
  },
  'source.withLink': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: '{label} ({url})', bg: '{label} ({url})' },
  },

  // ── Own voice: new_fire ────────────────────────────────────────────────────
  'newFire.title': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Satellite fire detection near {place}',
      bg: 'Сателитно засичане на пожар край {place}',
    },
  },

  // ── Own voice: escalation ──────────────────────────────────────────────────
  'escalation.title': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Update: satellite fire detection near {place}',
      bg: 'Актуализация: сателитно засичане на пожар край {place}',
    },
  },
  'escalation.scoreUpgrade': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: 'Confidence raised to {tier}.', bg: 'Увереността е повишена до „{tier}“.' },
  },
  'escalation.areaDoubling': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'The burned area estimate has at least doubled since the last alert.',
      bg: 'Оценката за опожарената площ се е увеличила поне двойно от последното известие.',
    },
  },
  'escalation.redetected': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Satellites are detecting this fire again.',
      bg: 'Сателитите отново засичат този пожар.',
    },
  },
  'escalation.reignition': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'New satellite detections near an archived fire — possible reignition.',
      bg: 'Нови сателитни засичания край архивиран пожар — възможно повторно разгаряне.',
    },
  },

  // ── Own voice: digest ──────────────────────────────────────────────────────
  'digest.title': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: 'Daily summary — {dateTime}', bg: 'Дневно обобщение — {dateTime}' },
  },
  'digest.introOne': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Satellite fire detections for {zone} — 1 event:',
      bg: 'Сателитни засичания на пожари за {zone} — 1 събитие:',
    },
  },
  'digest.introMany': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: 'Satellite fire detections for {zone} — {count} events:',
      bg: 'Сателитни засичания на пожари за {zone} — {count} събития:',
    },
  },
  'digest.entry': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      en: '• {nearPlace} · {distance} · {tier} · observed {dateTime}',
      bg: '• {nearPlace} · {distance} · {tier} · засечено {dateTime}',
    },
  },
  'digest.more': {
    governance: 'own-voice',
    origin: DRAFTED,
    text: { en: '+{count} more in the app', bg: '+{count} още в приложението' },
  },
} as const satisfies Record<string, CopyEntry>;

export type AlertCopyKey = keyof typeof ALERT_COPY;

export const ALERT_COPY_KEYS = Object.keys(ALERT_COPY) as AlertCopyKey[];

/**
 * Alert copy awaiting founder review. Asserted exactly by `alert-templates.test.ts`, so
 * adding a draft or clearing one after review is always a visible edit there as well.
 * Only own-voice copy can be pending — a frozen glossary line or licence wording is never
 * drafted here — and today that is all of it.
 */
export const ALERT_COPY_PENDING_FOUNDER_REVIEW: readonly AlertCopyKey[] = ALERT_COPY_KEYS.filter(
  (key) => ALERT_COPY[key].governance === 'own-voice',
);

/**
 * Fills `{slot}` markers. Throws on a slot the caller did not bind and on a bound value
 * the template has no slot for, so a renamed slot fails loudly instead of rendering a
 * literal `{place}` to a phone.
 */
export function fillCopy(
  key: AlertCopyKey,
  locale: AlertLocale,
  slots: Readonly<Record<string, string>> = {},
): string {
  const template: string = ALERT_COPY[key].text[locale];
  const used = new Set<string>();
  const filled = template.replace(/\{([a-zA-Z]+)\}/gu, (_marker, name: string) => {
    const value = slots[name];
    if (value === undefined) throw new Error(`copy ${key} needs slot {${name}}`);
    used.add(name);
    return value;
  });
  for (const name of Object.keys(slots)) {
    if (!used.has(name)) throw new Error(`copy ${key} has no slot {${name}}`);
  }
  return filled;
}
