/**
 * The geometry of a tiny inline SVG line chart — no chart library, no DOM.
 *
 * The y axis starts at zero rather than at the series minimum: a sparkline that stretches
 * 40→44 MW across its full height would draw a small change as a dramatic one.
 */

export interface SparkInput {
  readonly tMs: number;
  readonly value: number;
}

export interface SparkPoint {
  readonly x: number;
  readonly y: number;
}

export interface SparkGeometry {
  /** SVG path data (`M … L …`); a single point is a short flat stroke so it stays visible. */
  readonly path: string;
  readonly points: readonly SparkPoint[];
}

export interface SparkBox {
  readonly width: number;
  readonly height: number;
  /** Inset on every side, so end-point markers are not clipped by the viewBox. */
  readonly pad: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function sparklineGeometry(
  input: readonly SparkInput[],
  box: SparkBox,
): SparkGeometry | null {
  const data = input.filter((d) => Number.isFinite(d.tMs) && Number.isFinite(d.value));
  if (data.length === 0) return null;
  const innerWidth = box.width - 2 * box.pad;
  const innerHeight = box.height - 2 * box.pad;
  const tMin = Math.min(...data.map((d) => d.tMs));
  const tMax = Math.max(...data.map((d) => d.tMs));
  const vMax = Math.max(...data.map((d) => d.value));
  const span = tMax - tMin;

  const points = data.map((d, index) => {
    // Equal instants (two sensors in one minute) spread by index so neither hides the other.
    const tFraction =
      span > 0 ? (d.tMs - tMin) / span : data.length === 1 ? 0.5 : index / (data.length - 1);
    const vFraction = vMax > 0 ? Math.max(0, d.value) / vMax : 0;
    return {
      x: round(box.pad + tFraction * innerWidth),
      y: round(box.pad + (1 - vFraction) * innerHeight),
    };
  });

  const [first] = points;
  if (first === undefined) return null;
  if (points.length === 1) {
    const half = Math.min(8, innerWidth / 2);
    return {
      path: `M${String(round(first.x - half))} ${String(first.y)}L${String(round(first.x + half))} ${String(first.y)}`,
      points,
    };
  }
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`)
    .join('');
  return { path, points };
}
