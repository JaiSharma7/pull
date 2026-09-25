/**
 * One practice question of a study course, of any kind, with its feedback.
 *
 * The card grades the reader's response with the browser's copy of the server's rule
 * (`study-grade.ts`), so the feedback is immediate and works offline, and hands the response
 * to the container, which records it -- the server grades it again and keeps its own grade.
 * A short recall answer that does not match is compared by the reader with the course's
 * answer, and that self-grade is recorded as such: practice, never proof.
 *
 * Archive rules (docs/design.md): the verdict is said in words, never by colour alone, and
 * every control is a real button, input or select a keyboard reaches.
 */
import { useId, useState, type ReactNode } from 'react';
import { gradeStudyResponse, type Graded, type SelfGrade } from '../lib/study-grade.js';
import {
  choiceOptions,
  clozeParts,
  initialOrder,
  matchingChoices,
  moveStep,
  rightAnswer,
  whyChosenWrong,
  type StudyQuestion,
} from '../lib/study-practice.js';
import { Paragraphs } from './CourseParts.js';

export interface SubmittedAnswer {
  response: string | number[];
  selfGrade?: SelfGrade;
  hinted: boolean;
  graded: Graded;
}

type Phase =
  | { kind: 'answering' }
  | { kind: 'judging'; typed: string }
  | { kind: 'done'; answer: SubmittedAnswer; chosen: string | null };

const PURPOSE_LABEL: Record<StudyQuestion['purpose'], string> = {
  placement: 'Check what you know',
  practice: 'Practice',
  review: 'Review',
};

export function StudyQuestionCard({
  question,
  label,
  onAnswer,
  onNext,
  nextLabel = 'Next',
  renderHint,
  renderFixes,
}: {
  question: StudyQuestion;
  /** Where the question sits, e.g. "Question 2 of 3". */
  label: string;
  onAnswer: (answer: SubmittedAnswer) => void;
  onNext: () => void;
  nextLabel?: string;
  /** The passages the question rests on; opening them before answering makes it hinted. */
  renderHint?: () => ReactNode;
  /** Report or withdraw the question. */
  renderFixes?: () => ReactNode;
}) {
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'answering' });
  const [choice, setChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [order, setOrder] = useState<number[]>(() => initialOrder(question));
  const [matches, setMatches] = useState<(number | null)[]>(() => question.pairs.map(() => null));
  const [hinted, setHinted] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const finish = (response: string | number[], graded: Graded, selfGrade?: SelfGrade) => {
    const answer: SubmittedAnswer = {
      response,
      hinted,
      graded,
      ...(selfGrade ? { selfGrade } : {}),
    };
    onAnswer(answer);
    setPhase({ kind: 'done', answer, chosen: typeof response === 'string' ? response : null });
  };

  const check = () => {
    setProblem(null);
    let response: string | number[];
    switch (question.kind) {
      case 'multiple_choice':
      case 'comparison':
      case 'application':
        if (choice === null) {
          setProblem('Choose an answer first.');
          return;
        }
        response = choice;
        break;
      case 'cloze':
      case 'short_recall':
        if (typed.trim() === '') {
          setProblem('Type an answer first — a guess counts.');
          return;
        }
        response = typed.trim();
        break;
      case 'ordering':
        response = order;
        break;
      case 'matching':
        if (matches.some((m) => m === null)) {
          setProblem('Match every item first.');
          return;
        }
        response = matches as number[];
        break;
    }
    const graded = gradeStudyResponse(question, response);
    if (graded) {
      finish(response, graded);
      return;
    }
    if (question.kind === 'short_recall' && typeof response === 'string') {
      setPhase({ kind: 'judging', typed: response });
      return;
    }
    setProblem('That answer could not be checked. Try again.');
  };

  const judge = (self: SelfGrade) => {
    if (phase.kind !== 'judging') return;
    const graded = gradeStudyResponse(question, phase.typed, self);
    if (graded) finish(phase.typed, graded, self);
  };

  const retry = () => {
    setAttempt((n) => n + 1);
    setPhase({ kind: 'answering' });
    setChoice(null);
    setTyped('');
    setOrder(initialOrder(question));
    setMatches(question.pairs.map(() => null));
    setProblem(null);
  };

  const answering = phase.kind === 'answering';
  const promptId = `${id}-prompt`;

  return (
    <section className="stack study-q" aria-labelledby={promptId}>
      <p className="meta">
        {PURPOSE_LABEL[question.purpose]} · {label}
        {attempt > 0 ? ' · another try' : ''}
      </p>
      <h2 id={promptId} className="study-q__prompt" tabIndex={-1}>
        {question.prompt}
      </h2>
      {question.authoredBy === 'reader' && (
        <p className="meta">Your own version of this question: practice, not proof.</p>
      )}

      {(question.kind === 'multiple_choice' ||
        question.kind === 'comparison' ||
        question.kind === 'application') && (
        <fieldset className="study-q__options" disabled={!answering}>
          <legend className="sr-only">Choose one</legend>
          {choiceOptions(question).map((option, i) => (
            <label key={`${option}-${i}`} className="study-q__option">
              <input
                type="radio"
                name={`${id}-choice-${attempt}`}
                value={option}
                checked={choice === option}
                onChange={() => setChoice(option)}
              />{' '}
              {option}
            </label>
          ))}
        </fieldset>
      )}

      {question.kind === 'cloze' && question.cloze && (
        <p className="study-q__cloze">
          {clozeParts(question.cloze).before}
          <input
            className="field__input study-q__blank"
            aria-label="The missing word or words"
            value={typed}
            maxLength={1000}
            disabled={!answering}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') check();
            }}
          />
          {clozeParts(question.cloze).after}
        </p>
      )}

      {question.kind === 'short_recall' && (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-typed`}>
            Your answer, from memory
          </label>
          <textarea
            id={`${id}-typed`}
            className="field__input"
            rows={3}
            maxLength={1000}
            value={phase.kind === 'judging' ? phase.typed : typed}
            disabled={!answering}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}

      {question.kind === 'ordering' && (
        <ol className="study-q__steps" aria-label="Your order">
          {order.map((step, i) => {
            const text = question.sequence[step] ?? '';
            return (
              <li key={step} className="study-q__step">
                <span>{text}</span>
                {answering && (
                  <span className="study-q__moves">
                    <button
                      type="button"
                      className="btn btn--plain"
                      aria-label={`Move “${text}” up`}
                      aria-disabled={i === 0}
                      onClick={() => setOrder((o) => moveStep(o, i, -1))}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain"
                      aria-label={`Move “${text}” down`}
                      aria-disabled={i === order.length - 1}
                      onClick={() => setOrder((o) => moveStep(o, i, 1))}
                    >
                      Down
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {question.kind === 'matching' && (
        <div className="study-q__pairs">
          {question.pairs.map((pair, i) => (
            <div className="field study-q__pair" key={`${pair.left}-${i}`}>
              <label className="field__label" htmlFor={`${id}-match-${i}`}>
                {pair.left}
              </label>
              <select
                id={`${id}-match-${i}`}
                className="field__input"
                disabled={!answering}
                value={matches[i] ?? ''}
                onChange={(e) =>
                  setMatches((m) =>
                    m.map((v, j) =>
                      j === i ? (e.target.value === '' ? null : Number(e.target.value)) : v,
                    ),
                  )
                }
              >
                <option value="">Choose…</option>
                {matchingChoices(question).map((r) => (
                  <option key={r} value={r}>
                    {question.pairs[r]?.right}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {problem && (
        <p className="remember__error" role="alert">
          {problem}
        </p>
      )}

      {answering && (
        <div className="course__actions">
          <button type="button" className="btn btn--primary" onClick={check}>
            Check
          </button>
          {renderHint && (
            <button
              type="button"
              className="btn btn--plain"
              aria-expanded={hintOpen}
              onClick={() => {
                setHintOpen((o) => !o);
                setHinted(true);
              }}
            >
              {hintOpen ? 'Hide the passage' : 'Show the passage it rests on'}
            </button>
          )}
        </div>
      )}
      {answering && hintOpen && renderHint && (
        <div className="study-q__hint">
          <p className="meta">Looked at before answering, so this answer counts as practice.</p>
          {renderHint()}
        </div>
      )}

      {phase.kind === 'judging' && (
        <div className="stack study-q__judge" role="status">
          <p className="meta">The answer in your course</p>
          <p className="study-q__model">{question.answer}</p>
          <p>Compare it with yours. Did you have it?</p>
          <div className="course__actions">
            <button type="button" className="btn" onClick={() => judge('correct')}>
              I had it
            </button>
            <button type="button" className="btn" onClick={() => judge('incorrect')}>
              Not quite
            </button>
          </div>
          <p className="meta">
            Your own judgement is kept as practice; only an answer the course can check counts
            towards what you have shown you remember.
          </p>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="stack study-q__feedback" role="status">
          <p className="study-q__verdict">
            {phase.answer.graded.correct
              ? phase.answer.graded.grading === 'self'
                ? 'You had it.'
                : 'Right.'
              : 'Not quite.'}
          </p>
          {!phase.answer.graded.correct && (
            <>
              <p className="meta">The answer</p>
              <Paragraphs text={rightAnswer(question).replace(/\n/g, '\n\n')} />
              {phase.chosen && whyChosenWrong(question, phase.chosen, phase.answer.graded) && (
                <p>
                  <span className="meta">Why not “{phase.chosen}”</span>{' '}
                  {whyChosenWrong(question, phase.chosen, phase.answer.graded)}
                </p>
              )}
            </>
          )}
          <Paragraphs text={question.explanation} className="study-q__explanation" />
          <div className="course__actions">
            {!phase.answer.graded.correct && (
              <button type="button" className="btn" onClick={retry}>
                Try again
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={onNext}>
              {nextLabel}
            </button>
          </div>
        </div>
      )}
      {renderFixes?.()}
    </section>
  );
}
