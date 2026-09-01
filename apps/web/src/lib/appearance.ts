/**
 * Appearance — the three display choices `tokens.css` has always supported and
 * no reader could ever make.
 *
 * `[data-theme]`, `[data-contrast]` and `[data-text]` have been selectors in the
 * token file since round 1, each with a complete palette or scale behind it, and
 * not one of them was reachable from the interface. A stylesheet that answers a
 * question nobody can ask is indistinguishable from one that does not answer it.
 *
 * WHY LOCALSTORAGE AND NOT A COLUMN, since `preferences` exists and this is
 * plainly a preference:
 *
 *   * A visitor can read now. Since guest reading landed, somebody with no
 *     account can open a Pull at two in the morning — and they have no row to
 *     write a theme into. A display setting that requires signing in is the
 *     sign-in wall again, wearing a smaller hat.
 *   * It has to apply before the first paint. A value fetched over the network
 *     arrives after React has rendered, which is a white flash on every load for
 *     exactly the reader who asked for dark. No round trip can be fast enough,
 *     because the correct number of round trips is zero.
 *   * Per-device is the honest scope. Dark on the phone at night and light on
 *     the desk at noon is not a conflict to be resolved — it is two correct
 *     answers, and a synced column would force one of them to lose.
 *
 * Which leaves law 3 intact rather than straining it: this works offline because
 * it never needed the network, not because something caches it.
 *
 * The shape of every function here follows `lib/focus-mode.ts`, including the
 * guarded storage access. `localStorage` THROWS rather than returning null in a
 * browser set to block site data, and an unguarded read here would be the
 * exception that stops the app rendering at all.
 */

/** A setting, its stored key, and the attribute it drives. */
interface Setting<T extends string> {
  readonly key: string;
  readonly attr: string;
  readonly options: readonly T[];
  /** The value that means "no attribute" — the default the stylesheet assumes. */
  readonly base: T;
}

export type Theme = 'system' | 'light' | 'dark';
export type Contrast = 'normal' | 'high';
export type TextSize = 'normal' | 'large';

export const THEME: Setting<Theme> = {
  key: 'wap:theme',
  attr: 'data-theme',
  options: ['system', 'light', 'dark'],
  base: 'system',
};

export const CONTRAST: Setting<Contrast> = {
  key: 'wap:contrast',
  attr: 'data-contrast',
  options: ['normal', 'high'],
  base: 'normal',
};

export const TEXT_SIZE: Setting<TextSize> = {
  key: 'wap:text',
  attr: 'data-text',
  options: ['normal', 'large'],
  base: 'normal',
};

export interface Appearance {
  theme: Theme;
  contrast: Contrast;
  text: TextSize;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  contrast: 'normal',
  text: 'normal',
};

/**
 * Narrow a stored string to a value the stylesheet actually implements.
 *
 * Anything unrecognised falls to the base rather than being passed through. The
 * value comes from `localStorage`, which is to say from a previous version of
 * this app, a different tab, or whatever a reader typed into a devtools console
 * — and `root.setAttribute('data-theme', 'purple')` matches no rule, so the
 * failure would be a reader whose setting silently does nothing.
 */
export function narrow<T extends string>(setting: Setting<T>, value: unknown): T {
  return typeof value === 'string' && (setting.options as readonly string[]).includes(value)
    ? (value as T)
    : setting.base;
}

function readOne<T extends string>(setting: Setting<T>): T {
  try {
    return narrow(setting, localStorage.getItem(setting.key));
  } catch {
    return setting.base;
  }
}

export function readStoredAppearance(): Appearance {
  return {
    theme: readOne(THEME),
    contrast: readOne(CONTRAST),
    text: readOne(TEXT_SIZE),
  };
}

export function storeAppearance(next: Appearance): void {
  try {
    localStorage.setItem(THEME.key, next.theme);
    localStorage.setItem(CONTRAST.key, next.contrast);
    localStorage.setItem(TEXT_SIZE.key, next.text);
  } catch {
    // A preference that cannot be remembered is still a preference that works
    // for this session. Same trade as focus mode.
  }
}

/** The document root, narrowed to what this module touches, so it can be faked. */
export interface Root {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Reflect the choices onto the document element.
 *
 * The base value REMOVES the attribute rather than writing it, which is the same
 * rule `applyFocus` follows and it is load-bearing here in a way it is not
 * there. `tokens.css` reads the system palette through
 * `:root:not([data-theme='light'])` inside a `prefers-color-scheme` media query.
 * Writing `data-theme="system"` would match neither that selector nor
 * `[data-theme='dark']`, so a reader who chose "Match my system" would be pinned
 * to the light palette forever — the one outcome the option exists to avoid.
 */
export function applyAppearance(a: Appearance, root: Root): void {
  const set = <T extends string>(setting: Setting<T>, value: T) => {
    if (value === setting.base) root.removeAttribute(setting.attr);
    else root.setAttribute(setting.attr, value);
  };
  set(THEME, a.theme);
  set(CONTRAST, a.contrast);
  set(TEXT_SIZE, a.text);
}

/**
 * What to say about a choice, rather than only what to call it.
 *
 * Every option here changes what the reader is looking at while they read the
 * label, so the label can afford to be plain and the description carries the
 * consequence. "High" means nothing; "every shade of grey becomes ink" means
 * something.
 */
export const APPEARANCE_COPY: {
  theme: Record<Theme, { label: string; note: string }>;
  contrast: Record<Contrast, { label: string; note: string }>;
  text: Record<TextSize, { label: string; note: string }>;
} = {
  theme: {
    system: { label: 'Match my system', note: 'Follows whatever this device is set to.' },
    light: { label: 'Paper', note: 'Warm bone ground, ink type. The default.' },
    dark: { label: 'Night', note: 'Ink ground, bone type. Not black — the grain stays.' },
  },
  contrast: {
    normal: { label: 'Normal', note: 'Muted greys for anything that is not the words.' },
    high: { label: 'High', note: 'Quiet text and hairlines become full ink.' },
  },
  text: {
    normal: { label: 'Normal', note: 'The fluid scale, sized to the window.' },
    large: { label: 'Large', note: 'A fixed larger scale that a narrow window cannot shrink.' },
  },
};

/**
 * A one-line summary of what is not at its default.
 *
 * The settings screen leads with this for the same reason every list in the app
 * leads with a count: a reader arriving at a preferences page should be told
 * what they have already changed before being offered more to change.
 */
export function appearanceSummary(a: Appearance): string {
  const changed = [
    a.theme === 'system' ? null : APPEARANCE_COPY.theme[a.theme].label,
    a.contrast === 'normal' ? null : 'High contrast',
    a.text === 'normal' ? null : 'Large text',
  ].filter((x): x is string => x !== null);

  if (changed.length === 0) return 'Everything is at its default.';
  return `${changed.join(' · ')} — everything else is at its default.`;
}
