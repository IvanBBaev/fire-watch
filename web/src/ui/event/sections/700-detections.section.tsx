/**
 * Slot 700: fire radiative power per pass and the contributing sensors, from the per-event
 * detections file. Nothing detection-shaped is said while the file loads, and its absence
 * is said in one line.
 */

import { formatDateTimeSofia, formatNumber } from '../../../core/i18n/format.js';
import { useApp } from '../../context.js';
import type { FrpSummary, Overpass } from '../detection-detail.js';
import { orbitText, pixelText, sensorLabel } from '../event-format.js';
import { sparklineGeometry } from '../sparkline.js';
import type { EventSectionProps } from './registry.js';

const SPARK_BOX = { width: 160, height: 40, pad: 4 } as const;

function FrpSection({ frp }: { readonly frp: FrpSummary | null }) {
  const { messages, locale } = useApp();
  const t = messages.eventDetail;
  if (frp === null) {
    return (
      <section class="event-section" aria-labelledby="event-frp-title">
        <h2 id="event-frp-title">{t.frpTitle}</h2>
        <p>{t.frpUnavailable}</p>
      </section>
    );
  }
  const mw = (pass: Overpass): string => formatNumber(pass.frpMw ?? 0, locale);
  const line = (
    template: (mw: string, sensor: string, time: string) => string,
    pass: Overpass,
  ): string =>
    template(mw(pass), sensorLabel(pass.sourceId), formatDateTimeSofia(pass.observedAt, locale));
  const values = frp.series.map((pass) => pass.frpMw ?? 0);
  const geometry = sparklineGeometry(
    frp.series.map((pass) => ({ tMs: pass.observedMs, value: pass.frpMw ?? 0 })),
    SPARK_BOX,
  );
  return (
    <section class="event-section" aria-labelledby="event-frp-title">
      <h2 id="event-frp-title">{t.frpTitle}</h2>
      <p>{line(t.frpLatest, frp.latest)}</p>
      {frp.peak !== frp.latest && <p>{line(t.frpPeak, frp.peak)}</p>}
      {geometry !== null && (
        <svg
          class="frp-sparkline"
          role="img"
          aria-label={t.frpChartLabel(
            frp.series.length,
            formatNumber(Math.min(...values), locale),
            formatNumber(Math.max(...values), locale),
          )}
          viewBox={`0 0 ${String(SPARK_BOX.width)} ${String(SPARK_BOX.height)}`}
          width={SPARK_BOX.width}
          height={SPARK_BOX.height}
        >
          <path d={geometry.path} />
          {geometry.points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r="2" />
          ))}
        </svg>
      )}
      <p class="event-note">{t.frpNote}</p>
    </section>
  );
}

export default function DetectionsSection({ detail }: EventSectionProps) {
  const { messages, locale } = useApp();
  const t = messages.eventDetail;
  if (detail.kind === 'loading') return null;
  if (detail.kind === 'unavailable') return <p class="event-note">{t.detailUnavailable}</p>;
  const { summary } = detail;
  return (
    <>
      <FrpSection frp={summary.frp} />
      <section class="event-section" aria-labelledby="event-sensors-title">
        <h2 id="event-sensors-title">{t.sensorsTitle}</h2>
        <ul class="sensor-list">
          {summary.sensors.map((sensor) => {
            const size = pixelText(sensor.sourceId, messages, locale);
            const facts = [
              orbitText(sensor.sourceId, messages),
              size === null ? null : t.sensorPixel(size),
              messages.detectionCount(sensor.detections),
            ].filter((fact): fact is string => fact !== null);
            return (
              <li key={sensor.sourceId}>
                <strong>{sensorLabel(sensor.sourceId)}</strong> · {facts.join(' · ')}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
