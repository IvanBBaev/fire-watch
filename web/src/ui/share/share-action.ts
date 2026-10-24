/**
 * The share button's whole job — build the card, lay it out as SVG, rasterize it and hand
 * it to the share sheet — as one module the event page fetches on the first click.
 *
 * None of it runs before a reader asks for a card, so none of it belongs on the first-load
 * path (CI-12): the card's layout and the rasterizer are code most visits never execute.
 * What the card says is still decided entirely by `share-card.ts`, at the moment of the
 * click, from the server time the caller passes in.
 */

import { buildShareCard, renderShareCardSvg, type ShareCardInput } from './share-card.js';
import { shareCardImage, type ShareCardRequest, type ShareOutcome } from './share-image.js';

/** What the share sheet needs besides the image: the file name, title and permalink. */
export type ShareTarget = Omit<ShareCardRequest, 'svg' | 'width' | 'height'>;

export function shareEventCard(card: ShareCardInput, target: ShareTarget): Promise<ShareOutcome> {
  return shareCardImage({ ...renderShareCardSvg(buildShareCard(card)), ...target });
}
