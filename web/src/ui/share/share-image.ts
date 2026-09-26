/**
 * The browser half of the share card: SVG → PNG, then the platform share sheet or a
 * download. Everything the image *says* is decided in `share-card.ts`; nothing here can
 * change a word or a stamp.
 *
 * No dependency: the SVG is decoded by the browser's own image pipeline and drawn to a
 * canvas at exactly the OG size (CI-12 — a rasterizer library would cost more than the
 * whole entry budget's headroom, for a job the platform already does). An SVG loaded as an
 * image cannot fetch anything, which is also why the card uses system fonts only.
 */

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('share card: the SVG could not be decoded as an image'));
    };
    image.src = url;
  });
}

/** Draws `svg` at `width`×`height` CSS pixels and encodes it as PNG. */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('share card: no 2D canvas context');
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('share card: PNG encoding failed'));
        else resolve(blob);
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The download has started from the click; the URL is released on the next task.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export interface ShareCardRequest {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** File name without extension — the event's public id. */
  readonly baseName: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Offers the card to the platform share sheet when it accepts files, and downloads it
 * otherwise. A PNG is what every destination accepts; when the browser cannot produce
 * one, the SVG itself is downloaded rather than nothing — it says the same thing.
 */
export async function shareCardImage(request: ShareCardRequest): Promise<ShareOutcome> {
  let png: Blob;
  try {
    png = await rasterizeSvg(request.svg, request.width, request.height);
  } catch {
    download(new Blob([request.svg], { type: 'image/svg+xml' }), `${request.baseName}.svg`);
    return 'downloaded';
  }

  const file = new File([png], `${request.baseName}.png`, { type: 'image/png' });
  const data: ShareData = { files: [file], title: request.title, url: request.url };
  if (typeof navigator.canShare === 'function' && navigator.canShare(data)) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (error) {
      // The reader closed the sheet: that is an answer, not a failure to recover from.
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    }
  }
  download(png, `${request.baseName}.png`);
  return 'downloaded';
}
