import { describe, expect, it } from 'vitest';

import { SseParser } from './sse-parser.js';

describe('SseParser', () => {
  it('parses the stream preamble and a degrade frame', () => {
    const parser = new SseParser();
    const frames = parser.push(
      'retry: 5000\n\nevent: reset\ndata: {"reason":"unknown"}\n\n: keepalive\n\nevent: degrade\ndata: {"reason":"capacity"}\n\n',
    );
    expect(frames).toEqual([
      { event: 'message', data: '', id: null, retry: 5000 },
      { event: 'reset', data: '{"reason":"unknown"}', id: null, retry: null },
      { event: 'degrade', data: '{"reason":"capacity"}', id: null, retry: null },
    ]);
  });

  it('survives any chunk boundary, CRLF included', () => {
    const text = 'id: 7\r\nevent: change\r\ndata: a\r\ndata: b\r\n\r\n';
    for (let cut = 0; cut <= text.length; cut += 1) {
      const parser = new SseParser();
      const frames = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
      expect(frames).toEqual([{ event: 'change', data: 'a\nb', id: '7', retry: null }]);
    }
  });

  it('holds an incomplete frame until its blank line', () => {
    const parser = new SseParser();
    expect(parser.push('event: degrade\ndata: {}\n')).toEqual([]);
    expect(parser.push('\n')).toHaveLength(1);
  });
});
