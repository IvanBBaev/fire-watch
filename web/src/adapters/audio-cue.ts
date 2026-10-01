/**
 * The optional new-signal sound (TASKS F): a short, soft two-tone chime synthesised with
 * Web Audio, so it costs no asset bytes. Browsers block audio until the reader interacts
 * with the page, and this adapter never fights that: the audio context is created and
 * resumed only inside a user gesture (the Settings toggle, or the first pointer/key press
 * of a visit while the cue is switched on), and a cue asked for while the context is not
 * running is dropped silently rather than queued for later.
 */

import type { AudioCue } from '../ui/new-signals.js';

const VOLUME = 0.06;
const TONES_HZ = [660, 880] as const;
const TONE_S = 0.14;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** `wanted` is read at gesture time: a visit with the cue off never creates a context. */
export function createBrowserAudioCue(wanted: () => boolean): AudioCue {
  let context: AudioContext | null = null;

  const unlock = (): void => {
    try {
      if (context === null) {
        const Ctor = audioContextConstructor();
        if (Ctor === null) return;
        context = new Ctor();
      }
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch {
      context = null;
    }
  };

  const onGesture = (): void => {
    if (!wanted()) return;
    unlock();
    if (context !== null) {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    }
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  return {
    unlock,
    play() {
      const ctx = context;
      if (ctx === null || ctx.state !== 'running') return;
      try {
        const start = ctx.currentTime;
        TONES_HZ.forEach((hz, index) => {
          const at = start + index * TONE_S;
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = hz;
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(VOLUME, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + TONE_S);
          oscillator.connect(gain).connect(ctx.destination);
          oscillator.start(at);
          oscillator.stop(at + TONE_S + 0.02);
        });
      } catch {
        // A cue is a courtesy; a failing audio stack must never disturb the page.
      }
    },
  };
}
