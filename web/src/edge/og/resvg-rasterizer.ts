/**
 * The og:image rasteriser (TASKS V2-D4): resvg compiled to WebAssembly.
 *
 * Why this one: it is a pure-WASM build (`@resvg/resvg-wasm`, MPL-2.0) with no runtime
 * dependencies and no install scripts, so it needs no native toolchain and runs unchanged
 * in a Pages Function and in Node; it renders SVG text with the fonts it is handed and
 * never with the host's, which is what makes the same SVG come out as the same PNG
 * everywhere. A headless browser would draw the card the way the reader's device does,
 * but cannot run at the edge.
 *
 * Fonts: the card's SVG asks for the system sans-serif stack, which names Noto Sans. The
 * edge has no system fonts, so it carries subsets of Noto Sans Regular and Bold (Latin,
 * Latin-1, Cyrillic, general punctuation; SIL OFL 1.1, `fonts/OFL.txt`) as raw buffers.
 * They are never part of the browser build (CI-12 forbids webfonts there).
 *
 * The WASM module is initialised once per isolate; `initWasm` may only be called once.
 */

import { initWasm, Resvg, type InitInput } from '@resvg/resvg-wasm';

export interface ResvgRasterizerOptions {
  /** The compiled `index_bg.wasm`: a `WebAssembly.Module` at the edge, bytes in Node. */
  readonly wasm: InitInput | Promise<InitInput>;
  /** Raw TTF/OTF buffers; the first family is the fallback for any unmatched name. */
  readonly fonts: readonly Uint8Array[];
  readonly defaultFontFamily: string;
}

let initialised: Promise<void> | null = null;

/**
 * Initialises the WASM module at most once. A failed initialisation is forgotten, so the
 * next request retries rather than every request failing for the isolate's lifetime.
 */
function ensureInitialised(wasm: ResvgRasterizerOptions['wasm']): Promise<void> {
  initialised ??= initWasm(wasm).catch((error: unknown) => {
    initialised = null;
    throw error;
  });
  return initialised;
}

export function createResvgRasterizer(
  options: ResvgRasterizerOptions,
): (svg: string) => Promise<Uint8Array> {
  return async (svg) => {
    await ensureInitialised(options.wasm);
    const resvg = new Resvg(svg, {
      font: {
        fontBuffers: [...options.fonts],
        defaultFontFamily: options.defaultFontFamily,
        sansSerifFamily: options.defaultFontFamily,
      },
      fitTo: { mode: 'original' },
      shapeRendering: 2,
      textRendering: 1,
    });
    try {
      const rendered = resvg.render();
      try {
        return rendered.asPng();
      } finally {
        rendered.free();
      }
    } finally {
      resvg.free();
    }
  };
}
