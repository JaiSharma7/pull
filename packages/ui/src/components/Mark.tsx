/**
 * The house mark: a magician's top hat, drawn in the reader's ink with the band in
 * oxblood. The product is named for the thing pulled out of it, so the hat is the half
 * you can draw.
 *
 * This is the same hat the tab shows. `scripts/gen-icons.mjs` owns the icon files —
 * there is no rasteriser in this repo, so the PNGs are encoded from a pixel buffer and
 * the geometry has to be expressed analytically anyway — and the numbers below mirror
 * it exactly. `Mark.test.ts` renders this component and compares it against the
 * generated `apps/web/public/favicon.svg`, because a top bar and a browser tab showing
 * two different hats is precisely the drift nobody notices in review.
 *
 * Flat fills, no gradient, no shadow, one accent (design law 1). It is small on purpose:
 * `docs/design.md` is explicit that the sentence is the brand, so the mark sits beside
 * the wordmark at roughly its cap height and does not compete with it.
 */

/** Fractions of the mark's own square, mirroring `hat()` in scripts/gen-icons.mjs. */
const CROWN_W = 0.3;
const CAP_RY = 0.048;
const BAND_H = 0.09;
const BRIM_RX = 0.46;
const BRIM_RY = 0.175;
const BRIM_LIFT = 0.132;
/** The lit crown — what the band leaves showing — is this much taller than it is wide. */
const LIT_RATIO = 1.35;

export interface HatGeometry {
  /** Centre of the square the mark is drawn in. */
  c: number;
  crownW: number;
  capRy: number;
  crownTop: number;
  crownBottom: number;
  bandTop: number;
  bandH: number;
  brimCy: number;
  brimRx: number;
  brimRy: number;
  brimLift: number;
  /** Where the brim's two ellipse edges cross: the crescent's raised tips. */
  tipX: number;
  tipY: number;
}

/**
 * @param size   the square the mark is drawn in, in user units
 * @param inset  fraction of that square the mark shrinks into; 1 fills it
 */
export function hatGeometry(size: number, inset = 1): HatGeometry {
  const c = size / 2;
  const s = size * inset;

  const crownW = s * CROWN_W;
  const capRy = s * CAP_RY;
  const bandH = s * BAND_H;
  const brimRx = s * BRIM_RX;
  const brimRy = s * BRIM_RY;
  const brimLift = s * BRIM_LIFT;
  const litH = crownW * LIT_RATIO;

  // Solved rather than nudged, so the silhouette is centred at any inset.
  const brimCy = c - brimRy + (brimLift + bandH + litH) / 2;
  const bandBottom = brimCy + brimRy - brimLift; // the brim's top edge at the centre
  const bandTop = bandBottom - bandH;
  const crownTop = bandTop - litH;

  const m = brimLift / (2 * brimRy);
  const tipX = brimRx * Math.sqrt(1 - m * m);
  const tipY = brimCy - brimRy * m;

  // The crown's foot stops just inside the brim's lower edge at the crown's own width,
  // so the two shapes join into one silhouette with no seam and no spill.
  const kCrown = Math.sqrt(1 - (crownW / 2 / brimRx) ** 2);
  const crownBottom = brimCy + brimRy * kCrown * 0.9;

  return {
    c,
    crownW,
    capRy,
    crownTop,
    crownBottom,
    bandTop,
    bandH,
    brimCy,
    brimRx,
    brimRy,
    brimLift,
    tipX,
    tipY,
  };
}

const n = (v: number) => Number(v.toFixed(2));

/**
 * The brim as one closed path: out along the lower edge of one ellipse, back along the
 * lower edge of the same ellipse lifted above it. The crescent between them is the
 * sweep, and its two tips are where the edges cross.
 */
export function brimPath(h: HatGeometry): string {
  return (
    `M ${n(h.c - h.tipX)} ${n(h.tipY)} ` +
    `A ${n(h.brimRx)} ${n(h.brimRy)} 0 1 0 ${n(h.c + h.tipX)} ${n(h.tipY)} ` +
    `A ${n(h.brimRx)} ${n(h.brimRy)} 0 0 1 ${n(h.c - h.tipX)} ${n(h.tipY)} Z`
  );
}

export interface MarkProps {
  className?: string;
  /**
   * Naming the mark for assistive technology. Left off by default: everywhere it is
   * used today the wordmark says "What a Pull" right beside it, and a second copy of
   * the same name is noise in a screen reader rather than help.
   */
  title?: string;
}

/** The square the geometry is expressed in. Rendered size comes from CSS. */
const UNITS = 32;

export function Mark({ className, title }: MarkProps) {
  const h = hatGeometry(UNITS);
  // Cropped to the silhouette rather than to its square: the icon files need the
  // padding around the hat, a mark sitting next to a word does not.
  const top = h.crownTop;
  const height = h.brimCy + h.brimRy - top;

  return (
    <svg
      className={className}
      viewBox={`${n(h.c - h.brimRx)} ${n(top)} ${n(h.brimRx * 2)} ${n(height)}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect
        x={n(h.c - h.crownW / 2)}
        y={n(h.crownTop + h.capRy)}
        width={n(h.crownW)}
        height={n(h.crownBottom - h.crownTop - h.capRy)}
        fill="currentColor"
      />
      <ellipse
        cx={n(h.c)}
        cy={n(h.crownTop + h.capRy)}
        rx={n(h.crownW / 2)}
        ry={n(h.capRy)}
        fill="currentColor"
      />
      <rect
        x={n(h.c - h.crownW / 2)}
        y={n(h.bandTop)}
        width={n(h.crownW)}
        height={n(h.bandH)}
        fill="var(--accent)"
      />
      <path d={brimPath(h)} fill="currentColor" />
    </svg>
  );
}
