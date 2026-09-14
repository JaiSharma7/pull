import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Meter } from '@wap/ui';
import * as api from '../lib/api.js';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import {
  isOfflineFailure,
  onReconnect,
  pendingRecallPullIds,
  queueMutation,
  readReviewPack,
  removeFromPack,
  storeReviewPack,
} from '../lib/offline.js';
import { mergePack, packLabel, practisingLabel } from '../lib/review-pack.js';
import {
  elapsedSince,
  mutationId as newMutationId,
  nextSubmissionStamp,
} from '../lib/submission.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { DueReview } from '../lib/types.js';
import {
  formatReviewProgress,
  mcqOptionMarker,
  nextSessionTotal,
  resolveActiveQuestion,
  resolveEffectiveKind,
  toActivityQuestion,
} from '../lib/review-question.js';
import { gradeCloze, gradeMcq, mcqOptions, whyWrong, type WhyWrong } from '../lib/activities.js';

interface ActiveReviewCardProps {
  card: DueReview;
  grading: boolean;
  onGrade: (
    g: RecallGrade,
    latencyMs?: number,
    extra?: {
      confidence?: 'sure' | 'unsure';
      questionId?: string;
      answer?: string;
    },
  ) => void;
}

function ActiveReviewCard({ card, grading, onGrade }: ActiveReviewCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [sure, setSure] = useState(false);
  const [clozeInput, setClozeInput] = useState('');

  interface AnsweredState {
    kind: 'mcq' | 'cloze';
    pickedOrTyped: string;
    correct: boolean;
    grade: RecallGrade;
    reason: WhyWrong | null;
    latencyMs?: number;
  }
  const [answered, setAnswered] = useState<AnsweredState | null>(null);
  const displayedAtRef = useRef<number | null>(null);

  useEffect(() => {
    displayedAtRef.current = Date.now();
  }, []);

  const activeQuestion = resolveActiveQuestion(card);
  const activityQ = useMemo(
    () => (activeQuestion ? toActivityQuestion(activeQuestion) : null),
    [activeQuestion],
  );

  const mcqChoices = useMemo(() => {
    if (!activityQ || activityQ.kind !== 'mcq') return [];
    return mcqOptions(activityQ, activityQ.id);
  }, [activityQ]);

  const effectiveKind = resolveEffectiveKind(activityQ, mcqChoices);

  return (
    <div className="pull-card">
      <p className="pull-card__chip">
        {card.workTitle}
        {(activeQuestion?.source ?? card.questionSource) === 'user' && ' · Your question'}
        {effectiveKind === 'mcq' && ' · Multiple choice'}
        {effectiveKind === 'cloze' && ' · Fill the blank'}
      </p>
      <hr className="pull-card__rule" />
      <h2 className="pull-card__headline">
        {activeQuestion?.prompt ?? card.question ?? card.headline}
      </h2>

      {effectiveKind === 'recall' && (
        <>
          {revealed ? (
            <>
              <p className="pull-card__body">{activeQuestion?.answer ?? card.body}</p>
              {(activeQuestion?.explanation ?? card.explanation) && (
                <div
                  style={{
                    marginBottom: 'var(--space-4)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {activeQuestion?.explanation ?? card.explanation}
                  </p>
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {RECALL_GRADES.map((g) => (
                  <button
                    key={g}
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade(g, elapsedSince(revealedAt), {
                        confidence: sure ? 'sure' : 'unsure',
                      })
                    }
                  >
                    {GRADE_LABELS[g]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setRevealed(true);
                  setRevealedAt(Date.now());
                }}
              >
                Show answer
              </button>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--step--1)',
                  color: 'var(--text-muted)',
                }}
              >
                <input
                  type="checkbox"
                  checked={sure}
                  disabled={grading}
                  onChange={(e) => setSure(e.target.checked)}
                />
                I’m sure
              </label>
            </div>
          )}
        </>
      )}

      {effectiveKind === 'mcq' && (
        <>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              margin: 'var(--space-4) 0',
            }}
          >
            {mcqChoices.map((opt) => {
              /* The word is the signal and the colour agrees with it -- law 5, colour is
                 never the only signal. Before this the correct option was an oxblood
                 border and nothing else. */
              const marker = mcqOptionMarker(
                opt,
                activeQuestion?.answer,
                answered?.pickedOrTyped ?? null,
              );

              let borderColor = 'var(--rule-strong)';
              let textColor = 'var(--text)';

              if (marker === 'Correct answer') {
                borderColor = 'var(--accent)';
                textColor = 'var(--accent)';
              } else if (marker === 'Your answer') {
                borderColor = 'var(--rule)';
                textColor = 'var(--text-muted)';
              }

              return (
                <button
                  key={opt}
                  type="button"
                  className="btn"
                  /* `aria-disabled`, not `disabled`: a disabled button is painted at
                     45% opacity, which put the verdict word -- the one thing that names
                     the right option for a wrong pick -- below the contrast floor
                     `docs/design.md` sets for every text role. The handler refuses. */
                  aria-disabled={answered !== null || grading}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                    textAlign: 'left',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                    fontFamily: 'var(--font-body)',
                    fontSize: 'var(--step-0)',
                    padding: 'var(--space-3) var(--space-4)',
                    borderColor,
                    color: textColor,
                  }}
                  onClick={() => {
                    if (answered !== null || grading) return;
                    const latencyMs = elapsedSince(displayedAtRef.current);
                    const res = gradeMcq(opt, activityQ!, sure ? 'sure' : 'unsure', latencyMs);
                    const reason = whyWrong(activityQ!, opt);
                    setAnswered({
                      kind: 'mcq',
                      pickedOrTyped: opt,
                      correct: res.correct,
                      grade: res.grade,
                      reason,
                      latencyMs,
                    });
                  }}
                >
                  <span>{opt}</span>
                  {marker ? <span className="meta">{marker}</span> : null}
                </button>
              );
            })}
          </div>

          {answered === null ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--step--1)',
                color: 'var(--text-muted)',
                marginBottom: 'var(--space-2)',
              }}
            >
              <input
                type="checkbox"
                checked={sure}
                disabled={grading}
                onChange={(e) => setSure(e.target.checked)}
              />
              I’m sure
            </label>
          ) : (
            <div style={{ margin: 'var(--space-4) 0' }}>
              {answered.correct ? (
                <p
                  className="meta"
                  style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}
                >
                  Correct
                </p>
              ) : (
                <p className="meta" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
                  Not quite
                </p>
              )}

              {answered.reason && answered.reason.source === 'distractor' && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Why that’s wrong
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {answered.reason.why}
                  </p>
                </div>
              )}

              {(activeQuestion?.explanation ?? card.explanation) && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {activeQuestion?.explanation ?? card.explanation}
                  </p>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  marginTop: 'var(--space-4)',
                }}
              >
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={grading}
                  onClick={() =>
                    onGrade(answered.grade, answered.latencyMs, {
                      confidence: sure ? 'sure' : 'unsure',
                      answer: answered.pickedOrTyped,
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade('hard', answered.latencyMs, {
                        confidence: sure ? 'sure' : 'unsure',
                        answer: answered.pickedOrTyped,
                      })
                    }
                  >
                    That was hard
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {effectiveKind === 'cloze' && (
        <>
          {activeQuestion?.cloze && (
            <p
              className="pull-card__body"
              style={{ fontStyle: 'italic', margin: 'var(--space-3) 0 var(--space-4)' }}
            >
              {activeQuestion.cloze}
            </p>
          )}

          {answered === null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = clozeInput.trim();
                if (!trimmed) return;
                const latencyMs = elapsedSince(displayedAtRef.current);
                const res = gradeCloze(
                  trimmed,
                  activeQuestion!.answer ?? '',
                  sure ? 'sure' : 'unsure',
                  latencyMs,
                );
                setAnswered({
                  kind: 'cloze',
                  pickedOrTyped: trimmed,
                  correct: res.correct,
                  grade: res.grade,
                  reason: null,
                  latencyMs,
                });
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                margin: 'var(--space-4) 0',
              }}
            >
              <input
                type="text"
                value={clozeInput}
                disabled={grading}
                placeholder="Type your answer…"
                onChange={(e) => setClozeInput(e.target.value)}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--step-0)',
                  border: '1px solid var(--rule-strong)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  color: 'var(--text)',
                  width: '100%',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={!clozeInput.trim() || grading}
                >
                  Check answer
                </button>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--step--1)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sure}
                    disabled={grading}
                    onChange={(e) => setSure(e.target.checked)}
                  />
                  I’m sure
                </label>
              </div>
            </form>
          ) : (
            <div style={{ margin: 'var(--space-4) 0' }}>
              {answered.correct ? (
                <p
                  className="meta"
                  style={{ color: 'var(--accent)', marginBottom: 'var(--space-2)' }}
                >
                  Correct
                </p>
              ) : (
                <p className="meta" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
                  Not quite
                </p>
              )}

              <p className="meta" style={{ marginBottom: 'var(--space-3)' }}>
                Answer: <strong style={{ color: 'var(--text)' }}>{activeQuestion?.answer}</strong>
              </p>

              {(activeQuestion?.explanation ?? card.explanation) && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {activeQuestion?.explanation ?? card.explanation}
                  </p>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  marginTop: 'var(--space-4)',
                }}
              >
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={grading}
                  onClick={() =>
                    onGrade(answered.grade, answered.latencyMs, {
                      confidence: sure ? 'sure' : 'unsure',
                      answer: answered.pickedOrTyped,
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade('hard', answered.latencyMs, {
                        confidence: sure ? 'sure' : 'unsure',
                        answer: answered.pickedOrTyped,
                      })
                    }
                  >
                    That was hard
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 'var(--space-5)' }}>
        <p className="meta" style={{ marginBottom: 'var(--space-2)' }}>
          Strength {Math.round(card.retrievability * 100)}%
        </p>
        <Meter value={card.retrievability} label={`Recall strength for ${card.headline}`} />
      </div>
    </div>
  );
}

/**
 * The deliberate recall destination. The feed is the ambient one — most recall
 * happens there, unannounced. This page is for readers who come looking.
 */
export function Review() {
  const [due, setDue] = useState<DueReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [lostGrade, setLostGrade] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [grading, setGrading] = useState(false);
  const graded = useRef<Set<string>>(new Set());
  const [reloads, setReloads] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  /* How many of those answers are waiting on this device rather than on the server.
     The offline notice is phrased from this number, not from answeredCount: a grade
     that went through before the connection dropped is already saved, and saying it
     is "kept on this device" would be false. */
  const [queuedCount, setQueuedCount] = useState(0);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);

  /*
   * The downloaded copy: what is on this device, and whether it is what the reader
   * is currently answering.
   *
   * Two facts rather than one, because they are independently true. A pack exists
   * whenever a page has been fetched — every successful fetch writes one, so a
   * reader who opens Review on the train already has today's practice with them
   * without having asked. `practisingFrom` is the narrower fact: the network was
   * not there, and these cards came off the disk. Only the second earns the
   * banner, because only then is the reader answering something that may have
   * moved on.
   */
  const [pack, setPack] = useState<{ count: number; syncedAt: number } | null>(null);
  const [practisingFrom, setPractisingFrom] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  /*
   * ONE FETCH PER PAGE, NOT PER ANSWER.
   *
   * This effect used to depend on `answeredCount` as well, so every graded card refired
   * it and called `fetchDueReviews` again -- and offline, the catch set `error`, whose
   * branch below replaces every card already on screen. An offline review session
   * therefore ended after exactly one answer, which defeats the grade queue (1b) at
   * the one moment it exists for. (The downloaded pack, 4a, has no reader here yet:
   * `fetchDueReviews` goes straight to the RPC, so a page used up offline still ends
   * on the error screen. Practising from the pack is 4b, still to come.)
   *
   * Now a page is fetched when the screen opens and again only when the page is used
   * up (`grade` bumps `reloads` when the last card goes). Every card in between is
   * answered from what is already here, and a grade the network loses is queued by
   * `grade` rather than surfaced as a broken screen.
   *
   * The session total is decided at the same moments, which is what keeps "1 of 20"
   * honest (law 7): it never moves while the reader is inside a page. When a further
   * page arrives the total grows by that page -- everything before it has been
   * answered -- so the count goes from "20 of 20" to "21 of 25", never "2 of 21".
   */
  useEffect(() => {
    let cancelled = false;
    const userId = getCurrentUserId();

    void (async () => {
      /*
       * Fetched before the page rather than beside it, which is what makes the
       * offline branch possible: `Promise.all` rejects on the network failure and
       * throws away the queue's answer with it, and the queue is exactly what the
       * pack has to be filtered against.
       */
      const queuedFor = userId === null ? null : await pendingRecallPullIds(userId);
      if (cancelled) return;
      const answered = new Set([...graded.current, ...(queuedFor ?? [])]);

      try {
        const rows = await api.fetchDueReviews();
        if (cancelled) return;
        const filtered = rows.filter((row) => !answered.has(row.pullId));
        setDue(filtered);
        setSessionTotal((prev) => nextSessionTotal(prev, filtered.length));
        setOffline(false);
        setPractisingFrom(null);

        /*
         * Every successful page is downloaded, without being asked for. Law 3
         * promises offline practice free forever, and a feature that only works
         * for readers who remembered to press a button before losing signal is
         * free in the same way a locked door is open.
         *
         * The unfiltered `rows` are stored, not `filtered`: the filter drops what
         * this device has already answered, and those answers are queued writes
         * the server has not seen. A pack written from the filtered list would
         * lose those cards from the device the moment the queue drained.
         */
        if (userId !== null) {
          const syncedAt = Date.now();
          const stored = await storeReviewPack(userId, rows, syncedAt);
          if (!cancelled && stored) setPack({ count: rows.length, syncedAt });
        }
      } catch (e: unknown) {
        if (cancelled) return;
        console.error('Due reviews request failed', e);
        const wasOffline = isOfflineFailure(e);

        /*
         * The whole point of 4a. A page that cannot be fetched is not the end of a
         * review session if a copy of it is sitting on the device — and only a
         * NETWORK failure may fall back, for the reason `isOfflineFailure` is a
         * function rather than a boolean: answering a 500 or an expired token with
         * stale cards would be a confident wrong diagnosis over content the reader
         * cannot tell is stale.
         */
        if (wasOffline && userId !== null) {
          const downloaded = await readReviewPack(userId);
          if (cancelled) return;
          const left = downloaded ? mergePack(downloaded.items, answered) : [];

          /*
           * `pack` is what is ON THE DEVICE; `left` is what is left of this session.
           *
           * They are different facts and this used to report the second as the first:
           * a reader who downloaded twenty and answered twelve online has eight stored
           * (each answer removes one) and might have three of those still in the
           * offline queue, so `left` is five — and the label said "5 ideas ready
           * offline" over eight. Set before the branch below, because the case where
           * nothing is LEFT is exactly the one that falls through to the error screen,
           * where the label would otherwise say "Nothing downloaded yet" over a pack
           * that plainly exists.
           */
          if (downloaded) {
            setPack({ count: downloaded.items.length, syncedAt: downloaded.syncedAt });
          }

          if (downloaded && left.length > 0) {
            setDue(left);
            setSessionTotal((prev) => nextSessionTotal(prev, left.length));
            setPractisingFrom(downloaded.syncedAt);
            setOffline(true);
            return;
          }
        }

        setOffline(wasOffline);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloads]);

  /*
   * One refetch when the connection comes back, and only where there is nothing on
   * screen for it to interrupt.
   *
   * Armed on the ERROR screen alone. The first version also armed it while
   * practising from the downloaded copy, which is the one state where a reader is
   * mid-session: leaving a tunnel fired `online`, the refetch replaced `due`, and
   * the question they were reading — with the latency accumulated for it —
   * was swapped for a different card with no notice. That is precisely the failure
   * the comment above the main effect describes, arriving by another door, and it is
   * worse than the one it was trying to fix.
   *
   * Nothing is lost by waiting. Grades queue and drain on their own, and a pack that
   * runs out bumps `reloads` at the page boundary, which is where a refetch belongs.
   */
  useEffect(() => {
    if (error === null) return;
    return onReconnect(() => setReloads((n) => n + 1));
  }, [error]);

  /*
   * What is already on the device, read once, independently of the fetch.
   *
   * `pack` used to be set only by a successful fetch, the offline fallback, or an
   * explicit download — so a reader with twenty cards downloaded who opened Review to a
   * 500 or an expired token was told "Nothing downloaded yet", on the one screen where
   * knowing the copy exists is the thing that matters. This does not change the
   * deliberate refusal to fall back on a non-network error; it changes what the label
   * is allowed to claim.
   */
  useEffect(() => {
    const owner = getCurrentUserId();
    if (owner === null) return;
    let live = true;
    readReviewPack(owner)
      .then((downloaded) => {
        if (!live || downloaded === null) return;
        // Only as a floor. A fetch that has already answered knows better than a
        // read that started before it.
        setPack(
          (current) => current ?? { count: downloaded.items.length, syncedAt: downloaded.syncedAt },
        );
      })
      .catch(() => {
        // A pack that cannot be read is a pack the label should not describe.
      });
    return () => {
      live = false;
    };
  }, []);

  /** Take today's practice with you, deliberately, before the signal goes. */
  const download = useCallback(() => {
    const userId = getCurrentUserId();
    if (userId === null || downloading) return;
    setDownloading(true);
    api
      .fetchDueReviews()
      .then(async (rows) => {
        const syncedAt = Date.now();
        if (await storeReviewPack(userId, rows, syncedAt)) {
          setPack({ count: rows.length, syncedAt });
        }
      })
      .catch((e: unknown) => {
        // Nothing is lost by a download that did not happen: whatever was on the
        // device before is still there, and the label still describes it.
        console.error('Could not download the practice pack', e);
      })
      .finally(() => setDownloading(false));
  }, [downloading]);

  /*
   * The offline copy, and the offer to refresh it. Rendered under every state of
   * this screen that has room for it, because the moment a reader wants it is the
   * moment before they lose signal, which is not a moment this screen can predict.
   */
  const offlineCopy = (
    <p className="meta" style={{ marginTop: 'var(--space-4)' }}>
      {packLabel(pack?.count ?? 0, pack?.syncedAt ?? null)}{' '}
      <button type="button" className="btn btn--plain" onClick={download} disabled={downloading}>
        {downloading ? 'Downloading…' : 'Download today’s practice'}
      </button>
    </p>
  );

  /* Try again fetches the next page; it does not start the session over. The error
     screen is only reachable before the first page or at a boundary, so what was
     answered is real progress and the count must survive the retry. */
  const retry = useCallback(() => {
    setError(null);
    setDue(null);
    setReloads((n) => n + 1);
  }, []);

  const notices = (
    <>
      {/*
        Said before anything else on the screen, because it changes what every
        answer below it means: these questions came off the disk, and the schedule
        may have moved since. `role="status"` rather than `alert` — nothing has
        gone wrong, and practice is still practice.
      */}
      {practisingFrom !== null ? (
        <p className="meta" role="status">
          {practisingLabel(practisingFrom)}
        </p>
      ) : null}
      {signedOut ? (
        <p className="meta" role="alert">
          Your session ended before that grade could be saved. Sign in again and those ideas will
          come round as they were.
        </p>
      ) : lostGrade ? (
        <p className="meta" role="alert">
          That grade could not be saved, here or on this device. Those ideas will come round again.
        </p>
      ) : null}
    </>
  );

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Review</p>
        <h1>Could not check what is fading.</h1>
        {notices}
        <p>
          {offline
            ? 'You appear to be offline, so this could not be checked. It does not mean nothing is due.'
            : lostGrade || signedOut
              ? 'Something went wrong reaching your review schedule.'
              : 'Something went wrong reaching your review schedule. Nothing has been lost.'}
        </p>
        {/* Only reachable at a page boundary now, so anything answered before it is
            already saved or already queued -- and worth saying which, because the
            screen above this sentence has just been replaced. */}
        {offline && answeredCount > 0 && !lostGrade && !signedOut ? (
          <p className="meta" role="status">
            {/* Past tense on purpose (review finding): the feed stays mounted and
                drains the queue whenever the connection returns, so by the time this
                sentence shows some of what was queued may already have gone. What was
                queued is a fact; where it is now is not one this screen knows. */}
            {queuedCount === 0
              ? `Everything you answered (${answeredCount}) was saved before the connection dropped.`
              : queuedCount === answeredCount
                ? `What you answered (${answeredCount}) was queued on this device to send when you are back.`
                : `${answeredCount - queuedCount} of the ${answeredCount} you answered were saved; ${queuedCount} ${queuedCount === 1 ? 'was' : 'were'} queued on this device to send when you are back.`}
          </p>
        ) : null}
        <p className="meta">{error}</p>
        <button type="button" className="btn btn--primary" onClick={retry}>
          Try again
        </button>
        {offlineCopy}
      </section>
    );
  }

  if (!due)
    return (
      <section className="stack measure">
        {notices}
        <p className="meta" role="status">
          Loading…
        </p>
      </section>
    );

  if (due.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">Review</p>
        <h1>Nothing is fading.</h1>
        {notices}
        <p>
          {lostGrade || signedOut
            ? 'Nothing else is due. The idea above will come round again.'
            : 'Everything you have saved is still solid. Come back when something slips.'}
        </p>
        {offlineCopy}
      </section>
    );
  }

  const card = due[0]!;

  async function grade(
    g: RecallGrade,
    latencyMs?: number,
    extra?: {
      confidence?: 'sure' | 'unsure';
      questionId?: string;
      answer?: string;
    },
  ) {
    if (grading) return;
    setGrading(true);
    let mutationId: string | null = null;
    let submittedAt: number | null = null;
    const activeQuestion = resolveActiveQuestion(card);
    const qid = extra?.questionId ?? activeQuestion?.id ?? card.questionId;
    try {
      mutationId = newMutationId();
      submittedAt = nextSubmissionStamp();
      await api.gradeRecall(card.pullId, g, {
        mutationId,
        submittedAt,
        kind: 'review',
        ...(qid ? { questionId: qid } : {}),
        ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
        ...(extra?.confidence ? { confidence: extra.confidence } : {}),
        ...(extra?.answer ? { answer: extra.answer } : {}),
      });
      setSignedOut(false);
    } catch (e: unknown) {
      const userId = getCurrentUserId();
      const queued =
        mutationId !== null &&
        submittedAt !== null &&
        userId !== null &&
        (await queueMutation(
          userId,
          {
            kind: 'recall',
            pullId: card.pullId,
            grade: g,
            mutationId,
            submittedAt,
            recallKind: 'review',
            ...(qid ? { questionId: qid } : {}),
            ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
            ...(extra?.confidence ? { confidence: extra.confidence } : {}),
            ...(extra?.answer ? { answer: extra.answer } : {}),
          },
          e,
        ));

      if (queued) {
        setQueuedCount((n) => n + 1);
      } else {
        setLostGrade(true);
        if (userId === null) setSignedOut(true);
        console.error('Recall grade was not recorded', e);
      }
    } finally {
      setGrading(false);
      graded.current.add(card.pullId);

      /*
       * An answered card leaves the downloaded copy, whether it was answered from
       * it or not. Offline this is what stops the same question being asked twice
       * in one sitting; online it is what stops a card the reader graded this
       * morning coming back at them on tonight's train, off a pack that still
       * lists it as due.
       */
      const owner = getCurrentUserId();
      if (owner !== null) {
        // Decremented only when a card actually left the device. `removeFromPack` is a
        // no-op for a card that was never downloaded, and counting those took the label
        // to "Nothing downloaded yet" over a pack that was still there — on the one
        // screen whose job is saying what can be practised without a connection.
        void removeFromPack(owner, card.pullId).then((removed) => {
          if (removed) setPack((p) => (p === null ? p : { ...p, count: Math.max(0, p.count - 1) }));
        });
      }

      setAnsweredCount((n) => n + 1);
      const rest = (due ?? []).slice(1);
      setDue(rest.length === 0 ? null : rest);
      if (rest.length === 0) setReloads((n) => n + 1);
    }
  }

  const currentNumber = answeredCount + 1;
  const totalNumber = sessionTotal ?? due.length;

  return (
    <section className="stack measure">
      <p className="meta">{formatReviewProgress(currentNumber, totalNumber)}</p>

      {notices}

      <ActiveReviewCard
        key={card.pullId}
        card={card}
        grading={grading}
        onGrade={(g, latencyMs, extra) => void grade(g, latencyMs, extra)}
      />

      {offlineCopy}
    </section>
  );
}
