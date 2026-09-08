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
import { mutationId, nextSubmissionStamp } from '../lib/submission.js';
import { recognitionSupported, startRecognition } from '../lib/speech.js';
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
  const [sayItBackListening, setSayItBackListening] = useState(false);
  const [sayItBackInterim, setSayItBackInterim] = useState('');

  const [applyText, setApplyText] = useState('');

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
    try {
      if (path.pausedAt) {
        await resumePath(path.id);
      } else {
        await pausePath(path.id);
      }
      await reloadPath();
    } catch (e) {
      console.error('Failed to toggle path pause', e);
    } finally {
      setInFlight(false);
    }
  };

  const handleTestOut = async () => {
    if (!path || inFlight || !userId) return;
    setInFlight(true);
    try {
      await testOut(path.id);
      await reloadPath();
    } catch (e) {
      console.error('Failed to test out of path', e);
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
    setInFlight(true);
    try {
      if (step.kind === 'read') {
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'predict') {
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'compare') {
        if (compareStance) {
          const mId = mutationId();
          const stamp = nextSubmissionStamp();
          await setConviction(step.pull.id, compareStance, mId, stamp);
        }
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'say_it_back') {
        if (sayItBackText.trim()) {
          const mId = mutationId();
          await saveExplanation(userId, step.pull.id, sayItBackText.trim(), mId);
        }
        await advanceStep(path.id, step.ordinal);
      } else if (step.kind === 'apply') {
        const mId = mutationId();
        await applyStep(path.id, step.ordinal, applyText.trim(), mId);
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
    } finally {
      setInFlight(false);
    }
  };

  const toggleSayItBackDictation = () => {
    if (sayItBackListening) {
      setSayItBackListening(false);
      setSayItBackInterim('');
      return;
    }

    const teardown = startRecognition({
      onResult: (text) =>
        setSayItBackText((prev) => (prev ? `${prev} ${text.trim()}` : text.trim())),
      onInterim: setSayItBackInterim,
      onEnd: () => {
        setSayItBackListening(false);
        setSayItBackInterim('');
      },
      onError: () => {
        setSayItBackListening(false);
        setSayItBackInterim('');
      },
    });

    setSayItBackListening(true);
    return teardown;
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
  const isCompleted = path.completedAt !== null || activeOrdinal === null;
  const currentStep =
    activeOrdinal !== null ? (path.steps.find((s) => s.ordinal === activeOrdinal) ?? null) : null;

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

        <div className="path__recap-card">
          <p className="meta" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Rotation updated
          </p>
          <p>
            All <strong>{totalSteps} ideas</strong> in this progression have been integrated into
            your metacognitive review schedule. Ideas with applications will resurface within three
            days to test your practical retention.
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
              {recognitionSupported() && (
                <button
                  type="button"
                  className="btn btn--plain meta"
                  style={{ textDecoration: 'underline' }}
                  onClick={toggleSayItBackDictation}
                >
                  {sayItBackListening ? 'Stop' : 'Dictate'}
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
            {sayItBackInterim && (
              <p className="meta" aria-live="polite">
                {sayItBackInterim}
              </p>
            )}
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
    </main>
  );
}
