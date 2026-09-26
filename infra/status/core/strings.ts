/**
 * Every word the status page can print, in both languages, in one place (TASKS J5).
 *
 * **Review state: PENDING FOUNDER REVIEW.** None of this copy has been through the founder
 * or the CI-11 wording review yet; it is a first draft that already passes the never-send
 * lint (`strings.test.ts` runs every message, in both languages, through the same
 * `lintAlertText` the alert templates and the web catalogs use — OPERATIONS §10.4: "the
 * never-send list and wording contract apply to it verbatim"). The product name is a
 * placeholder too: it waits on name clearance (EXTERNAL-ACCOUNTS row 21).
 *
 * Rules the copy follows, so a reviewer can check them rather than infer them:
 *
 *   - It describes *our service*, never a fire. "Operational" is a claim about a probe
 *     target; nothing here says anything about fires, areas or danger (§10.4).
 *   - It never names a transport tier, host or vendor ("R2", "Cloudflare", "T2"); the
 *     backup copy is "a backup copy of the map data" (GLOSSARY §3b "one degraded slot": the
 *     user learns how old the data is, never which tier they are on).
 *   - Every degraded sentence says what the reader can still rely on, or that we do not
 *     know — never a softer word for the same outage.
 *   - Placeholders are `{name}`; both languages must use exactly the same set (tested).
 */

import type { FreshnessRowId } from '../../../packages/contracts/src/freshness.js';
import type { ComponentId, ComponentLevel, ReasonCode, SourceLevel } from './status-model.js';

export const LOCALES = ['bg', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** Bulgarian first: the product's primary audience (the web app defaults the same way). */
export const DEFAULT_LOCALE: Locale = 'bg';

export const COPY_REVIEW_STATE = 'pending-founder-review' as const;

/** Placeholder until name clearance (EXTERNAL-ACCOUNTS row 21). */
export const PRODUCT_NAME = 'Fire Watch';

export interface Messages {
  readonly pageTitle: string;
  readonly heading: string;
  readonly languageName: string;
  readonly otherLanguageLink: string;
  readonly overall: Readonly<Record<ComponentLevel, string>>;
  readonly level: Readonly<Record<ComponentLevel, string>>;
  readonly component: Readonly<Record<ComponentId, string>>;
  readonly reason: Readonly<Record<ReasonCode, string>>;
  readonly unconfirmed: string;
  readonly since: string;
  readonly dataAge: string;
  readonly dataAgeUnknown: string;
  readonly componentsHeading: string;
  readonly sourcesHeading: string;
  readonly sourcesUnavailable: string;
  readonly sourceLevel: Readonly<Record<SourceLevel, string>>;
  /**
   * A reader-facing name per freshness row. Keyed by the contract's row ids, so a row added
   * to the contract is a compile error here until someone names it; a row this build does
   * not know yet is shown by its canonical id rather than hidden.
   */
  readonly source: Readonly<Record<FreshnessRowId, string>>;
  readonly sourceLastSuccess: string;
  readonly mutedUntil: string;
  readonly noticesHeading: string;
  readonly noNotices: string;
  readonly noticeIncident: string;
  readonly noticeMaintenance: string;
  readonly noticeResolved: string;
  readonly checkedAt: string;
  readonly pageStale: string;
  readonly refreshHint: string;
  readonly secondChannel: string;
  readonly scope: string;
  readonly timeZoneNote: string;
  readonly minutes: string;
  readonly hours: string;
  readonly seconds: string;
}

const en: Messages = {
  pageTitle: `${PRODUCT_NAME} — service status`,
  heading: `${PRODUCT_NAME} service status`,
  languageName: 'English',
  otherLanguageLink: 'Български',
  overall: {
    operational: 'All monitored parts of the service are working normally.',
    unknown: 'We cannot currently confirm the state of every part of the service.',
    degraded: 'Part of the service is degraded.',
    outage: 'Part of the service is unavailable.',
  },
  level: {
    operational: 'Working normally',
    unknown: 'Unknown',
    degraded: 'Degraded',
    outage: 'Unavailable',
  },
  component: {
    api: 'Service',
    map: 'Map data',
    'map-backup': 'Backup copy of the map data',
    'data-freshness': 'Satellite data feeds',
  },
  reason: {
    up: 'Responding.',
    fresh: 'Updating on schedule.',
    stale: 'Updates are delayed — the last available data is shown.',
    future_stamp: 'The data carries a time in the future; we are checking our clocks.',
    unreachable: 'Our external monitor could not reach it.',
    http_status: 'It answered with an error.',
    bad_body: 'It answered with data our monitor could not read.',
    missing: 'It could not be found.',
    no_age_signal: 'Its age cannot be determined, so we cannot vouch for it.',
    report_ok: 'All feeds are within their expected delay.',
    report_warn: 'Some feeds are delayed.',
    report_critical: 'At least one feed is well past its expected delay.',
    endpoint_error: 'The feed check itself is failing.',
    not_configured: 'Not monitored yet.',
  },
  unconfirmed: 'First failed check — waiting for a second check to confirm.',
  since: 'Since {time}',
  dataAge: 'Map data last updated at {time} ({age} ago).',
  dataAgeUnknown: 'We cannot currently tell how old the map data is.',
  componentsHeading: 'Service components',
  sourcesHeading: 'Data feeds',
  sourcesUnavailable: 'The per-feed breakdown is not available right now.',
  sourceLevel: {
    on_time: 'On time',
    delayed: 'Delayed',
    severely_delayed: 'Severely delayed',
    muted: 'Known provider outage',
    no_data: 'No data received yet',
  },
  source: {
    'firms:viirs:snpp': 'VIIRS satellite detections (Suomi NPP)',
    'firms:viirs:noaa20': 'VIIRS satellite detections (NOAA-20)',
    'firms:viirs:noaa21': 'VIIRS satellite detections (NOAA-21)',
    'lsasaf:seviri:frp-pixel': 'Geostationary satellite detections (SEVIRI)',
    'lsasaf:fci:frp-pixel': 'Geostationary satellite detections (FCI)',
    'eumetsat:slstr:frp': 'Sentinel-3 satellite detections (SLSTR)',
    'eumetsat:clm': 'Cloud mask',
    'effis:layers': 'EFFIS map layers',
    'weather:context': 'Weather context',
    'snapshot-push': 'Map data publishing',
    'nightly-backup': 'Nightly backup',
    'wal-archive': 'Continuous backup',
    'effis-refresh': 'EFFIS layer refresh',
  },
  sourceLastSuccess: 'last received {age} ago',
  mutedUntil: 'expected until {time}',
  noticesHeading: 'Incidents and planned maintenance',
  noNotices: 'No notices at the moment.',
  noticeIncident: 'Incident',
  noticeMaintenance: 'Planned maintenance',
  noticeResolved: 'Resolved {time}',
  checkedAt: 'Last checked at {time}.',
  pageStale:
    'This page has not been updated for more than {minutes} minutes. The information on it may no longer be current.',
  refreshHint: 'This page refreshes itself every few minutes.',
  secondChannel: 'If this page is unavailable, updates are posted at {channel}.',
  scope: `${PRODUCT_NAME} is best-effort informational monitoring, not an official warning system. In an emergency call 112.`,
  timeZoneNote: 'Times are in UTC.',
  minutes: '{n} min',
  hours: '{n} h {m} min',
  seconds: '{n} s',
};

const bg: Messages = {
  pageTitle: `${PRODUCT_NAME} — състояние на услугата`,
  heading: `Състояние на услугата ${PRODUCT_NAME}`,
  languageName: 'Български',
  otherLanguageLink: 'English',
  overall: {
    operational: 'Всички наблюдавани части на услугата работят нормално.',
    unknown: 'В момента не можем да потвърдим състоянието на всички части на услугата.',
    degraded: 'Част от услугата работи със затруднения.',
    outage: 'Част от услугата е недостъпна.',
  },
  level: {
    operational: 'Работи нормално',
    unknown: 'Неизвестно',
    degraded: 'Със затруднения',
    outage: 'Недостъпно',
  },
  component: {
    api: 'Услуга',
    map: 'Данни за картата',
    'map-backup': 'Резервно копие на данните за картата',
    'data-freshness': 'Потоци сателитни данни',
  },
  reason: {
    up: 'Отговаря.',
    fresh: 'Обновява се по график.',
    stale: 'Обновяването закъснява — показват се последните налични данни.',
    future_stamp: 'Данните носят час в бъдещето; проверяваме часовниците си.',
    unreachable: 'Външният ни монитор не успя да се свърже.',
    http_status: 'Отговори с грешка.',
    bad_body: 'Отговори с данни, които мониторът ни не можа да прочете.',
    missing: 'Не беше намерено.',
    no_age_signal:
      'Възрастта на данните не може да се определи, затова не можем да гарантираме за тях.',
    report_ok: 'Всички потоци са в рамките на очакваното закъснение.',
    report_warn: 'Някои потоци закъсняват.',
    report_critical: 'Поне един поток значително надхвърля очакваното закъснение.',
    endpoint_error: 'Самата проверка на потоците не работи.',
    not_configured: 'Все още не се наблюдава.',
  },
  unconfirmed: 'Първа неуспешна проверка — изчакваме втора за потвърждение.',
  since: 'От {time}',
  dataAge: 'Данните за картата са обновени последно в {time} (преди {age}).',
  dataAgeUnknown: 'В момента не можем да определим колко стари са данните за картата.',
  componentsHeading: 'Компоненти на услугата',
  sourcesHeading: 'Потоци данни',
  sourcesUnavailable: 'Разбивката по потоци в момента не е налична.',
  sourceLevel: {
    on_time: 'Навреме',
    delayed: 'Закъснява',
    severely_delayed: 'Силно закъснява',
    muted: 'Известен проблем при доставчика',
    no_data: 'Все още няма получени данни',
  },
  source: {
    'firms:viirs:snpp': 'Сателитни засичания VIIRS (Suomi NPP)',
    'firms:viirs:noaa20': 'Сателитни засичания VIIRS (NOAA-20)',
    'firms:viirs:noaa21': 'Сателитни засичания VIIRS (NOAA-21)',
    'lsasaf:seviri:frp-pixel': 'Засичания от геостационарен спътник (SEVIRI)',
    'lsasaf:fci:frp-pixel': 'Засичания от геостационарен спътник (FCI)',
    'eumetsat:slstr:frp': 'Сателитни засичания Sentinel-3 (SLSTR)',
    'eumetsat:clm': 'Облачна маска',
    'effis:layers': 'Слоеве на EFFIS',
    'weather:context': 'Метеорологичен контекст',
    'snapshot-push': 'Публикуване на данните за картата',
    'nightly-backup': 'Нощно резервно копие',
    'wal-archive': 'Непрекъснато архивиране',
    'effis-refresh': 'Обновяване на слоевете на EFFIS',
  },
  sourceLastSuccess: 'последно получени преди {age}',
  mutedUntil: 'очаквано до {time}',
  noticesHeading: 'Инциденти и планирана поддръжка',
  noNotices: 'В момента няма съобщения.',
  noticeIncident: 'Инцидент',
  noticeMaintenance: 'Планирана поддръжка',
  noticeResolved: 'Приключен в {time}',
  checkedAt: 'Последна проверка в {time}.',
  pageStale:
    'Тази страница не е обновявана повече от {minutes} минути. Информацията в нея може вече да не е актуална.',
  refreshHint: 'Страницата се обновява сама на няколко минути.',
  secondChannel: 'Ако тази страница е недостъпна, новините се публикуват на {channel}.',
  scope: `${PRODUCT_NAME} е информационно наблюдение с максимални усилия, а не официална система за предупреждение. При спешност се обадете на 112.`,
  timeZoneNote: 'Часовете са в UTC.',
  minutes: '{n} мин',
  hours: '{n} ч {m} мин',
  seconds: '{n} сек',
};

export const CATALOG: Readonly<Record<Locale, Messages>> = { bg, en };

/** The reader-facing name of a freshness row, or its canonical id when this build has none. */
export function sourceLabel(messages: Messages, row: string): string {
  return Object.hasOwn(messages.source, row)
    ? ((messages.source as Readonly<Record<string, string>>)[row] ?? row)
    : row;
}

/** `{name}` → value. A placeholder with no value is left visible, never silently dropped. */
export function format(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** Every leaf string of a catalog, keyed by dotted path — what the tests lint and compare. */
export function flattenMessages(messages: Messages): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === 'string') {
      out.set(prefix, value);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        walk(prefix === '' ? key : `${prefix}.${key}`, child);
      }
    }
  };
  walk('', messages);
  return out;
}
