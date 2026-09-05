#!/usr/bin/env node
/**
 * Walk each persona through the app on each device, and record what happens.
 *
 *   pnpm record                                  every persona, laptop and iPhone
 *   pnpm record --persona=reader                 one persona, both devices
 *   pnpm record --persona=reader --device=iphone one pass
 *   pnpm record --headed --slow=250              watch it happen
 *
 * Needs the stack (`pnpm db:start`), the accounts (`pnpm personas`) and the dev server
 * (`pnpm dev`) — it checks all three and says which is missing rather than timing out.
 *
 * ── what comes out ──────────────────────────────────────────────────────────────────
 *
 * artifacts/recordings/<run>/<persona>-<device>/
 *   video.webm            the whole pass, one file
 *   NN-<step>.png         a full-page frame per step, for diffing between runs
 *   report.json           console errors, failed requests, overflow, small targets
 *
 * The video is the part a person watches; `report.json` is the part worth reading
 * first. A recording that only looks right is a recording of the bugs you cannot see:
 * a console error nobody was watching for, a request that 400s and renders as an empty
 * section, a row 12px wider than a 393px viewport that scrolls the whole page sideways.
 * Each of those is collected per step, so a finding arrives already attached to a
 * screen and a frame rather than as a log to bisect.
 *
 * ── what emulation does not prove ───────────────────────────────────────────────────
 *
 * `--device=iphone` is Chromium at an iPhone's viewport, pixel ratio, user agent and
 * touch model. It is the right tool for layout, reflow, tap targets and flow, and it is
 * NOT iOS Safari: it will not reproduce the dynamic-viewport `100vh` behaviour, the
 * safe-area insets, momentum scrolling, or the Web Speech voices that law 3's free
 * audio actually runs on. Those need a real device — `docs/testing-accounts.md` has the
 * Safari Web Inspector route, and the same personas sign in there by link.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from '@playwright/test';
import { rebuild } from './make-personas.mjs';
import { PERSONAS, personaByKey } from './personas.mjs';
import { localStack, signInLink } from './stack.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const BASE = argv.base ?? 'http://127.0.0.1:5173';

const DEVICES = {
  /* A 13" laptop, which is the smallest screen anybody calls "desktop" — if the rail
     and the reading measure survive 1440, they survive the monitors above it. */
  laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  iphone: devices['iPhone 15 Pro'],
};

/* ── the tour ─────────────────────────────────────────────────────────────────────── */

const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  // One more frame than `networkidle` guarantees: the shell renders from state that
  // lands after the last response, and a screenshot taken on the response is of a
  // skeleton. Cheap, and the difference between a useful frame and a blank one.
  await page.waitForTimeout(400);
};

/** A masthead or rail control, whichever of the two copies this width renders. */
const press = (page, name) =>
  page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();

/**
 * A section, wherever this width keeps it.
 *
 * Above the rail's breakpoint every section has a slot of its own. Below it the tab bar
 * keeps four and puts the rest behind "More" — so a tour that only knows how to press a
 * label spent thirty seconds timing out on History and Preferences the moment the bar
 * landed. Opening the disclosure first is what the reader does, so it is what this does.
 */
const section = (label) => async (page) => {
  if ((await press(page, label).count()) === 0) {
    await press(page, 'More').click();
    await settle(page);
  }
  await press(page, label).click();
  await settle(page);
};

const destination = (path) => async (page) => {
  await page.goto(`${BASE}${path}`);
  await settle(page);
};

/** Sign in the way the app's own email does: a single-use `token_hash` in the URL. */
const signIn = (persona) => async (page, ctx) => {
  const { tokenHash } = await signInLink(ctx.stack, persona.email);
  await page.goto(`${BASE}/?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`);
  await settle(page);
};

const onboarding = [
  { name: 'onboarding-preferences', run: async (page) => settle(page) },
  {
    name: 'onboarding-census',
    run: async (page) => {
      await press(page, 'Continue').click();
      await settle(page);
    },
  },
  {
    name: 'onboarding-demo',
    run: async (page) => {
      await press(page, 'Skip calibration').click();
      await settle(page);
    },
  },
  {
    name: 'first-feed',
    run: async (page) => {
      await press(page, 'Skip demo').click();
      await settle(page);
    },
  },
];

/* Sections first, then the addressed screens: the order a reader meets them, and the
   order that keeps a video watchable rather than a list of URLs. */
const shell = [
  { name: 'for-you', run: section('For You') },
  { name: 'daily-pull', run: section('Daily Pull') },
  { name: 'review', run: section('Review') },
  { name: 'library', run: section('Library') },
  {
    // The bar's disclosure, on the widths that have one. A no-op against the rail,
    // where every destination already has a slot, so both devices run one tour.
    name: 'more-sheet',
    run: async (page) => {
      const more = press(page, 'More');
      if ((await more.count()) === 0) return;
      await more.click();
      await settle(page);
    },
  },
  { name: 'history', run: section('History') },
  { name: 'preferences', run: section('Preferences') },
  { name: 'explore', run: destination('/explore') },
  { name: 'search', run: destination('/search?q=liberty') },
  { name: 'graph', run: destination('/graph') },
  { name: 'progress', run: destination('/metacognition') },
  { name: 'import', run: destination('/import') },
  { name: 'appearance', run: destination('/appearance') },
  { name: 'account', run: destination('/account') },
];

function tourFor(persona) {
  if (persona.guest) {
    return [
      {
        name: 'sign-in-screen',
        run: async (page) => {
          await page.goto(BASE);
          await settle(page);
        },
      },
      {
        name: 'guest-session',
        run: async (page) => {
          await press(page, 'Look around as a guest').click();
          await settle(page);
        },
      },
      ...onboarding.slice(1),
      ...shell.slice(0, 8),
    ];
  }
  if (!persona.seed.onboarded) {
    return [{ name: 'sign-in', run: signIn(persona) }, ...onboarding];
  }
  return [{ name: 'sign-in', run: signIn(persona) }, ...shell];
}

/* ── what a frame is inspected for ────────────────────────────────────────────────── */

/**
 * The two faults a phone-shaped viewport produces that a screenshot does not announce.
 *
 * Sideways scroll is the loud one: a single element wider than the viewport drags the
 * whole page, and in a still frame it looks like nothing at all. Undersized tap targets
 * are the quiet one — 44px is Apple's HIG and WCAG 2.5.5's floor, and a control under
 * it is one a thumb misses, which no amount of looking at a 3x screenshot reveals.
 */
async function inspect(page, isMobile) {
  return page.evaluate((mobile) => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const describe = (el) => {
      const cls = (el.getAttribute('class') ?? '').trim();
      return el.tagName.toLowerCase() + (cls ? `.${cls.split(/\s+/).join('.')}` : '');
    };
    const overflow =
      doc.scrollWidth > width + 1
        ? [...document.querySelectorAll('body *')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.right > width + 1 || r.left < -1))
            .slice(0, 6)
            .map(({ el, r }) => ({
              // `getAttribute` rather than `.className`: on an SVG element the property
              // is an SVGAnimatedString, which stringifies to `[object …]`.
              selector: describe(el),
              left: Math.round(r.left),
              right: Math.round(r.right),
            }))
        : [];

    /*
     * Inline links inside a sentence are exempt — WCAG 2.5.5 says so explicitly, and a
     * "Terms" link in a paragraph of prose cannot be 44px tall without wrecking the
     * paragraph. Everything laid out as a block or a flex item has no such excuse.
     */
    const small = mobile
      ? [...document.querySelectorAll('button, a[href], input, select, [role="button"]')]
          .map((el) => {
            /*
             * The target is the control plus its label, because pressing the label is
             * what activates the control. Both shapes appear here: a wrapping `<label>`
             * around the input, and Appearance's `<label for>` sitting beside it.
             * Measuring the input alone reported every radio there as a 12×12 defect
             * when what a thumb lands on is the whole row.
             */
            const label =
              el.closest('label') ??
              (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
            const box = label ?? el;
            const r = box.getBoundingClientRect();
            // A separate label sits beside the control, so the pair is the real target.
            const rect =
              label && !label.contains(el)
                ? (() => {
                    const own = el.getBoundingClientRect();
                    return {
                      width: Math.max(r.right, own.right) - Math.min(r.left, own.left),
                      height: Math.max(r.bottom, own.bottom) - Math.min(r.top, own.top),
                    };
                  })()
                : r;
            return { el, r: rect, display: getComputedStyle(box).display };
          })
          .filter(({ r, display }) => r.width > 0 && r.height > 0 && display !== 'inline')
          .filter(({ r }) => r.width < 44 || r.height < 44)
          .slice(0, 60)
          .map(({ el, r }) => ({
            // Grouped on in the summary: one undersized `.btn` is a stylesheet bug, and
            // naming the sixty places it lands buries that under its own symptoms.
            selector: describe(el),
            name: (el.textContent ?? '').trim().slice(0, 40) || el.getAttribute('aria-label') || '',
            size: `${Math.round(r.width)}×${Math.round(r.height)}`,
          }))
      : [];

    return { viewport: width, scrollWidth: doc.scrollWidth, overflow, small };
  }, isMobile);
}

/* ── the run ──────────────────────────────────────────────────────────────────────── */

async function pass(browser, stack, persona, deviceKey, runDir) {
  const profile = DEVICES[deviceKey];
  const outDir = join(runDir, `${persona.key}-${deviceKey}`);
  mkdirSync(outDir, { recursive: true });

  const context = await browser.newContext({
    ...profile,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    recordVideo: { dir: outDir, size: profile.viewport },
  });
  const page = await context.newPage();

  /*
   * Put the phone back after every full-page screenshot.
   *
   * `fullPage` captures beyond the viewport by overriding the page's device metrics,
   * and what Playwright restores afterwards is not what went in: the mobile flag is
   * dropped, so `(pointer: coarse)` reads false for the rest of the page's life and
   * `page.setViewportSize` does not bring it back.
   *
   * This is worth the CDP call rather than dropping `fullPage`, because of what it
   * silently did to the findings. Every rule this project keys on a coarse pointer —
   * the 44px minimum, `.pull-card__stop-btn` — stopped applying from frame two onward,
   * so the report measured a *desktop* rendering of every phone screen and confidently
   * called a working 44px rule broken. A check that reports a fixed bug as unfixed is
   * worse than no check.
   */
  const cdp = profile.isMobile ? await context.newCDPSession(page) : null;
  const remobilise = async () => {
    if (!cdp) return;
    await cdp
      .send('Emulation.setDeviceMetricsOverride', {
        width: profile.viewport.width,
        height: profile.viewport.height,
        deviceScaleFactor: profile.deviceScaleFactor ?? 1,
        mobile: true,
      })
      .catch(() => {});
    /*
     * This is the one that matters, and it is not obvious: the metrics override alone
     * leaves `(pointer: coarse)` false. Chromium derives the primary pointer type from
     * touch emulation rather than from the mobile flag, so restoring the viewport
     * without restoring touch gives a phone-shaped page that answers every pointer
     * query as a mouse.
     */
    await cdp
      .send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      .catch(() => {});
  };

  const console_ = [];
  const failed = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console_.push({ type: m.type(), text: m.text().slice(0, 300) });
  });
  page.on('pageerror', (e) => console_.push({ type: 'pageerror', text: String(e).slice(0, 300) }));
  page.on('response', (r) => {
    if (r.status() >= 400)
      failed.push({
        status: r.status(),
        url: r.url().replace(stack.apiUrl, '«api»').slice(0, 160),
      });
  });

  const steps = [];
  for (const [i, step] of tourFor(persona).entries()) {
    const before = { console: console_.length, failed: failed.length };
    const label = String(i + 1).padStart(2, '0');
    let error = null;
    try {
      await step.run(page, { stack, persona, page });
    } catch (e) {
      // A step that cannot run is a finding, not a crash: the rest of the tour still
      // has things to say, and the frame taken here is usually what explains it.
      error = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
    }
    const findings = await inspect(page, Boolean(profile.isMobile)).catch(() => ({}));
    await page
      .screenshot({ path: join(outDir, `${label}-${step.name}.png`), fullPage: true, scale: 'css' })
      .catch(() => {});
    await remobilise();
    steps.push({
      step: step.name,
      frame: `${label}-${step.name}.png`,
      url: page.url().replace(BASE, ''),
      error,
      ...findings,
      console: console_.slice(before.console),
      failedRequests: failed.slice(before.failed),
    });
  }

  const video = page.video();
  await context.close();
  if (video) {
    await video.saveAs(join(outDir, 'video.webm')).catch(() => {});
    // `saveAs` copies rather than moves, and the original keeps its hashed name.
    await video.delete().catch(() => {});
  }

  const report = {
    persona: persona.key,
    device: deviceKey,
    viewport: profile.viewport,
    base: BASE,
    at: new Date().toISOString(),
    steps,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function summarise(reports, runDir) {
  const lines = ['# Recording run', '', `Base: ${BASE}`, `Run: ${runDir}`, ''];
  for (const r of reports) {
    const errs = r.steps.flatMap((s) => s.console.filter((c) => c.type !== 'warning'));
    const bad = r.steps.flatMap((s) => s.failedRequests);
    const over = r.steps.filter((s) => s.overflow?.length);
    const broke = r.steps.filter((s) => s.error);
    const byShape = new Map();
    for (const t of r.steps.flatMap((s) => s.small ?? [])) {
      const key = `${t.selector} · ${t.size}`;
      byShape.set(key, (byShape.get(key) ?? 0) + 1);
    }
    const small = [...byShape].sort((a, b) => b[1] - a[1]);
    lines.push(
      `## ${r.persona} · ${r.device} (${r.viewport.width}×${r.viewport.height})`,
      '',
      `- steps: ${r.steps.length}${broke.length ? ` · **${broke.length} could not run**: ${broke.map((s) => s.step).join(', ')}` : ''}`,
      `- console errors: ${errs.length}${errs.length ? ` — ${errs[0].text.slice(0, 120)}` : ''}`,
      `- failed requests: ${bad.length}${bad.length ? ` — ${bad[0].status} ${bad[0].url}` : ''}`,
      `- horizontal overflow: ${over.length ? over.map((s) => s.step).join(', ') : 'none'}`,
      `- tap targets under 44px: ${small.length ? `${small.length} shapes` : 'none'}`,
      ...small.slice(0, 6).map(([shape, n]) => `  - ${shape} ×${n}`),
      '',
    );
  }
  return lines.join('\n');
}

const stack = localStack();

const reachable = await fetch(BASE).then(
  (r) => r.ok,
  () => false,
);
if (!reachable) {
  console.error(
    `No dev server at ${BASE}. Run \`pnpm dev\` in another terminal (or pass --base=…).`,
  );
  process.exit(1);
}

const chosen = argv.persona ? [personaByKey(argv.persona)] : PERSONAS;
const deviceKeys = argv.device ? [argv.device] : Object.keys(DEVICES);
const runDir = join(
  'artifacts',
  'recordings',
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
);
mkdirSync(runDir, { recursive: true });

const browser = await chromium.launch({
  headless: !argv.headed,
  slowMo: argv.slow ? Number(argv.slow) : 0,
});

const reports = [];
for (const persona of chosen) {
  for (const deviceKey of deviceKeys) {
    /*
     * Rebuilt between device passes, not once before the run.
     *
     * `first-run`'s tour *is* the onboarding screens, and walking them sets
     * `onboarded_at` — so on the first full run the laptop pass onboarded the account
     * and the iPhone pass then spent ninety seconds clicking a "Continue" that was no
     * longer on the screen. `--fresh` extends the same treatment to the rest, which is
     * what makes two runs of `reader` comparable: reading in the feed writes history.
     */
    if (!persona.guest && (argv.fresh || !persona.seed.onboarded)) {
      await rebuild(stack, persona);
    }
    process.stdout.write(`${persona.key} · ${deviceKey} … `);
    const report = await pass(browser, stack, persona, deviceKey, runDir);
    const problems =
      report.steps.filter((s) => s.error).length +
      report.steps.flatMap((s) => s.console.filter((c) => c.type !== 'warning')).length +
      report.steps.filter((s) => s.overflow?.length).length;
    console.log(problems ? `${problems} to look at` : 'clean');
    reports.push(report);
  }
}
await browser.close();

writeFileSync(join(runDir, 'report.md'), summarise(reports, runDir));
console.log(`\n${runDir}/report.md`);
