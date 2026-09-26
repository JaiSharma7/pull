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
import { useId, useState } from 'react';
import {
  LESSON_FIELD_LIMITS,
  REPORT_NOTE_LIMIT,
  REPORT_REASONS,
  lessonDraftProblem,
  type LessonDraft,
  type ReportKind,
  type ReportReason,
} from '../lib/study-course.js';

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
  error,
  onSubmit,
  onCancel,
}: {
  kind: ReportKind;
  working: boolean;
  error: string | null;
  onSubmit: (reason: ReportReason, note: string | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const reasons = REPORT_REASONS[kind];
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<string | null>(null);

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
        <legend className="meta">
          {kind === 'lesson' ? 'What is wrong with this lesson?' : 'What is wrong with this claim?'}
        </legend>
        {reasons.map((r) => (
          <label key={r.reason}>
            <input
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
      <p className="meta">
        {kind === 'lesson'
          ? 'Reporting holds the lesson back from this course at once. You can restore it later.'
          : 'Reporting holds the claim back, and every lesson that rests on it. You can restore them later.'}
      </p>
      <Problem text={local ?? error} />
      <div className="course__actions">
        <button type="button" className="btn btn--primary" aria-disabled={working} onClick={submit}>
          {working ? 'Sending…' : 'Send the report'}
        </button>
        <button type="button" className="btn btn--plain" onClick={onCancel}>
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
  working,
  error,
  onSave,
  onCancel,
}: {
  initial: LessonDraft;
  working: boolean;
  error: string | null;
  onSave: (draft: LessonDraft) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<LessonDraft>(initial);
  const [local, setLocal] = useState<string | null>(null);

  const save = () => {
    if (working) return;
    const problem = lessonDraftProblem(draft);
    setLocal(problem);
    if (!problem) onSave(draft);
  };

  return (
    <div className="stack course__fix-form">
      <p className="meta">
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
              id={`${id}-${f.key}`}
              className="field__input"
              maxLength={LESSON_FIELD_LIMITS[f.key]}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          ) : (
            <textarea
              id={`${id}-${f.key}`}
              className="field__input"
              rows={f.rows}
              maxLength={LESSON_FIELD_LIMITS[f.key]}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      {draft.unitTitle.trim() !== initial.unitTitle.trim() && (
        <p className="meta">A new unit title renames the whole unit.</p>
      )}
      <Problem text={local ?? error} />
      <div className="course__actions">
        <button type="button" className="btn btn--primary" aria-disabled={working} onClick={save}>
          {working ? 'Saving…' : 'Save the correction'}
        </button>
        <button type="button" className="btn btn--plain" onClick={onCancel}>
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
  items: readonly { reportId: string; kind: ReportKind; label: string }[];
  working: boolean;
  onRestore: (reportId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="course-held-title">
      <h2 id="course-held-title" className="course__subheading">
        Held back by your reports
      </h2>
      <p className="meta">
        Restoring one says the report was mistaken. A lesson that rests on a claim you reported
        returns when the claim does.
      </p>
      <ul className="course__held">
        {items.map((item) => (
          <li key={item.reportId} className="course__held-item">
            <span>
              <span className="meta">{item.kind === 'lesson' ? 'Lesson' : 'Claim'}</span>{' '}
              {item.label}
            </span>
            <button
              type="button"
              className="btn btn--plain"
              aria-disabled={working}
              onClick={() => onRestore(item.reportId)}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
