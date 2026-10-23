/**
 * The "Download" control (TASKS V2-D1) on the event list and on the event page.
 *
 * A native `<details>`/`<summary>` disclosure, so it opens with Enter or Space and the
 * format buttons are ordinary tab stops — no custom keyboard handling to get wrong. The
 * export code itself is fetched at the first press (`import()` of `run-export.ts`, CI-12
 * role `action`); until then this file is all the list and the page carry.
 */

import { useState } from 'preact/hooks';

import type { ExportFormat } from '../../core/export/serialise.js';
import { useApp } from '../context.js';
import { creditRenderContext } from '../logic/credits.js';
import type { ExportRequest } from './run-export.js';

/** File-format names are format identifiers, the same in every language. */
const FORMATS: readonly { readonly format: ExportFormat; readonly label: string }[] = [
  { format: 'geojson', label: 'GeoJSON' },
  { format: 'kml', label: 'KML' },
  { format: 'csv', label: 'CSV' },
];

type Phase = 'idle' | 'preparing' | 'failed';

export function DownloadMenu({
  label,
  request,
}: {
  /** The summary's text: what is being downloaded. */
  readonly label: string;
  /** Read at the press, so the file holds what the screen shows at that moment. */
  readonly request: () => ExportRequest;
}) {
  const { messages, locale, serverNow } = useApp();
  const [phase, setPhase] = useState<Phase>('idle');

  const press = (format: ExportFormat): void => {
    setPhase('preparing');
    const generatedAtMs = serverNow();
    const context = {
      messages,
      locale,
      generatedAtMs,
      credit: creditRenderContext({ epochNow: () => generatedAtMs }, messages),
    };
    import('./run-export.js')
      .then(({ runExport }) => runExport(request(), format, context))
      .then(() => {
        setPhase('idle');
      })
      .catch(() => {
        setPhase('failed');
      });
  };

  return (
    <details class="download-menu">
      <summary class="button-secondary">{label}</summary>
      <div class="download-formats" role="group" aria-label={messages.dataExport.formatsLabel}>
        {FORMATS.map(({ format, label: formatLabel }) => (
          <button
            key={format}
            type="button"
            class="button-secondary"
            data-format={format}
            disabled={phase === 'preparing'}
            aria-busy={phase === 'preparing'}
            onClick={() => {
              press(format);
            }}
          >
            {formatLabel}
          </button>
        ))}
      </div>
      <p class="download-status" role="status" aria-live="polite">
        {phase === 'preparing'
          ? messages.dataExport.preparing
          : phase === 'failed'
            ? messages.dataExport.failed
            : ''}
      </p>
    </details>
  );
}
