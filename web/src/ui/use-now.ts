/**
 * A ticking "now" for relative ages ("N min ago") — epoch ms read through a `ServerNow`
 * reader (the feed's server-corrected clock, ADR-003 A1.6), re-armed with setTimeout
 * (the one scheduling primitive shipped code may use). Minute-granularity copy only
 * needs a coarse tick.
 */

import { useEffect, useState } from 'preact/hooks';

import type { ServerNow } from '../core/ports.js';

export const DEFAULT_NOW_TICK_MS = 30_000;

export function useNow(readNow: ServerNow, periodMs: number = DEFAULT_NOW_TICK_MS): number {
  const [now, setNow] = useState<number>(() => readNow());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      timer = setTimeout(() => {
        setNow(readNow());
        arm();
      }, periodMs);
    };
    arm();
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [readNow, periodMs]);
  return now;
}
