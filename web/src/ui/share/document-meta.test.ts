/**
 * `applyMetaTags` overrides an event's meta while the page is mounted and restores the
 * shell's defaults when it leaves. The unit project has no DOM, so this runs against the
 * smallest fake of the few `Document` members the function touches.
 */

import { describe, expect, it } from 'vitest';

import { applyMetaTags } from './document-meta.js';
import type { MetaTag } from './share-meta.js';

class FakeMeta {
  readonly attributes = new Map<string, string>();
  parent: FakeHead | null = null;
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

class FakeHead {
  children: FakeMeta[] = [];
  append(child: FakeMeta): void {
    child.parent = this;
    this.children.push(child);
  }
  querySelector(selector: string): FakeMeta | null {
    const match = /^meta\[(property|name)="([^"]+)"\]$/u.exec(selector);
    if (match === null) throw new Error(`unexpected selector ${selector}`);
    const [, attribute = '', key = ''] = match;
    return this.children.find((child) => child.getAttribute(attribute) === key) ?? null;
  }
}

function fakeDocument(): { doc: Document; head: FakeHead } {
  const head = new FakeHead();
  const doc = { head, createElement: () => new FakeMeta() } as unknown as Document;
  return { doc, head };
}

function snapshot(head: FakeHead): readonly (readonly [string, string])[] {
  return head.children.map((child) => [
    child.getAttribute('property') ?? child.getAttribute('name') ?? '',
    child.getAttribute('content') ?? '',
  ]);
}

const TAGS: readonly MetaTag[] = [
  { attribute: 'property', key: 'og:title', content: 'Fire near Sakar' },
  { attribute: 'name', key: 'twitter:card', content: 'summary' },
];

describe('applyMetaTags', () => {
  it('overrides existing tags, adds missing ones, and restores the document exactly', () => {
    const { doc, head } = fakeDocument();
    const existing = new FakeMeta();
    existing.setAttribute('property', 'og:title');
    existing.setAttribute('content', 'Fire Watch');
    head.append(existing);
    const before = snapshot(head);

    const restore = applyMetaTags(doc, TAGS);

    expect(snapshot(head)).toEqual([
      ['og:title', 'Fire near Sakar'],
      ['twitter:card', 'summary'],
    ]);

    restore();

    expect(snapshot(head)).toEqual(before);
  });

  it('removes a restored tag that had no content attribute rather than leaving it empty', () => {
    const { doc, head } = fakeDocument();
    const bare = new FakeMeta();
    bare.setAttribute('name', 'twitter:card');
    head.append(bare);

    applyMetaTags(doc, TAGS)();

    expect(bare.getAttribute('content')).toBeNull();
    expect(head.children).toEqual([bare]);
  });
});
