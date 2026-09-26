/**
 * What a reader can do about a lesson or a claim that is wrong: report it, correct it,
 * withdraw it, and restore what they reported. Presentational -- the container does the
 * calls -- so each renders to a string in a test.
 *
 * The rules are the database's (`docs/study-validation.md`, "Reports and corrections"):
 * a report holds its target back at once, a correction is a new version of the lesson in
 * the reader's own words, and a withdrawal is for good. None of them is ever proof of
 * anything.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  LESSON_FIELD_LIMITS,
  REPORT_NOTE_LIMIT,
  REPORT_REASONS,
  lessonDraftProblem,
  type LessonDraft,
  type ReportKind,
  type ReportReason,
} from '../lib/study-course.js';

const REPORT_QUESTION: Record<ReportKind, string> = {
  lesson: 'What is wrong with this lesson?',
  claim: 'What is wrong with this claim?',
  item: 'What is wrong with this question?',
};

const HELD_KIND: Record<ReportKind, string> = {
  lesson: 'Lesson',
  claim: 'Claim',
  item: 'Question',
};

const REPORT_EFFECT: Record<ReportKind, string> = {
  lesson: 'Reporting holds the lesson back from this course at once. You can restore it later.',
  claim:
    'Reporting holds the claim back, and every lesson and question that rests on it. You can restore them later.',
  item: 'Reporting holds the question back at once, and nothing you answer to it counts while it is held. You can restore it later.',
};

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="remember__error" role="alert">
      {text}
    </p>
  );
}

export function ReportForm({
  kind,
  working,
  sending = working,
  error,
  onSubmit,
  onCancel,
}: {
  kind: ReportKind;
  /** A change to the course is on its way, from this form or another: nothing here acts. */
  working: boolean;
  /** This form's own report is the one on its way. */
  sending?: boolean;
  error: string | null;
  onSubmit: (reason: ReportReason, note: string | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const reasons = REPORT_REASONS[kind];
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  // The form replaces the control that opened it, so focus moves into it rather than to the
  // top of the page.
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const submit = () => {
    if (working) return;
    if (!reason) {
      setLocal('Choose what is wrong first.');
      return;
    }
    setLocal(null);
    onSubmit(reason, note.trim() || null);
  };

  return (
    <div className="stack course__fix-form">
      <fieldset className="course__reasons">
        <legend className="meta">{REPORT_QUESTION[kind]}</legend>
        {reasons.map((r, i) => (
          <label key={r.reason}>
            <input
              ref={i === 0 ? first : undefined}
              type="radio"
              name={`${id}-reason`}
              value={r.reason}
              checked={reason === r.reason}
              onChange={() => setReason(r.reason)}
            />{' '}
            {r.label}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-note`}>
          A note, if it helps (optional)
        </label>
        <textarea
          id={`${id}-note`}
          className="field__input"
          rows={3}
          maxLength={REPORT_NOTE_LIMIT}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <p>{REPORT_EFFECT[kind]}</p>
      <Problem text={local ?? error} />
      <div className="course__actions">
        <button type="button" className="btn btn--primary" aria-disabled={working} onClick={submit}>
          {sending ? 'Sending…' : 'Send the report'}
        </button>
        {/* Waits for a change on its way, as the screen's other ways out do: a form closed
            under its own request had nowhere to say that it failed. */}
        <button
          type="button"
          className="btn btn--plain"
          aria-disabled={working}
          onClick={() => {
            if (!working) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const FIELDS: { key: keyof LessonDraft; label: string; rows: number }[] = [
  { key: 'unitTitle', label: 'Unit title', rows: 1 },
  { key: 'title', label: 'Title', rows: 1 },
  { key: 'objective', label: 'By the end you should be able to', rows: 2 },
  { key: 'explanation', label: 'Explanation (a blank line starts a new paragraph)', rows: 10 },
  { key: 'example', label: 'Example (optional)', rows: 4 },
  { key: 'recap', label: 'Recap to say from memory', rows: 2 },
];

/**
 * The lesson's text, to correct in place. Saving makes a new version in the reader's own
 * words; the course keeps the reader's place in it.
 */
export function LessonCorrectionForm({
  initial,
  draft,
  working,
  sending = working,
  error,
  onDraft,
  onSave,
  onCancel,
}: {
  /** The lesson as it reads now. */
  initial: LessonDraft;
  /**
   * The reader's edit, held by the screen rather than here, so closing the form -- to
   * report a claim, or by folding the section -- does not throw the typing away.
   */
  draft: LessonDraft;
  /** A change to the course is on its way, from this form or another: nothing here acts. */
  working: boolean;
  /** This form's own correction is the one on its way. */
  sending?: boolean;
  error: string | null;
  onDraft: (draft: LessonDraft) => void;
  onSave: (draft: LessonDraft) => void;
  /** Cancel is the one control that discards the draft. */
  onCancel: () => void;
}) {
  const id = useId();
  const [local, setLocal] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const save = () => {
    if (working) return;
    const problem = lessonDraftProblem(draft);
    setLocal(problem);
    if (!problem) onSave(draft);
  };

  return (
    <div className="stack course__fix-form">
      <p>
        Your correction becomes this lesson's text in your course. It is checked as a model's would
        be, but a lesson in your own words is practice, never proof of what you remember.
      </p>
      {FIELDS.map((f) => (
        <div className="field" key={f.key}>
          <label className="field__label" htmlFor={`${id}-${f.key}`}>
            {f.label}
          </label>
          {f.rows === 1 ? (
            <input
              ref={f.key === FIELDS[0]!.key ? first : undefined}
              id={`${id}-${f.key}`}
              className="field__input"
              maxLength={LESSON_FIELD_LIMITS[f.key]}
              value={draft[f.key]}
              onChange={(e) => onDraft({ ...draft, [f.key]: e.target.value })}
            />
          ) : (
            <textarea
              id={`${id}-${f.key}`}
              className="field__input"
              rows={f.rows}
              maxLength={LESSON_FIELD_LIMITS[f.key]}
              value={draft[f.key]}
              onChange={(e) => onDraft({ ...draft, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      {draft.unitTitle.trim() !== initial.unitTitle.trim() && (
        <p>A new unit title renames the whole unit.</p>
      )}
      <Problem text={local ?? error} />
      <div className="course__actions">
        <button type="button" className="btn btn--primary" aria-disabled={working} onClick={save}>
          {sending ? 'Saving…' : 'Save the correction'}
        </button>
        {/* Waits for a change on its way, as the screen's other ways out do: a form closed
            under its own request had nowhere to say that it failed. */}
        <button
          type="button"
          className="btn btn--plain"
          aria-disabled={working}
          onClick={() => {
            if (!working) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What the reader has reported and not yet settled, each with a way to bring it back. */
export function HeldBackList({
  items,
  working,
  onRestore,
}: {
  items: readonly { kind: ReportKind; id: string; label: string }[];
  working: boolean;
  onRestore: (item: { kind: ReportKind; id: string }) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="course-held-title">
      <h2 id="course-held-title" className="course__subheading" tabIndex={-1}>
        Held back by your reports
      </h2>
      <p>
        Restoring one says the report was mistaken. A lesson that rests on a claim you reported
        returns when the claim does.
      </p>
      <ul className="course__held">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="course__held-item">
            <span>
              <span className="meta">{HELD_KIND[item.kind]}</span> {item.label}
            </span>
            <button
              type="button"
              className="btn btn--plain"
              aria-disabled={working}
              onClick={() => onRestore({ kind: item.kind, id: item.id })}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
