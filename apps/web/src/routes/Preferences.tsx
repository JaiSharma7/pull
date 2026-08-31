import { useEffect, useState } from 'react';
import { WORK_KINDS, type WorkKind } from '@wap/schemas';
import {
  fetchAvailableMediaKinds,
  fetchPreferences,
  fetchTopics,
  savePreferences,
  type Preferences as Prefs,
  type TopicStance,
  type TopicOption,
} from '../lib/preferences-api.js';

/**
 * What do you want to learn about?
 *
 * This is the input `get_feed` has been missing. `topic_affinity` is 28% of the
 * score and reads `preference_profiles.topic_weights` keyed by topic slug; until a
 * reader states something, every card scores identically on the largest
 * personalisation term in the ranking.
 *
 * Two modes, one component. Onboarding is the same screen with a different frame:
 * a separate flow would be a second copy of the only interesting part, and the
 * first-run version's job is to be answerable in one screen and skippable, not to
 * be a tour.
 */

/** Every stance, in the order they are offered. Ordered least to most enthusiastic. */
const STANCES: { value: TopicStance; label: string; hint: string }[] = [
  { value: 'less', label: 'Not for me', hint: 'Keep this out of the feed entirely' },
  { value: 'default', label: 'Default', hint: 'No preference either way' },
  { value: 'more', label: 'More of this', hint: 'Weight this up in the feed' },
];

const INTERRUPT_RATES: { value: number; label: string; hint: string }[] = [
  { value: 0, label: 'Never', hint: 'No questions inside the feed' },
  { value: 1, label: 'Sometimes', hint: 'A few questions per sitting, at unpredictable moments' },
  { value: 2, label: 'Often', hint: 'More questions, still bounded and dismissible' },
];

export function Preferences({
  userId,
  mode = 'settings',
  onDone,
}: {
  userId: string;
  mode?: 'settings' | 'onboarding';
  onDone: () => void;
}) {
  const [topics, setTopics] = useState<TopicOption[] | null>(null);
  const [mediaOptions, setMediaOptions] = useState<WorkKind[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  /*
   * Three states, not a boolean, for the same reason Review needed them: `null` is
   * "still loading" and an error is an error. Collapsing either into "nothing here"
   * shows a reader an empty picker and tells them it is their answer.
   */
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([fetchTopics(), fetchPreferences(userId), fetchAvailableMediaKinds()])
      .then(([t, p, m]) => {
        if (!live) return;
        setTopics(t);
        setMediaOptions(m);
        setPrefs(p ?? { stances: {}, mediaKinds: m, interruptRate: 1, onboardedAt: null });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : 'Could not load your preferences.');
      });
    return () => {
      live = false;
    };
  }, [userId]);

  function setStance(slug: string, stance: TopicStance) {
    setPrefs((p) => (p ? { ...p, stances: { ...p.stances, [slug]: stance } } : p));
  }

  function toggleMedia(kind: WorkKind) {
    setPrefs((p) => {
      if (!p) return p;
      const has = p.mediaKinds.includes(kind);
      /*
       * Never let the last *visible* one go.
       *
       * Counting the stored list was wrong: it holds every enum member the default
       * grants, while the picker only renders the kinds the corpus actually contains.
       * So a reader could switch off all five they could see, leave four they could
       * not, and land on a `w.kind = any(media)` filter matching nothing — an empty
       * feed with no error and no visible cause.
       */
      const visibleOn = mediaOptions.filter((k) => p.mediaKinds.includes(k));
      if (has && visibleOn.length === 1) return p;
      return {
        ...p,
        mediaKinds: has ? p.mediaKinds.filter((k) => k !== kind) : [...p.mediaKinds, kind],
      };
    });
  }

  async function save(override?: { stances: Record<string, TopicStance>; mediaKinds: WorkKind[] }) {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    try {
      await savePreferences(userId, { ...prefs, ...override });
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save your preferences.');
      setSaving(false);
    }
  }

  /*
   * "Show me everything" has to mean everything, including discarding whatever the
   * reader had toggled before deciding to skip.
   *
   * It shared `save()` with "Start reading", so a reader who set three topics and
   * then chose to skip had those three persisted — the button doing the opposite of
   * what it says, and the harder version of that mistake to notice because the screen
   * closes and the feed looks plausible either way.
   *
   * Every *supported* medium, not every currently-available one. `mediaOptions` is a
   * snapshot of what the corpus contains at this moment, and on a growing corpus
   * writing that snapshot is a trap: a reader onboarding when only books existed
   * would have `['book']` stored forever, and every medium ingested afterwards would
   * be filtered out of their feed by `w.kind = any(media)` — having chosen "show me
   * everything". The corpus gained `lecture` inside an hour on 2026-08-31, so this is
   * not hypothetical.
   *
   * It is also the argument I made against normalising stored media down to the
   * rendered set, applied to the code I wrote immediately afterwards.
   */
  function skip() {
    void save({ stances: {}, mediaKinds: [...WORK_KINDS] });
  }

  if (error && !prefs) {
    /*
     * A dead end here is worse in onboarding than in settings, because there is no
     * shell behind it: no nav, no sign-out, and reloading reproduces it. So the
     * first-run copy offers the way past rather than only the diagnosis — the same
     * fail-open reasoning as `OnboardingGate`, applied to the screen it renders.
     */
    return (
      <section className="measure">
        <h1 className="prose__heading">Preferences</h1>
        <p>Could not load your preferences.</p>
        <p className="meta">{error}</p>
        <div className="prefs__actions">
          <button type="button" className="btn btn--primary" onClick={onDone}>
            {mode === 'onboarding' ? 'Continue without choosing' : 'Back'}
          </button>
        </div>
      </section>
    );
  }

  if (!topics || !prefs) {
    return (
      <section className="measure">
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const parents = [...new Set(topics.map((t) => t.parentSlug ?? t.slug))];
  // Counted over the topics on screen. Stances can survive for topics the picker no
  // longer offers — a topic whose last published work was retired — and reporting
  // those would state a number the reader cannot see or change.
  const chosen = topics.filter((t) => prefs.stances[t.slug] === 'more').length;

  return (
    <section className="prefs measure">
      <h1 className="prose__heading">
        {mode === 'onboarding' ? 'What do you want to learn about?' : 'Preferences'}
      </h1>

      <p>
        {mode === 'onboarding'
          ? 'Pick a few. The feed weights them up — you can change this any time, and skipping is fine.'
          : 'These steer the feed. "More of this" changes what arrives first; "Not for me" removes a topic from the feed altogether, which is the one setting here that hides something rather than reordering it.'}
      </p>

      <h2 className="meta prefs__group">Topics</h2>
      {parents.map((parentSlug) => {
        const children = topics.filter((t) => (t.parentSlug ?? t.slug) === parentSlug);
        // Resolved by the API from the unfiltered topic set: a parent may have no
        // works of its own while its children do, and falling back to the slug printed
        // a heading reading `psychology` rather than "Psychology".
        const parentLabel =
          children.find((t) => t.parentLabel)?.parentLabel ??
          topics.find((t) => t.slug === parentSlug)?.label ??
          parentSlug;
        return (
          <fieldset key={parentSlug} className="prefs__set">
            <legend className="prefs__legend">{parentLabel}</legend>
            {children.map((t) => (
              <div key={t.slug} className="prefs__row">
                <span className="prefs__topic">{t.label}</span>
                <div className="prefs__stances" role="group" aria-label={`${t.label} preference`}>
                  {STANCES.map((s) => {
                    const active = (prefs.stances[t.slug] ?? 'default') === s.value;
                    return (
                      <button
                        key={s.value}
                        type="button"
                        className="btn btn--plain prefs__stance"
                        // Pressed state carries in the accessibility tree and in the
                        // marker below, not in colour alone — a colour-only selected
                        // state is invisible to a third of the reasons someone might
                        // not see it.
                        aria-pressed={active}
                        title={s.hint}
                        onClick={() => setStance(t.slug, s.value)}
                      >
                        <span aria-hidden="true" className="prefs__marker">
                          {active ? '▪' : '·'}
                        </span>{' '}
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </fieldset>
        );
      })}

      <h2 className="meta prefs__group">Media</h2>
      <div className="prefs__media" role="group" aria-label="Media kinds">
        {mediaOptions.map((kind) => {
          const on = prefs.mediaKinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              className="btn btn--plain prefs__stance"
              aria-pressed={on}
              onClick={() => toggleMedia(kind)}
            >
              <span aria-hidden="true" className="prefs__marker">
                {on ? '▪' : '·'}
              </span>{' '}
              {kind}
            </button>
          );
        })}
      </div>

      <h2 className="meta prefs__group">Questions in the feed</h2>
      <p className="prefs__hint">
        Recall questions arrive between cards rather than in a review queue. They are bounded,
        dismissible, and back off when you dismiss them.
      </p>
      <div className="prefs__media" role="group" aria-label="Question frequency">
        {INTERRUPT_RATES.map((r) => {
          const on = prefs.interruptRate === r.value;
          return (
            <button
              key={r.value}
              type="button"
              className="btn btn--plain prefs__stance"
              aria-pressed={on}
              title={r.hint}
              onClick={() => setPrefs((p) => (p ? { ...p, interruptRate: r.value } : p))}
            >
              <span aria-hidden="true" className="prefs__marker">
                {on ? '▪' : '·'}
              </span>{' '}
              {r.label}
            </button>
          );
        })}
      </div>

      {error ? <p className="meta prefs__error">{error}</p> : null}

      <div className="prefs__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : mode === 'onboarding' ? 'Start reading' : 'Save'}
        </button>
        {mode === 'onboarding' ? (
          <button
            type="button"
            className="btn btn--plain"
            disabled={saving}
            // Still a save: it records `onboarded_at` with nothing weighted up, which
            // is a stated preference for everything rather than an unanswered question.
            onClick={skip}
          >
            Show me everything
          </button>
        ) : null}
        <span className="meta prefs__count">
          {chosen === 0 ? 'No topics weighted up' : `${chosen} weighted up`}
        </span>
      </div>
    </section>
  );
}

/**
 * Offer the picker once, to a reader who has never answered it.
 *
 * Fails open, deliberately. If the read throws — offline, a 500, RLS refusing for a
 * reason nobody predicted — this renders the app rather than the gate. Trapping a
 * reader behind a settings screen because a query failed is a far worse outcome than
 * asking them again next session, and it is the failure mode a gate invites.
 */
export function OnboardingGate({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const [needed, setNeeded] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetchPreferences(userId)
      .then((p) => {
        if (live) setNeeded(p !== null && p.onboardedAt === null);
      })
      .catch(() => {
        if (live) setNeeded(false);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  // Undecided renders the app, not a spinner: the gate is worth showing once, and
  // never worth making someone wait to find out whether they will see it.
  if (needed !== true) return <>{children}</>;
  return <Preferences userId={userId} mode="onboarding" onDone={() => setNeeded(false)} />;
}
