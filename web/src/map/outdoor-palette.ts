/**
 * Colours of the self-hosted outdoor basemap (TASKS G3), one token set per theme.
 *
 * Muted on purpose: the basemap is the ground the fire layers stand on, so it carries no
 * hue from the reserved fire bands (CI-14, review 06 §5.4 — OKLCH h ∈ [20°, 55°] ∪
 * [350°, 360°] above C 0.09) and nothing close to the fire palette. Highways, which most
 * basemaps paint orange, are pale neutral here. Forest is the one emphasised land class —
 * the product is about wildland fire, so woodland is what the reader most needs to see.
 *
 * Colours are plain hex literals so the CI-14 source walk reads them where they are
 * written; `outdoor-style.test.ts` and the CI-14 gate both check the built style.
 */

import type { ThemeName } from '../core/types.js';

export interface OutdoorPalette {
  readonly land: string;
  readonly water: string;
  readonly waterway: string;
  readonly forest: string;
  readonly park: string;
  readonly grass: string;
  readonly farmland: string;
  readonly urban: string;
  readonly barren: string;
  readonly glacier: string;
  readonly protectedOutline: string;
  readonly building: string;
  readonly path: string;
  readonly roadMinor: string;
  readonly roadMajor: string;
  readonly roadCasing: string;
  readonly highway: string;
  readonly highwayCasing: string;
  readonly boundaryCountry: string;
  readonly boundaryRegion: string;
  readonly text: string;
  readonly textMuted: string;
  readonly waterText: string;
  readonly halo: string;
  readonly hillshadeShadow: string;
  readonly hillshadeHighlight: string;
  readonly hillshadeAccent: string;
}

export const OUTDOOR_PALETTES: Readonly<Record<ThemeName, OutdoorPalette>> = {
  light: {
    land: '#f2f1ec',
    water: '#b9d3e6',
    waterway: '#9dbfd9',
    forest: '#c6dcb8',
    park: '#dde8d2',
    grass: '#e4ebd6',
    farmland: '#eeeee2',
    urban: '#e6e4e0',
    barren: '#ece9dc',
    glacier: '#f4f8fb',
    protectedOutline: '#7fa37a',
    building: '#dedbd5',
    path: '#a39f96',
    roadMinor: '#ffffff',
    roadMajor: '#ffffff',
    roadCasing: '#c3c5c9',
    highway: '#fbf8e8',
    highwayCasing: '#b8b4a4',
    boundaryCountry: '#8c8a9e',
    boundaryRegion: '#b3b1c2',
    text: '#3d4249',
    textMuted: '#5f646c',
    waterText: '#4f7391',
    halo: '#ffffff',
    hillshadeShadow: '#4a5560',
    hillshadeHighlight: '#ffffff',
    hillshadeAccent: '#6b7680',
  },
  dark: {
    land: '#1b1e22',
    water: '#10202e',
    waterway: '#1c3346',
    forest: '#22342a',
    park: '#232d27',
    grass: '#23292a',
    farmland: '#1f2225',
    urban: '#24272b',
    barren: '#26272a',
    glacier: '#2b3036',
    protectedOutline: '#4d6b52',
    building: '#2a2d32',
    path: '#50555c',
    roadMinor: '#30343a',
    roadMajor: '#3a3f46',
    roadCasing: '#15171a',
    highway: '#474b52',
    highwayCasing: '#121417',
    boundaryCountry: '#8a88a0',
    boundaryRegion: '#55546a',
    text: '#c9ced6',
    textMuted: '#9097a1',
    waterText: '#7f9db5',
    halo: '#1b1e22',
    hillshadeShadow: '#000000',
    hillshadeHighlight: '#5d6670',
    hillshadeAccent: '#0b0d10',
  },
};
