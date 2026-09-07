/**
 * The house mark: an upside-down magician's top hat, drawn in the reader's ink with
 * an oxblood band and three small champagne sparks. The open brim sits at the top and
 * the crown tapers downward, so the inversion survives at favicon scale instead of
 * reading like an ordinary upright hat.
 *
 * `scripts/gen-icons.mjs` owns the browser/PWA files. The geometry below mirrors it and
 * `Mark.test.ts` compares this renderer against the generated favicon, so the masthead
 * and the browser tab cannot quietly become two different marks.
 *
 * Flat fills, no gradient, no shadow. The sparks are decorative: their champagne tone
 * is mixed from existing paper-system tokens rather than becoming a second UI accent.
 */

const BRIM_RX = 0.46;
const BRIM_RY = 0.11;
const OPEN_RX = 0.28;
const OPEN_RY = 0.055;
const CROWN_TOP_W = 0.34;
const CROWN_BOTTOM_W = 0.24;
const CROWN_H = 0.34;
const BAND_H = 0.075;
const BOTTOM_CAP_RY = 0.035;

export interface SparkleGeometry {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface HatGeometry {
  /** Centre of the square the mark is drawn in. */
  c: number;
  size: number;
  brimCy: number;
  brimRx: number;
  brimRy: number;
  openRx: number;
  openRy: number;
  bodyTop: number;
  bodyBottom: number;
  crownTopW: number;
  crownBottomW: number;
  bandTop: number;
  bandBottom: number;
  bottomCapRy: number;
  sparkles: readonly [SparkleGeometry, SparkleGeometry, SparkleGeometry];
}

/**
 * @param size   the square the mark is drawn in, in user units
 * @param inset  fraction of that square the mark shrinks into; 1 fills it
 */
export function hatGeometry(size: number, inset = 1): HatGeometry {
  const c = size / 2;
  const s = size * inset;
  const brimCy = c - s * 0.08;
  const bodyTop = brimCy + s * OPEN_RY * 1.02;
  const bodyBottom = bodyTop + s * CROWN_H;
  const bandTop = bodyTop + s * 0.02;
  const bandBottom = bandTop + s * BAND_H;

  return {
    c,
    size: s,
    brimCy,
    brimRx: s * BRIM_RX,
    brimRy: s * BRIM_RY,
    openRx: s * OPEN_RX,
    openRy: s * OPEN_RY,
    bodyTop,
    bodyBottom,
    crownTopW: s * CROWN_TOP_W,
    crownBottomW: s * CROWN_BOTTOM_W,
    bandTop,
    bandBottom,
    bottomCapRy: s * BOTTOM_CAP_RY,
    sparkles: [
      { x: c, y: c - s * 0.315, rx: s * 0.075, ry: s * 0.09 },
      { x: c - s * 0.165, y: c - s * 0.225, rx: s * 0.044, ry: s * 0.054 },
      { x: c + s * 0.165, y: c - s * 0.225, rx: s * 0.044, ry: s * 0.054 },
    ],
  };
}

const n = (v: number) => Number(v.toFixed(2));

const widthAt = (h: HatGeometry, y: number) => {
  const t = Math.max(0, Math.min(1, (y - h.bodyTop) / (h.bodyBottom - h.bodyTop)));
  return h.crownTopW + (h.crownBottomW - h.crownTopW) * t;
};

export function bodyPath(h: HatGeometry): string {
  return (
    `M ${n(h.c - h.crownTopW / 2)} ${n(h.bodyTop)} ` +
    `L ${n(h.c + h.crownTopW / 2)} ${n(h.bodyTop)} ` +
    `L ${n(h.c + h.crownBottomW / 2)} ${n(h.bodyBottom)} ` +
    `L ${n(h.c - h.crownBottomW / 2)} ${n(h.bodyBottom)} Z`
  );
}

export function bandPath(h: HatGeometry): string {
  const topW = widthAt(h, h.bandTop);
  const bottomW = widthAt(h, h.bandBottom);
  return (
    `M ${n(h.c - topW / 2)} ${n(h.bandTop)} ` +
    `L ${n(h.c + topW / 2)} ${n(h.bandTop)} ` +
    `L ${n(h.c + bottomW / 2)} ${n(h.bandBottom)} ` +
    `L ${n(h.c - bottomW / 2)} ${n(h.bandBottom)} Z`
  );
}

const ellipsePath = (cx: number, cy: number, rx: number, ry: number) =>
  `M ${n(cx - rx)} ${n(cy)} ` +
  `A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)} ` +
  `A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`;

/** A brim with a real hole through it, not a pale ellipse painted on top. */
export function brimRingPath(h: HatGeometry): string {
  return `${ellipsePath(h.c, h.brimCy, h.brimRx, h.brimRy)} ${ellipsePath(
    h.c,
    h.brimCy,
    h.openRx,
    h.openRy,
  )}`;
}

/** Four-point sparkle, pinched enough to stay a sparkle at 16px rather than a diamond. */
export function sparklePath(s: SparkleGeometry): string {
  const ix = s.rx * 0.22;
  const iy = s.ry * 0.22;
  return (
    `M ${n(s.x)} ${n(s.y - s.ry)} ` +
    `L ${n(s.x + ix)} ${n(s.y - iy)} ` +
    `L ${n(s.x + s.rx)} ${n(s.y)} ` +
    `L ${n(s.x + ix)} ${n(s.y + iy)} ` +
    `L ${n(s.x)} ${n(s.y + s.ry)} ` +
    `L ${n(s.x - ix)} ${n(s.y + iy)} ` +
    `L ${n(s.x - s.rx)} ${n(s.y)} ` +
    `L ${n(s.x - ix)} ${n(s.y - iy)} Z`
  );
}

export interface MarkProps {
  className?: string;
  /** Naming the mark where it is not already followed by the What a Pull wordmark. */
  title?: string;
}

const UNITS = 32;
const CHAMPAGNE = 'color-mix(in srgb, var(--warm) 62%, var(--bone))';

export function Mark({ className, title }: MarkProps) {
  const h = hatGeometry(UNITS);
  const [big] = h.sparkles;
  const top = big.y - big.ry;
  const bottom = h.bodyBottom + h.bottomCapRy;

  return (
    <svg
      className={className}
      viewBox={`${n(h.c - h.brimRx)} ${n(top)} ${n(h.brimRx * 2)} ${n(bottom - top)}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={bodyPath(h)} fill="currentColor" />
      <ellipse
        cx={n(h.c)}
        cy={n(h.bodyBottom)}
        rx={n(h.crownBottomW / 2)}
        ry={n(h.bottomCapRy)}
        fill="currentColor"
      />
      <path d={bandPath(h)} fill="var(--accent)" />
      <path d={brimRingPath(h)} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
      {h.sparkles.map((sparkle, index) => (
        <path key={index} d={sparklePath(sparkle)} fill={CHAMPAGNE} />
      ))}
    </svg>
  );
}
