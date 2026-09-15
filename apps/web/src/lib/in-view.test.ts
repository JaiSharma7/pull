import { describe, expect, it, vi } from 'vitest';
import { isGenuinelyInView, onceInView } from './in-view.js';

const entry = (o: Partial<Parameters<typeof isGenuinelyInView>[0]>) => ({
  isIntersecting: true,
  intersectionRatio: 0,
  intersectionRect: { height: 0 },
  rootBounds: { height: 640 },
  ...o,
});

describe('isGenuinelyInView', () => {
  it('is not in view when it does not intersect at all', () => {
    expect(isGenuinelyInView(entry({ isIntersecting: false, intersectionRatio: 1 }))).toBe(false);
  });

  it('ignores the first notification for a card with one line showing', () => {
    // The first notification after observe() reports the current state whatever
    // the threshold, and isIntersecting is true for any overlap.
    expect(
      isGenuinelyInView(entry({ intersectionRatio: 0.05, intersectionRect: { height: 24 } })),
    ).toBe(false);
  });

  it('counts half the card', () => {
    expect(
      isGenuinelyInView(entry({ intersectionRatio: 0.5, intersectionRect: { height: 200 } })),
    ).toBe(true);
  });

  it('counts a tall card that fills half the viewport even though its ratio never can', () => {
    // A 1300px card on a 640px screen: the ratio is bounded at 0.49.
    expect(
      isGenuinelyInView(entry({ intersectionRatio: 0.3, intersectionRect: { height: 390 } })),
    ).toBe(true);
    expect(
      isGenuinelyInView(entry({ intersectionRatio: 0.2, intersectionRect: { height: 260 } })),
    ).toBe(false);
  });

  it('does not let a missing root satisfy the viewport half', () => {
    expect(
      isGenuinelyInView(
        entry({ intersectionRatio: 0.3, intersectionRect: { height: 390 }, rootBounds: null }),
      ),
    ).toBe(false);
  });
});

describe('onceInView', () => {
  interface Fake {
    cb: (entries: unknown[]) => void;
    options: { threshold: number[] };
    observed: unknown[];
    disconnected: number;
  }
  const install = () => {
    const fakes: Fake[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        fake: Fake;
        constructor(cb: (entries: unknown[]) => void, options: { threshold: number[] }) {
          this.fake = { cb, options, observed: [], disconnected: 0 };
          fakes.push(this.fake);
        }
        observe(el: unknown) {
          this.fake.observed.push(el);
        }
        disconnect() {
          this.fake.disconnected += 1;
        }
      },
    );
    return fakes;
  };

  it('observes the element with a dense threshold schedule', () => {
    const fakes = install();
    try {
      const el = {} as Element;
      onceInView(el, () => {});
      expect(fakes[0]!.observed).toEqual([el]);
      // Every twentieth, so the viewport-half rule is evaluated within five percent
      // of wherever it is met, and the half-card rule exactly at 0.5.
      expect(fakes[0]!.options.threshold).toContain(0.5);
      expect(fakes[0]!.options.threshold.length).toBeGreaterThanOrEqual(21);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fires once, on the first genuine sighting, and then disconnects', () => {
    const fakes = install();
    try {
      let seen = 0;
      onceInView({} as Element, () => {
        seen += 1;
      });
      const fake = fakes[0]!;
      // One line showing: not yet.
      fake.cb([entry({ intersectionRatio: 0.05, intersectionRect: { height: 24 } })]);
      expect(seen).toBe(0);
      expect(fake.disconnected).toBe(0);
      // Half the viewport, ratio still under a half: now.
      fake.cb([entry({ intersectionRatio: 0.3, intersectionRect: { height: 390 } })]);
      expect(seen).toBe(1);
      expect(fake.disconnected).toBe(1);
      // A later notification cannot fire it again.
      fake.cb([entry({ intersectionRatio: 1, intersectionRect: { height: 640 } })]);
      expect(seen).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fires at once where there is no IntersectionObserver', () => {
    // environment: 'node' -- exactly the case the fallback is for.
    expect(typeof IntersectionObserver).toBe('undefined');
    let seen = 0;
    const stop = onceInView({} as Element, () => {
      seen += 1;
    });
    expect(seen).toBe(1);
    expect(() => stop()).not.toThrow();
  });
});
