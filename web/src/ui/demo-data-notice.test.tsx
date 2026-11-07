/**
 * FD-5 done-when, web half: a build that serves fixtures shows the demo-data notice, and a
 * live build does not. Rendered through the real component and the real catalogs.
 */

import { describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG, withDataSource, type ClientConfig } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { DemoDataNotice } from './demo-data-notice.js';

async function render(
  config: Pick<ClientConfig, 'dataSource'>,
  messages: Messages = en,
): Promise<string> {
  const { html } = await prerender(<DemoDataNotice config={config} messages={messages} />);
  // preact-iso appends its hydration data; only the component's own markup matters here.
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('DemoDataNotice', () => {
  it('is shown on the default (fixture) config, in both languages', async () => {
    const english = await render(DEFAULT_CONFIG);
    expect(english).toContain('class="fw-demo-notice"');
    expect(english).toContain('role="note"');
    expect(english).toContain(en.demoDataNotice);
    expect(await render(DEFAULT_CONFIG, bg)).toContain(bg.demoDataNotice);
  });

  it('is shown when a config does not say where its data comes from', async () => {
    expect(await render({})).toContain(en.demoDataNotice);
  });

  it('is absent on a live build', async () => {
    expect(await render(withDataSource(DEFAULT_CONFIG, 'live'))).toBe('');
  });

  it('never takes the banner slot role', async () => {
    expect(await render(DEFAULT_CONFIG)).not.toContain('role="status"');
  });
});
