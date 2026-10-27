/**
 * The camera controls, mounted for real: 07-product-ux §5.9.1 allows a location request
 * only as the answer to a press of the locate control. A server render cannot prove that —
 * effects never run there — so these tests mount the component into a minimal document,
 * flush its effects with `act`, and count what reached the geolocator.
 *
 * The document below is the smallest one Preact's DOM diff needs (elements, text, the
 * child-list walk, attributes and listeners). It is not a browser; the browser half of
 * the guarantee — no permission prompt on load, a working control on click — is the
 * cold-load e2e (`web/e2e/cold-load.e2e.ts`).
 */

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import en from '../core/i18n/en.js';
import type { GeoFixOutcome } from '../core/ports.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { MapControls } from './map-controls.js';

class FakeNode {
  parentNode: FakeElement | null = null;

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

class FakeText extends FakeNode {
  readonly nodeType = 3;

  constructor(public data: string) {
    super();
  }

  get textContent(): string {
    return this.data;
  }
}

type Listener = (this: FakeElement, event: { readonly type: string }) => void;

class FakeElement extends FakeNode {
  readonly nodeType = 1;
  readonly localName: string;
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, unknown> = { setProperty: () => {} };
  // Present so Preact registers `onClick` as the native lower-case `click` event.
  onclick: null = null;

  constructor(tag: string) {
    super();
    this.localName = tag.toLowerCase();
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child as FakeText | FakeElement).textContent).join('');
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    node.remove();
    const index = reference === null ? -1 : this.childNodes.indexOf(reference);
    this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((registered) => registered !== listener),
    );
  }

  click(): void {
    // Called with the element as `this`, as a browser does: Preact's proxy reads its
    // handlers off the element it is attached to.
    for (const listener of this.listeners.get('click') ?? [])
      listener.call(this, { type: 'click' });
  }

  findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.childNodes) {
      if (!(child instanceof FakeElement)) continue;
      if (predicate(child)) found.push(child);
      found.push(...child.findAll(predicate));
    }
    return found;
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  createTextNode: (data: string) => new FakeText(data),
};

const hasClass = (name: string) => (element: FakeElement) =>
  (element.getAttribute('class') ?? '').split(' ').includes(name);

function services(locate: () => Promise<GeoFixOutcome>): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => 0, monotonicNow: () => 0 },
    serverNow: () => 0,
    config: DEFAULT_CONFIG,
    geolocator: { locate },
    locale: 'en',
    messages: en,
    setLocale: () => {},
  };
}

describe('MapControls — location only on a press (07-product-ux §5.9.1)', () => {
  let container: FakeElement;

  beforeEach(() => {
    vi.stubGlobal('document', fakeDocument);
    // A first visit: no `#map=` in the link (and no storage, so no remembered frame) —
    // exactly the case the removed automatic attempt fired on.
    vi.stubGlobal('location', { hash: '', pathname: '/' });
    container = new FakeElement('div');
  });

  afterEach(() => {
    render(null, container as unknown as Element);
    vi.unstubAllGlobals();
  });

  async function mount(locate: () => Promise<GeoFixOutcome>, onMove = vi.fn()): Promise<void> {
    await act(() => {
      render(
        <AppContext.Provider value={services(locate)}>
          <MapControls onMove={onMove} />
        </AppContext.Provider>,
        container as unknown as Element,
      );
    });
  }

  function locateButton(): FakeElement {
    const button = container
      .findAll(hasClass('map-control'))
      .find((element) => element.textContent === en.mapControls.locate);
    if (button === undefined) throw new Error('the locate control is missing');
    return button;
  }

  /** Press, then let the geolocator's promise and the re-render it causes settle. */
  async function press(button: FakeElement): Promise<void> {
    await act(async () => {
      button.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  const statusLine = (): string =>
    container.findAll(hasClass('map-controls-status'))[0]?.textContent ?? '';

  it('asks for no location on mount, with no link camera and no remembered frame', async () => {
    const locate = vi.fn(() => Promise.resolve<GeoFixOutcome>({ kind: 'denied' }));
    await mount(locate);
    // Past the 35 ms fallback Preact uses to run effects without requestAnimationFrame.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

    expect(locate).not.toHaveBeenCalled();
    expect(statusLine()).toBe('');
  });

  it('asks once per press, and answers a refusal out loud', async () => {
    const locate = vi.fn(() => Promise.resolve<GeoFixOutcome>({ kind: 'denied' }));
    await mount(locate);

    await press(locateButton());

    expect(locate).toHaveBeenCalledTimes(1);
    expect(statusLine()).toBe(en.mapControls.locationDenied);
  });

  it('moves the camera to a fix the press asked for', async () => {
    const onMove = vi.fn();
    await mount(
      () => Promise.resolve<GeoFixOutcome>({ kind: 'fix', lon: 23.32, lat: 42.7 }),
      onMove,
    );

    await press(locateButton());

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]?.[0]).toMatchObject({ lon: 23.32, lat: 42.7 });
    expect(statusLine()).toBe('');
  });
});
