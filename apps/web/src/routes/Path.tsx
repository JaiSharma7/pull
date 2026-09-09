import { useEffect, useState } from 'react';
import { PullCard } from '@wap/ui';
import { nextUndone, stepCopy, type PathDetail, type PathStep } from '../lib/paths.js';
import {
  advanceStep,
  applyStep,
  fetchPath,
  pausePath,
  resumePath,
  testOut,
} from '../lib/paths-api.js';
import { saveExplanation, setConviction } from '../lib/api.js';
import { draftSubmissions } from '../lib/submission.js';
import { useDictation } from '../lib/use-dictation.js';
import { DICTATION_DISCLOSURE } from '../lib/dictation.js';
import { isOfflineFailure } from '../lib/offline.js';

export interface PathProps {
  slug: string;
  userId: string | null;
  onNavigate: (to: string) => void;
  onTitle?: (title: string | null) => void;
  onGoToReview?: () => void;
}

export function Path({ slug, userId, onNavigate, onTitle, onGoToReview }: PathProps) {
  const [path, setPath] = useState<PathDetail | null>(null);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Active step ordinal (1-indexed)
  const [activeOrdinal, setActiveOrdinal] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(false);

  // Step-specific interaction state
  const [prediction, setPrediction] = useState('');
  const [predictRevealed, setPredictRevealed] = useState(false);

  const [compareStance, setCompareStance] = useState<'agree' | 'disagree' | 'unsure' | null>(null);

  const [sayItBackText, setSayItBackText] = useState('');
  /*
   * The microphone, the interim preview and the reason it stopped, from the one hook
   * `Interrupt.tsx` also uses. The first version of this screen copied that file's
   * apparatus by hand and got it wrong: it returned the engine's teardown from a click
   * handler, which React discards, so Stop, advancing the step and leaving the route
   * all left a continuous recognition session live. See `lib/use-dictation.ts`.
   */
  const dictation = useDictation((text) =>
    setSayItBackText((prev) => (prev ? `${prev} ${text.trim()}` : text.trim())),
  );

  const [applyText, setApplyText] = useState('');
  /* Per action, not per screen: a step that could not be saved says so under its own
     button and leaves the rest of the path standing. */
  const [stepError, setStepError] = useState<string | null>(null);

  /*
   * THE MUTATION ID BELONGS TO THE DRAFT, NOT TO THE ATTEMPT.
   *
   * `completeStep` minted a fresh id inside the handler on every click, and its catch
   * only logged -- so a lost response followed by a second click wrote a second
   * conviction, a second explanation or a second note, each keyed on an id the server
   * had never seen. `set_conviction`, `explanations` and `apply_path_step` all
   * deduplicate on the id, which is only worth anything if a retry carries the same one.
   *
   * `draftSubmissions` keys the id AND the submission stamp by (path, step, content),
   * so the same draft gets the same pair however many times it is sent and an edited
   * one gets a fresh pair -- with nothing to clear, which is the shape that has gone
   * wrong here before. The stamp rides with the id because `set_conviction` orders
   * stances by it: a retry with a fresh stamp would claim the reader decided later
   * than they did and could supersede a newer stance from another tab. Lazily
   * initialised state rather than a ref so the closure is built once and never read
   * off `.current` during render.
   */
  const [submissionFor] = useState(() => draftSubmissions());

  useEffect(() => {
    const controller = new AbortController();
    fetchPath(slug, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setPath(detail);
        setSettled(true);
        if (detail) {
          onTitle?.(detail.title);
          const next = nextUndone(detail.steps);
          // If all are done, activeOrdinal is null to show completion screen
          setActiveOrdinal(next ? next.ordinal : null);
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load path', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      controller.abort();
      onTitle?.(null);
    };
  }, [slug, attempt, onTitle]);

  const reloadPath = async () => {
    // Whatever moves the active step ends dictation -- Test out and Pause as much as
    // a submission. Otherwise the engine stays live under the next step, with no Stop
    // button on screen, appending to a field no longer rendered.
    dictation.stop();
    try {
      const refreshed = await fetchPath(slug);
      if (refreshed) {
        setPath(refreshed);
        const next = nextUndone(refreshed.steps);
        setActiveOrdinal(next ? next.ordinal : null);
      }
    } catch (e) {
      console.error('Failed to refresh path', e);
    }
  };

  const handlePauseToggle = async () => {
    if (!path || inFlight || !userId) return;
    setInFlight(true);
    setStepError(null);
    try {
      if (path.pausedAt) {
        await resumePath(path.id);
      } else {
        await pausePath(path.id);
      }
      await reloadPath();
    } catch (e) {
      console.error('Failed to toggle path pause', e);
      setStepError(
        isOfflineFailure(e)
          ? 'You appear to be offline; the path could not be paused or resumed.'
          : 'The path could not be paused or resumed. Try again.',
      );
    } finally {
      setInFlight(false);
    }
  };

  const handleTestOut = async () => {
    if (!path || inFlight || !userId) return;
    setInFlight(true);
    setStepError(null);
    try {
      await testOut(path.id);
      await reloadPath();
    } catch (e) {
      console.error('Failed to test out of path', e);
      setStepError(
        isOfflineFailure(e)
          ? 'You appear to be offline; nothing could be tested out of.'
          : 'Testing out did not go through. Try again.',
      );
    } finally {
      setInFlight(false);
    }
  };

  const completeStep = async (step: PathStep) => {
    if (!path || inFlight) return;
    if (!userId) {
      onNavigate('/');
      return;
    }
    // A submission ends dictation before the text is read, so nothing heard after the
    // click lands in what is sent. `reloadPath` stops it again for every other route
    // out of the step.
    dictation.stop();
    setInFlight(true);
    setStepError(null);
    const draftKey = (content: string) => `${path.id}:${step.ordinal}:${step.kind}:${content}`;
    try {
      if (step.kind === 'read') {
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'predict') {
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'compare') {
        if (compareStance) {
          const { mutationId, submittedAt } = submissionFor(draftKey(compareStance));
          await setConviction(step.pull.id, compareStance, mutationId, submittedAt);
        }
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'say_it_back') {
        const text = sayItBackText.trim();
        if (text) {
          const { mutationId } = submissionFor(draftKey(text));
          await saveExplanation(userId, step.pull.id, text, mutationId);
        }
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'apply') {
        const text = applyText.trim();
        const { mutationId } = submissionFor(draftKey(text));
        await applyStep(path.id, step.ordinal, text, mutationId);
      }

      // Reset step-local interaction state
      setPrediction('');
      setPredictRevealed(false);
      setCompareStance(null);
      setSayItBackText('');
      setApplyText('');

      await reloadPath();
    } catch (e) {
      console.error('Failed to advance step', e);
      setStepError(
        isOfflineFailure(e)
          ? 'You appear to be offline. Your words are still here; try again when you are back.'
          : 'That step could not be saved. Nothing was lost; try again.',
      );
    } finally {
      setInFlight(false);
    }
  };

  if (error) {
    return (
      <section className="stack measure" role="alert" style={{ padding: 'var(--space-6)' }}>
        <p className="meta">Learning Path</p>
        <h1>Could not load this path.</h1>
        <p>
          {offline
            ? 'You appear to be offline. Paths need an active connection.'
            : 'Something went wrong loading this path.'}
        </p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setSettled(false);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!settled) {
    return (
      <p className="meta" style={{ padding: 'var(--space-6)' }} role="status">
        Loading…
      </p>
    );
  }

  if (!path) {
    return (
      <section className="stack measure" style={{ padding: 'var(--space-6)' }}>
        <p className="meta">404</p>
        <h1>Path not found.</h1>
        <p>This learning path does not exist or is no longer published.</p>
        <button type="button" className="btn btn--primary" onClick={() => onNavigate('/paths')}>
          Back to paths
        </button>
      </section>
    );
  }

  const totalSteps = path.steps.length;
  // Ideas, not steps: a path may put one pull on two steps (predict, then compare), and
  // the schedule holds the idea once.
  const ideaCount = new Set(path.steps.map((s) => s.pull.id)).size;
  const applied = path.steps.some((s) => s.kind === 'apply' && s.done && !s.testedOut);
  const isCompleted = path.completedAt !== null || activeOrdinal === null;
  const currentStep =
    activeOrdinal !== null ? (path.steps.find((s) => s.ordinal === activeOrdinal) ?? null) : null;

  /*
   * No readable step at all -- every step is behind a summary this reader cannot see,
   * or a summary was withdrawn after publication. `get_path` withholds `completedAt`
   * here on purpose, and `nextUndone([])` is null, so without this branch the
   * completion screen rendered over zero ideas and said they were all in Review.
   */
  if (totalSteps === 0) {
    return (
      <section className="stack measure" style={{ padding: 'var(--space-6)' }}>
        <div className="path__nav-bar">
          <button
            type="button"
            className="btn btn--plain meta"
            onClick={() => onNavigate('/paths')}
          >
            ← All paths
          </button>
        </div>
        <p className="meta">Learning Path</p>
        <h1 className="path__title">{path.title}</h1>
        <p>
          Nothing on this path is readable to you yet. Its steps point at sources that are not
          published, or not published to you.
        </p>
      </section>
    );
  }

  // Render Completion Screen if path is completed or no active undone step
  if (isCompleted || !currentStep) {
    return (
      <section className="stack measure path__completion" style={{ padding: 'var(--space-6)' }}>
        <div className="path__nav-bar">
          <button
            type="button"
            className="btn btn--plain meta"
            onClick={() => onNavigate('/paths')}
          >
            ← All paths
          </button>
          <span className="paths__item-status paths__item-status--completed">Completed</span>
        </div>

        <p className="meta">Path Complete</p>
        <h1 className="display">{path.title}</h1>
        <p className="path__question">{path.question}</p>

        {/*
          True since 20260909010000, and only as far as it says. Every step a reader
          advances puts its idea into `knowledge_states`, and a step tested out of was
          there already -- so "all N" holds. The three-day sentence is the apply step's
          alone, and only when the reader actually applied it rather than testing out.
        */}
        <div className="path__recap-card">
          <p className="meta" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            In your review schedule
          </p>
          <p>
            {ideaCount === 1 ? (
              <>
                The <strong>one idea</strong> on this path is
              </>
            ) : (
              <>
                All <strong>{ideaCount} ideas</strong> on this path are
              </>
            )}{' '}
            in your review schedule now, and will come round as they start to fade.
            {applied ? ' The one you applied will come round within three days.' : ''}
          </p>
        </div>

        <div className="path__actions">
          {onGoToReview && (
            <button type="button" className="btn btn--primary" onClick={onGoToReview}>
              Practise in Review
            </button>
          )}
          <button type="button" className="btn" onClick={() => onNavigate('/paths')}>
            Explore next path
          </button>
        </div>
      </section>
    );
  }

  const copy = stepCopy(currentStep.kind);
  const isVisitor = userId === null;

  return (
    <main className="stack measure path__container" style={{ padding: 'var(--space-6)' }}>
      {/* Navigation & Status Header */}
      <div className="path__nav-bar">
        <button type="button" className="btn btn--plain meta" onClick={() => onNavigate('/paths')}>
          ← Paths
        </button>
        <div className="path__nav-meta">
          <span className="meta">
            Step {currentStep.ordinal} of {totalSteps}
          </span>
          {userId && (
            <button
              type="button"
              className="btn btn--plain meta"
              disabled={inFlight}
              onClick={handlePauseToggle}
            >
              {path.pausedAt ? 'Resume path' : 'Pause'}
            </button>
          )}
          {userId && (
            <button
              type="button"
              className="btn btn--plain meta"
              disabled={inFlight}
              onClick={handleTestOut}
              title="Test out of ideas you already hold"
            >
              Test out
            </button>
          )}
        </div>
      </div>

      {path.pausedAt && (
        <div className="path__paused-banner" role="status">
          <p className="meta">
            This path is currently paused. Advancing a step will automatically resume it.
          </p>
        </div>
      )}

      {/* Path Title & Question Context */}
      <div className="path__headline-area">
        <p className="meta">{path.topicSlug ? `${path.topicSlug} · Path` : 'Path'}</p>
        <h1 className="path__title">{path.title}</h1>
        <p className="path__step-badge meta">
          {copy.action} · Step {currentStep.ordinal} of {totalSteps}
        </p>
      </div>

      {/* Microlearning Prompt Directive */}
      <div className="path__prompt-box">
        <p className="path__prompt-text">{currentStep.prompt}</p>
      </div>

      {/* Step Kind Renderers */}
      {currentStep.kind === 'read' && (
        <div className="path__step-content">
          <PullCard
            source={{
              title: currentStep.pull.work.title,
            }}
            headline={currentStep.pull.headline}
            body={currentStep.pull.body ?? ''}
            whyItMatters={currentStep.pull.whyItMatters}
            example={currentStep.pull.example}
            explanation={currentStep.pull.explanation}
          />
          <div className="path__step-actions">
            {isVisitor ? (
              <p className="meta">Sign in to keep your place in this path.</p>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={inFlight}
                onClick={() => completeStep(currentStep)}
              >
                Got it — next step
              </button>
            )}
          </div>
        </div>
      )}

      {currentStep.kind === 'predict' && (
        <div className="path__step-content stack">
          {!predictRevealed ? (
            <div className="stack">
              <label className="field__label" htmlFor="predict-input">
                Your prediction
              </label>
              <textarea
                id="predict-input"
                className="field__textarea"
                value={prediction}
                onChange={(e) => setPrediction(e.target.value)}
                placeholder="What mechanism or consequence do you foresee?"
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setPredictRevealed(true)}
              >
                Reveal the answer
              </button>
            </div>
          ) : (
            <div className="stack">
              <PullCard
                source={{
                  title: currentStep.pull.work.title,
                }}
                headline={currentStep.pull.headline}
                body={currentStep.pull.body ?? ''}
                whyItMatters={currentStep.pull.whyItMatters}
                example={currentStep.pull.example}
                explanation={currentStep.pull.explanation}
              />
              <div className="path__step-actions">
                {isVisitor ? (
                  <p className="meta">Sign in to keep your place in this path.</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={inFlight}
                    onClick={() => completeStep(currentStep)}
                  >
                    Continue to comparison
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {currentStep.kind === 'compare' && (
        <div className="path__step-content stack">
          <div className="path__compare-grid">
            <div className="path__compare-card">
              <p className="meta">{currentStep.pull.work.title}</p>
              <h3>{currentStep.pull.headline}</h3>
              {currentStep.pull.body && <p>{currentStep.pull.body}</p>}
            </div>

            {currentStep.comparePull && (
              <div className="path__compare-card">
                <p className="meta">{currentStep.comparePull.work.title}</p>
                <h3>{currentStep.comparePull.headline}</h3>
                {currentStep.comparePull.body && <p>{currentStep.comparePull.body}</p>}
              </div>
            )}
          </div>

          <div className="path__conviction-bar">
            <p className="meta">Where do you stand on this tension?</p>
            <div className="btn-group">
              <button
                type="button"
                className={`btn ${compareStance === 'agree' ? 'btn--primary' : ''}`}
                onClick={() => setCompareStance('agree')}
              >
                Agree
              </button>
              <button
                type="button"
                className={`btn ${compareStance === 'disagree' ? 'btn--primary' : ''}`}
                onClick={() => setCompareStance('disagree')}
              >
                Disagree
              </button>
              <button
                type="button"
                className={`btn ${compareStance === 'unsure' ? 'btn--primary' : ''}`}
                onClick={() => setCompareStance('unsure')}
              >
                Unsure
              </button>
            </div>
          </div>

          <div className="path__step-actions">
            {isVisitor ? (
              <p className="meta">Sign in to keep your place in this path.</p>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={inFlight || !compareStance}
                onClick={() => completeStep(currentStep)}
              >
                Record stance & continue
              </button>
            )}
          </div>
        </div>
      )}

      {currentStep.kind === 'say_it_back' && (
        <div className="path__step-content stack">
          <div className="field">
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
            >
              <label className="field__label" htmlFor="say-it-back-input">
                In your own words
              </label>
              {dictation.supported && (
                <button
                  type="button"
                  className="btn btn--plain meta"
                  style={{ textDecoration: 'underline' }}
                  onClick={dictation.toggle}
                >
                  {dictation.listening ? 'Stop' : 'Dictate'}
                </button>
              )}
            </div>
            <textarea
              id="say-it-back-input"
              className="field__textarea"
              maxLength={20000}
              value={sayItBackText}
              onChange={(e) => setSayItBackText(e.target.value)}
              placeholder="State the core insight and its boundaries in your own words..."
            />
            {/* Always mounted: a live region inserted at the same moment as its text is
                usually not announced at all, because there was no region to observe. */}
            <p className="meta" aria-live="polite">
              {dictation.listening ? dictation.interim || 'Listening…' : ''}
            </p>
            {dictation.error ? (
              <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
                {dictation.error}
              </p>
            ) : null}
            {dictation.supported ? <p className="meta">{DICTATION_DISCLOSURE}</p> : null}
          </div>

          <div className="path__step-actions">
            {isVisitor ? (
              <p className="meta">Sign in to keep your place in this path.</p>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={inFlight || !sayItBackText.trim()}
                onClick={() => completeStep(currentStep)}
              >
                Save comprehension & continue
              </button>
            )}
          </div>
        </div>
      )}

      {currentStep.kind === 'apply' && (
        <div className="path__step-content stack">
          <div className="field">
            <label className="field__label" htmlFor="apply-input">
              Your real-world application
            </label>
            <textarea
              id="apply-input"
              className="field__textarea"
              // `notes_body_length` refuses more, and `apply_path_step` refuses it
              // before writing; the field says so first.
              maxLength={20000}
              value={applyText}
              onChange={(e) => setApplyText(e.target.value)}
              placeholder="Name a concrete situation, choice, or friction from your own week where this applies..."
            />
          </div>

          <div className="path__step-actions">
            {isVisitor ? (
              <p className="meta">Sign in to keep your place in this path.</p>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={inFlight || !applyText.trim()}
                onClick={() => completeStep(currentStep)}
              >
                Apply and finish path
              </button>
            )}
          </div>
        </div>
      )}

      {/* Under whichever step is showing. The catch used to log and say nothing, so a
          reader whose save failed watched the button re-enable and had to guess. */}
      {stepError ? (
        <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
          {stepError}
        </p>
      ) : null}
    </main>
  );
}
