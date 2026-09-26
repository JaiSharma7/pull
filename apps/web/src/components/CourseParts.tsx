/**
 * The presentational parts of a study course: the outline, a lesson, the passage a claim
 * rests on, the end of a session, and the course's closing recap. Props in, markup out --
 * no fetching -- so each can be rendered to a string in a test.
 *
 * Archive rules (docs/design.md): one accent, hairline rules, no shadows; a state is
 * always said in words, never by colour alone; a session ends on a screen of its own.
 */
import type { ReactNode } from 'react';
import {
  lessonLabel,
  toRevisit,
  minutesLabel,
  type CourseSummary,
  type LessonClaim,
  type LessonContent,
  type OutlineLesson,
  type OutlineUnit,
  type PassageWindow,
} from '../lib/study-course.js';

/** Plain text in paragraphs: the model writes blank lines between them. */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className={className}>
          {p}
        </p>
      ))}
    </>
  );
}

export function CourseOutline({
  units,
  currentLessonId,
  onOpen,
}: {
  units: readonly OutlineUnit[];
  currentLessonId?: string | null;
  onOpen: (lesson: OutlineLesson) => void;
}) {
  return (
    <ol className="course__units" aria-label="Course outline">
      {units.map((unit) => (
        <li key={unit.unitNo} className="course__unit">
          <h2 className="course__unit-title">
            <span className="meta">Unit {unit.unitNo}</span> {unit.title}
          </h2>
          <ol className="course__lessons">
            {unit.lessons.map((lesson) => {
              const label = lessonLabel(lesson);
              const current = lesson.lessonId === currentLessonId;
              const stateId = `lesson-state-${lesson.lessonId}`;
              return (
                <li key={lesson.lessonId} className="course__lesson">
                  <button
                    type="button"
                    className="btn btn--plain course__lesson-title"
                    aria-current={current ? 'step' : undefined}
                    // Why it is left out or back is part of what the lesson is.
                    aria-describedby={stateId}
                    onClick={() => onOpen(lesson)}
                  >
                    {lesson.title}
                  </button>
                  <span
                    id={stateId}
                    className={`course__lesson-state${
                      lesson.state === 'read' && !toRevisit(lesson)
                        ? ' course__lesson-state--read'
                        : ''
                    }`}
                  >
                    {current ? 'Next · ' : ''}
                    {label} · {minutesLabel(lesson.minutes)}
                  </span>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

export function PassageInContext({ passage }: { passage: PassageWindow }) {
  return (
    <blockquote className="course__passage">
      {passage.clippedStart ? '… ' : ''}
      {passage.before}
      <mark className="course__span">{passage.span}</mark>
      {passage.after}
      {passage.clippedEnd ? ' …' : ''}
    </blockquote>
  );
}

/**
 * Where a lesson's teaching comes from: each claim it rests on, with the exact passages of
 * the reader's own material. `renderContext` lets the container show a passage in its
 * surrounding text once the reader asks for it.
 */
export function LessonSources({
  claims,
  renderContext,
  renderClaimActions,
}: {
  claims: readonly LessonClaim[];
  renderContext?: (claim: LessonClaim, ordinal: number) => ReactNode;
  renderClaimActions?: (claim: LessonClaim) => ReactNode;
}) {
  if (claims.length === 0) return null;
  return (
    <ul className="course__claims">
      {claims.map((claim) => (
        <li key={claim.claimId} className="course__claim">
          <p className="course__claim-statement">{claim.statement}</p>
          {claim.qualifications.length > 0 && (
            <p className="meta">Qualified: {claim.qualifications.join('; ')}</p>
          )}
          {claim.attribution && <p className="meta">{claim.attribution}</p>}
          {claim.evidence.map((e) => (
            <figure key={e.ordinal} className="course__evidence">
              <blockquote className="prose__quote">{e.spanText}</blockquote>
              <figcaption className="meta">
                {claim.sourceTitle}
                {e.page !== null ? ` · page ${e.page}` : ''}
              </figcaption>
              {renderContext?.(claim, e.ordinal)}
            </figure>
          ))}
          {renderClaimActions?.(claim)}
        </li>
      ))}
    </ul>
  );
}

/** One lesson's text. Where it sits in the session is said by the screen around it. */
export function LessonBody({ lesson, unitTitle }: { lesson: LessonContent; unitTitle: string }) {
  return (
    <article className="course__lesson-body" aria-labelledby="course-lesson-title">
      <p className="meta">
        {unitTitle ? `${unitTitle} · ` : ''}
        {minutesLabel(lesson.minutes)}
      </p>
      {/* Focused when the lesson opens, so a keyboard or screen-reader reader starts here. */}
      <h1 id="course-lesson-title" className="course__lesson-heading" tabIndex={-1}>
        {lesson.title}
      </h1>
      <p className="course__objective">
        <span className="meta">By the end you should be able to</span> {lesson.objective}
      </p>
      <div className="course__explanation">
        <Paragraphs text={lesson.explanation} />
      </div>
      {lesson.example && (
        <div className="course__example">
          <p className="meta">Example</p>
          <Paragraphs text={lesson.example} />
        </div>
      )}
      <div className="course__recap-line">
        <p className="meta">Say it from memory</p>
        <p>{lesson.recap}</p>
      </div>
    </article>
  );
}

/**
 * The end of a session: a screen, not a slide into the next lesson (design law 7). It
 * says what was covered and offers to stop; going on is a choice, not the default.
 */
export function StoppingPoint({
  covered,
  remaining,
  skipped = 0,
  known = 0,
  onDone,
  onContinue,
}: {
  covered: readonly { title: string; recap: string | null }[];
  remaining: number;
  /** Lessons of the course the reader skipped, which the course page offers again. */
  skipped?: number;
  /** Lessons sittings leave out because the reader has shown they know them. */
  known?: number;
  onDone: () => void;
  onContinue: (() => void) | null;
}) {
  return (
    <section className="stack course__stop" aria-labelledby="course-stop-title">
      <p className="meta">End of this sitting</p>
      <h1 id="course-stop-title" className="display" tabIndex={-1}>
        That is a good place to stop.
      </h1>
      {covered.length > 0 && (
        <>
          <p>
            You read {covered.length === 1 ? 'one lesson' : `${covered.length} lessons`}. Before you
            go, try to say each of these from memory:
          </p>
          <ul className="course__covered">
            {covered.map((c, i) => (
              <li key={i}>
                <strong>{c.title}</strong>
                {c.recap ? <span> — {c.recap}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p>
        {remaining > 0
          ? `${remaining === 1 ? 'One lesson is' : `${remaining} lessons are`} left for another sitting.`
          : skipped > 0
            ? `You have been through every lesson. ${
                skipped === 1 ? 'The one you skipped is' : `The ${skipped} you skipped are`
              } on the course page when you want ${skipped === 1 ? 'it' : 'them'}.`
            : known > 0
              ? `That was the last lesson you had left. ${
                  known === 1
                    ? 'The other one you have shown you know; it is'
                    : `The other ${known} you have shown you know; they are`
                } in the outline.`
              : 'That was the last lesson of the course.'}
      </p>
      <div className="course__actions">
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done for now
        </button>
        {onContinue && (
          <button type="button" className="btn" onClick={onContinue}>
            Keep going
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The end of the course: its closing summary, and what the sources cannot settle. Shown once
 * every lesson is read or skipped; how many were read is the progress line's to say.
 */
export function CourseRecap({ course }: { course: CourseSummary }) {
  return (
    <section className="stack course__recap" aria-labelledby="course-recap-title">
      <p className="meta">The end of the course</p>
      <h2 id="course-recap-title">What to remember</h2>
      {course.recap ? <Paragraphs text={course.recap} /> : null}
      {course.disagreements.length > 0 && (
        <>
          <h3 className="course__subheading">Where your sources disagree</h3>
          <ul className="course__notes">
            {course.disagreements.map((d, i) => (
              <li key={i}>{d.description}</li>
            ))}
          </ul>
        </>
      )}
      {course.withheld.length > 0 && (
        <>
          <h3 className="course__subheading">What your sources cannot answer</h3>
          <p>
            Questions your goal suggests that the material does not settle, so the course does not
            pretend to.
          </p>
          <ul className="course__notes">
            {course.withheld.map((w, i) => (
              <li key={i}>
                {w.prompt}
                {w.reason ? <span> — {w.reason}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
