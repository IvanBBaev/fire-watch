/**
 * V3-P2: the event page's section registry. Every `<slot>-<name>.section.tsx` file in this
 * directory is one section of the event detail panel, found with `import.meta.glob` and
 * rendered in ascending slot order below the satellite timeline. A new section is a new
 * file at the slot `docs/V3-WORKPLAN.md` §4 gives it; nothing else is edited, so parallel
 * work never meets in `event-details.tsx`.
 *
 * Each file is its own lazy chunk (one `LAZY_ROLES` rule covers the directory, CI-12), so
 * none of the panel's sections is on the first-render or map path. The panel waits for all
 * of them and then renders them together: a section never jumps into place above one that
 * is already on screen. Once loaded they stay loaded, so the next event renders at once.
 *
 * A file name that does not parse, or two files at one slot, is a programming error and
 * throws when this module loads: the order is a contract, never a tie broken by chance.
 */

import type { FunctionComponent } from 'preact';

import type { FireEvent } from '../../../core/types.js';
import type { DetailState } from '../use-detection-summary.js';

/** What every section is given; a section reads what it needs and ignores the rest. */
export interface EventSectionProps {
  readonly event: FireEvent;
  readonly nowMs: number;
  readonly detail: DetailState;
}

export type EventSection = FunctionComponent<EventSectionProps>;

/** The shape of a section file: its component is the default export. */
export interface EventSectionModule {
  readonly default: EventSection;
}

export interface EventSectionEntry {
  readonly slot: number;
  readonly name: string;
  readonly load: () => Promise<EventSectionModule>;
}

const SECTION_FILE = /(?:^|\/)(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.section\.tsx$/;

/**
 * The glob's record as an ordered list. Throws on a file name without a three-digit slot
 * and a kebab-case name, and on two files sharing a slot.
 */
export function orderSections(
  files: Readonly<Record<string, () => Promise<EventSectionModule>>>,
): readonly EventSectionEntry[] {
  const entries: EventSectionEntry[] = [];
  const bySlot = new Map<number, string>();
  for (const [path, load] of Object.entries(files)) {
    const match = SECTION_FILE.exec(path);
    if (match === null) {
      throw new Error(`event section "${path}" is not named <slot>-<name>.section.tsx`);
    }
    const slot = Number(match[1]);
    const name = match[2] ?? '';
    const taken = bySlot.get(slot);
    if (taken !== undefined) {
      throw new Error(`event sections "${taken}" and "${name}" share slot ${String(slot)}`);
    }
    bySlot.set(slot, name);
    entries.push({ slot, name, load });
  }
  return entries.sort((a, b) => a.slot - b.slot);
}

/** The panel's sections, in slot order. */
export const EVENT_SECTIONS: readonly EventSectionEntry[] = orderSections(
  import.meta.glob<EventSectionModule>('./*.section.tsx'),
);

export interface LoadedEventSection {
  readonly slot: number;
  readonly name: string;
  readonly Section: EventSection;
}

const loaded = new WeakMap<readonly EventSectionEntry[], readonly LoadedEventSection[]>();
const pending = new WeakMap<readonly EventSectionEntry[], Promise<readonly LoadedEventSection[]>>();

/** The sections' components if every chunk has loaded, else `null`. */
export function loadedSections(
  entries: readonly EventSectionEntry[] = EVENT_SECTIONS,
): readonly LoadedEventSection[] | null {
  return loaded.get(entries) ?? null;
}

/**
 * Loads every section's chunk, once. A failed load is not cached, so the next event page
 * tries again; until then the panel shows the timeline alone.
 */
export function loadSections(
  entries: readonly EventSectionEntry[] = EVENT_SECTIONS,
): Promise<readonly LoadedEventSection[]> {
  const done = loaded.get(entries);
  if (done !== undefined) return Promise.resolve(done);
  let inFlight = pending.get(entries);
  if (inFlight === undefined) {
    inFlight = Promise.all(
      entries.map(async (entry) => ({
        slot: entry.slot,
        name: entry.name,
        Section: (await entry.load()).default,
      })),
    ).then(
      (sections) => {
        loaded.set(entries, sections);
        pending.delete(entries);
        return sections;
      },
      (error: unknown) => {
        pending.delete(entries);
        throw error;
      },
    );
    pending.set(entries, inFlight);
  }
  return inFlight;
}
