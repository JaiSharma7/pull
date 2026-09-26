import { useEffect, useRef, useState } from 'react';
import { isOfflineFailure } from '../lib/offline.js';
import { sqlDetail, sqlState } from '../lib/rpc-error.js';
import {
  asSentence,
  courseSelectionProblem,
  GOAL_SUGGESTIONS,
  MAX_COURSE_SOURCES,
  preparationRefusal,
} from '../lib/study-course.js';
import { buildCourse, courseBuildingAvailable } from '../lib/study-course-api.js';
import type { SavedStudySource } from '../lib/study-source-api.js';
import { mutationId } from '../lib/submission.js';

/**
 * Turn saved sources into a course: choose one to five, say what the course is for, and
 * agree -- each time -- that the chosen text goes to the model provider. Offered only to a
 * reader the server says may prepare courses (the beta allowlist); for anyone else it says
 * so rather than showing a form that would be refused.
 */
export function StudyCourseBuilder({
  sources,
  onNavigate,
}: {
  sources: readonly SavedStudySource[];
  onNavigate?: (to: string) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [goal, setGoal] = useState<string>(GOAL_SUGGESTIONS[0]);
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submission = useRef<string | null>(null);

  // Whether this account may make courses. A check that could not be made is said as that,
  // with a way to ask again -- not as the beta's refusal, which it is not.
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [check, setCheck] = useState(0);
  // Asked again from its own button: the section stays drawn while it asks, and its heading
  // takes focus when the answer comes, rather than focus falling to the top of the page.
  const [checking, setChecking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    courseBuildingAvailable(controller.signal)
      .then((ok) => {
        if (controller.signal.aborted) return;
        setCheckFailed(null);
        setAvailable(ok);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setCheckFailed(
          isOfflineFailure(e)
            ? 'Whether courses are open to this account needs a connection to check.'
            : 'Whether courses are open to this account could not be checked just now.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [check]);
  const asked = useRef(false);
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!asked.current || checking) return;
    asked.current = false;
    // Only when the reader is still waiting on it: one who has moved on keeps their place.
    const at = document.activeElement;
    if (at === null || at === document.body || at === again.current) heading.current?.focus();
  }, [checking]);

  // A version no longer saved cannot stay chosen.
  const present = new Set(sources.map((s) => s.id));
  const selected = chosen.filter((id) => present.has(id));

  const title = (
    <h2
      id="course-builder-heading"
      ref={heading}
      tabIndex={-1}
      style={{ fontSize: 'var(--step-1)' }}
    >
      Make a course from your sources
    </h2>
  );

  if (checkFailed || checking) {
    return (
      <section className="stack" aria-labelledby="course-builder-heading">
        {title}
        <p role="status">{checking ? 'Checking…' : checkFailed}</p>
        {/* Kept while it checks, so focus stays on the control the reader pressed, and under
            the same name: the line above says it is checking, and a focused button renamed
            to the same words was heard twice. */}
        <p>
          <button
            ref={again}
            type="button"
            className="btn"
            aria-disabled={checking}
            onClick={() => {
              if (checking) return;
              asked.current = true;
              setChecking(true);
              setCheck((n) => n + 1);
            }}
          >
            Check again
          </button>
        </p>
      </section>
    );
  }

  if (available === null) return null;

  // Said with or without saved sources: a reader sent here to make a course learns whether
  // they can before they save anything.
  if (!available) {
    return (
      <section className="stack" aria-labelledby="course-builder-heading">
        {title}
        <p>
          Courses are in a limited beta and are not open to this account yet. Your saved sources
          stay private either way.
        </p>
      </section>
    );
  }

  if (sources.length === 0) {
    return (
      <section className="stack" aria-labelledby="course-builder-heading">
        {title}
        <p>Save a source above, then make a course from it here.</p>
      </section>
    );
  }

  // A different request is agreed to anew: changing what would be sent clears the consent.
  const toggle = (id: string) => {
    submission.current = null;
    setConsent(false);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };

  const problem = courseSelectionProblem(selected.length, goal);

  const build = async () => {
    if (working) return;
    setError(null);
    setNotice(null);
    if (problem) {
      setError(problem);
      return;
    }
    if (!consent) {
      setError('Confirm first that the chosen text may be sent to the model provider.');
      return;
    }
    setWorking(true);
    // Kept across retries of the same request, so a lost response is answered by the
    // course already queued rather than by a second one.
    submission.current ??= mutationId();
    try {
      const queued = await buildCourse({
        versionIds: selected,
        goal: goal.trim(),
        mutationId: submission.current,
        consent,
      });
      submission.current = null;
      setConsent(false);
      setChosen([]);
      if (queued.courseId && onNavigate) {
        onNavigate(`/course/${encodeURIComponent(queued.courseId)}`);
      } else {
        setNotice('Your course is being prepared. It will appear under Courses.');
      }
    } catch (e: unknown) {
      const state = sqlState(e);
      // A refusal is final for this request, and a new attempt is a new request. Anything
      // else -- no answer at all -- may have been queued, so a retry keeps the same id.
      if (state !== undefined) {
        submission.current = null;
        setConsent(false);
      }
      setError(
        isOfflineFailure(e)
          ? 'That has not reached your account — you look offline. Try again when you reconnect.'
          : (preparationRefusal(state, sqlDetail(e)) ??
              asSentence(e instanceof Error ? e.message : String(e))),
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="stack" aria-labelledby="course-builder-heading">
      {title}
      <p className="studio__consent">
        Making a course sends the title and text of the sources you choose, and what you say the
        course is for, to Google’s Gemini API, which finds the claims in them and writes short
        lessons and questions. The course is stored privately in your account and is never
        published. Nothing is sent until you confirm below.
      </p>
      <fieldset className="course-builder__sources">
        <legend className="meta">
          Sources (up to {MAX_COURSE_SOURCES}, 200,000 characters in all)
        </legend>
        {sources.map((s) => (
          <label key={s.id} className="course-builder__source">
            <input
              type="checkbox"
              checked={selected.includes(s.id)}
              onChange={() => toggle(s.id)}
            />{' '}
            {s.title} <span className="meta">version {s.versionNo}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor="course-builder-goal">
          What is the course for?
        </label>
        <input
          id="course-builder-goal"
          className="field__input"
          maxLength={300}
          list="course-builder-goals"
          value={goal}
          onChange={(e) => {
            submission.current = null;
            setConsent(false);
            setGoal(e.target.value);
          }}
        />
        <datalist id="course-builder-goals">
          {GOAL_SUGGESTIONS.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
      <label>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
        Send the chosen sources and the goal to the model provider to make this course.
      </label>
      {error && (
        <p className="remember__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="meta" role="status">
          {notice}
        </p>
      )}
      <p>
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={working || problem !== null}
          onClick={() => void build()}
        >
          {working ? 'Working…' : 'Make the course'}
        </button>
      </p>
    </section>
  );
}
