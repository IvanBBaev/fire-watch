/**
 * Applies {@link MetaTag}s to the live document and gives back the way to undo it.
 *
 * The shell ships static defaults in `index.html` (site name, type, `twitter:card`); an
 * event page overrides them while it is mounted and restores them when it leaves, so the
 * map never carries the last event's title. A tag the document did not have is removed on
 * restore rather than left behind empty.
 */

import type { MetaTag } from './share-meta.js';

function selectorFor(tag: MetaTag): string {
  return `meta[${tag.attribute}="${tag.key}"]`;
}

export function applyMetaTags(doc: Document, tags: readonly MetaTag[]): () => void {
  const undo: (() => void)[] = [];
  for (const tag of tags) {
    const existing = doc.head.querySelector<HTMLMetaElement>(selectorFor(tag));
    if (existing === null) {
      const created = doc.createElement('meta');
      created.setAttribute(tag.attribute, tag.key);
      created.setAttribute('content', tag.content);
      doc.head.append(created);
      undo.push(() => {
        created.remove();
      });
    } else {
      const previous = existing.getAttribute('content');
      existing.setAttribute('content', tag.content);
      undo.push(() => {
        if (previous === null) existing.removeAttribute('content');
        else existing.setAttribute('content', previous);
      });
    }
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
}
