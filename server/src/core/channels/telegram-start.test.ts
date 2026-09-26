import { describe, expect, it } from 'vitest';

import { parseTelegramStart } from './telegram-start.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';

function update(overrides: Record<string, unknown> = {}, text = `/start ${TOKEN}`) {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_790_000_000,
      text,
      chat: { id: 123456789, type: 'private', username: 'someone', first_name: 'Some' },
      from: {
        id: 123456789,
        is_bot: false,
        username: 'someone',
        first_name: 'Some',
        last_name: 'One',
        language_code: 'bg',
      },
      ...overrides,
    },
  };
}

describe('parseTelegramStart', () => {
  it('yields the private chat id and the token, and nothing else', () => {
    const parsed = parseTelegramStart(update());
    expect(parsed).toEqual({ kind: 'start', start: { chatId: '123456789', token: TOKEN } });
    expect(JSON.stringify(parsed)).not.toMatch(/someone|Some|One|bg/);
  });

  it('accepts the /start@BotName form', () => {
    expect(parseTelegramStart(update({}, `/start@fire_watch_bot ${TOKEN}`)).kind).toBe('start');
  });

  it.each([
    ['null', null, 'not_a_message'],
    ['an array', [], 'not_a_message'],
    ['an edited message', { edited_message: update().message }, 'not_a_message'],
    ['a callback query', { callback_query: {} }, 'not_a_message'],
  ])('ignores %s', (_name, input, reason) => {
    expect(parseTelegramStart(input)).toEqual({ kind: 'ignored', reason });
  });

  it.each([
    ['a non-text message', { text: undefined }, 'not_a_start_command'],
    ['plain text', { text: 'hello' }, 'not_a_start_command'],
    ['a bare /start', { text: '/start' }, 'malformed_payload'],
    ['a payload outside the alphabet', { text: '/start a.b' }, 'malformed_payload'],
    ['a payload over 64 characters', { text: `/start ${'a'.repeat(65)}` }, 'malformed_payload'],
    ['trailing words', { text: `/start ${TOKEN} extra` }, 'malformed_payload'],
    ['a group chat', { chat: { id: -1001, type: 'group' } }, 'not_a_private_chat'],
    ['a channel post chat', { chat: { id: 5, type: 'channel' } }, 'not_a_private_chat'],
    ['a non-integer chat id', { chat: { id: '5', type: 'private' } }, 'not_a_private_chat'],
    ['a negative private id', { chat: { id: -5, type: 'private' } }, 'not_a_private_chat'],
    ['a missing sender', { from: undefined }, 'chat_is_not_the_sender'],
    ['a bot sender', { from: { id: 123456789, is_bot: true } }, 'sender_is_a_bot'],
    [
      'a sender that is not the chat',
      { from: { id: 42, is_bot: false } },
      'chat_is_not_the_sender',
    ],
  ])('ignores %s', (_name, overrides, reason) => {
    const base = update();
    const message: Record<string, unknown> = { ...base.message, ...overrides };
    for (const key of Object.keys(overrides)) {
      if ((overrides as Record<string, unknown>)[key] === undefined) delete message[key];
    }
    expect(parseTelegramStart({ ...base, message })).toEqual({ kind: 'ignored', reason });
  });
});
