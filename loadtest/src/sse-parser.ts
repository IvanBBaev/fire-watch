/**
 * An incremental `text/event-stream` parser (WHATWG HTML §9.2.6), just enough for the
 * load generator: it accepts arbitrary chunk boundaries, CRLF/LF/CR line ends and
 * comment lines, and yields one {@link SseFrame} per dispatched event.
 */

export interface SseFrame {
  /** `message` when the frame had no `event:` field. */
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
  readonly retry: number | null;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;
  private retry: number | null = null;
  private sawField = false;

  /** Feeds decoded text; answers the frames it completed. */
  push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null) break;
      // A trailing lone CR may be the first half of a CRLF split across chunks.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.line(line);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        this.sawField = true;
        break;
      case 'data':
        this.data.push(value);
        this.sawField = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        this.sawField = true;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        this.sawField = true;
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    if (!this.sawField) return null;
    const frame: SseFrame = {
      event: this.event === '' ? 'message' : this.event,
      data: this.data.join('\n'),
      id: this.id,
      retry: this.retry,
    };
    this.event = '';
    this.data = [];
    this.retry = null;
    this.sawField = false;
    return frame;
  }
}
