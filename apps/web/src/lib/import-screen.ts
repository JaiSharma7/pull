/**
 * What the import screen shows, and what it says when something fails.
 *
 * ITS OWN MODULE FOR THE THIRD TIME, AND THE THIRD TIME IS THE ARGUMENT.
 * `import-fold.ts` and `undo-summary.ts` were each carved out of the route because
 * `routes/Ingestion.tsx` imports `lib/import-api.ts`, which imports `lib/supabase.ts`,
 * which builds its client at module scope and throws under vitest -- so a test that
 * reaches route logic fails to COLLECT rather than failing an assertion.
 *
 * What that left behind was the route's own decisions: which button is on screen, what it
 * is labelled, what the footer says, and what a reader is told when a chunk fails. Review
 * put six mutants on those decisions -- reverting the identical-file rule, deleting the
 * tombstone branch, reverting the generation guard on Undo, reverting the unconditional
 * `busy` reset, reverting parse-time shaping, reverting the merge -- and ALL SIX SURVIVED,
 * because nothing imports the route. Every fix the previous round made there was
 * unpinned, which is why this round found four more defects in the same forty lines.
 *
 * So the decisions live here, take plain values, import nothing networked, and are
 * tested. The route keeps the state and the effects; it no longer keeps the reasoning.
 */

import { PartialImportError } from './import-fold.js';
import { isOfflineFailure } from './offline.js';
import { sqlState } from './rpc-error.js';

/** Which of the screen's two actions a failure belongs to. */
export type ImportAction = 'keep' | 'undo';

/**
 * A failure, and WHICH ACTION IT CAME FROM.
 *
 * One `error: string | null` served both, and the Keep button's visibility (`!result ||
 * error`) and its label (`error && result ? 'Keep the rest'`) both read it. So a failed
 * UNDO re-armed Keep and relabelled it "Keep the rest" -- on an import that had fully
 * succeeded and that the reader was in the middle of trying to delete. Pressing it
 * resent every item in the file with `p_import_id` set to the batch under deletion.
 *
 * The same split `busy` already makes, for the same reason: this screen has two verbs and
 * one flag cannot answer for both.
 */
export interface ImportFailure {
  action: ImportAction;
  message: string;
}

/** Only what the affordances actually read, so tests need not build a whole result. */
export interface PanelState {
  result: { importId: string | null; complete: boolean } | null;
  undone: boolean;
  failure: ImportFailure | null;
}

/**
 * The error to CLASSIFY, which is not always the error that was thrown.
 *
 * `PartialImportError` sets `this.name` to its own name and keeps the original only on
 * `.cause`. Every classifier in this app reads `name`: `sqlState` matches
 * `/^PostgrestError (.+)$/` against it (`rpc-error.ts:128`) and `isOfflineFailure`
 * compares it to `TRANSPORT_ERROR` (`offline.ts:1102`). So both go blind on exactly the
 * path where a chunk fails AFTER an earlier one landed -- which, for a file large enough
 * to be chunked, is the likeliest failure there is.
 *
 * What that cost: an import whose wifi dropped during chunk four reported
 * "TypeError: Failed to fetch" to the reader, in the accent colour, because `failureLine`
 * fell through to `e.message` and `PartialImportError` had copied that message up from
 * the cause. That is the defect `rpc-error.ts` exists to prevent, reintroduced by a
 * wrapper that predates the check.
 */
function classifiable(e: unknown): unknown {
  return e instanceof PartialImportError ? e.cause : e;
}

/**
 * What to tell the reader about a failure.
 *
 * A request that never left the device is not a refusal, and the two need different
 * sentences -- but a PARTIAL failure needs a third, because "Nothing was sent" is false
 * once a chunk has landed. Told that beneath a panel reading "Kept 1500 highlights across
 * 3 books", a reader has two contradictory statements and no way to tell which is true.
 *
 * `57014` is mapped because it is pure machine wording: a statement timeout arrived as
 * "canceling statement due to statement timeout", which a previous round had just
 * promoted from `meta` to `role="alert"` in the accent colour -- making the database's
 * internal sentence the most emphatic thing on the screen.
 *
 * IT TAKES THE ACTION because the sentences describe an outcome, and the two verbs have
 * opposite ones. Written for keeping and reused for undoing, a timed-out Undo told the
 * reader "Nothing was kept" underneath "Kept 3 highlights across 3 books" and a footer
 * reading "Kept in your account" -- three statements and a denial, with the denial the
 * only line in the accent colour.
 *
 * Anything past these keeps the server's own message, which is the right default when
 * the server wrote a sentence for a reader and the wrong one when it did not.
 */
export function failureLine(action: ImportAction, e: unknown, fallback: string): string {
  const partial = e instanceof PartialImportError;
  const cause = classifiable(e);
  // What is true of the reader's library if this failed. An Undo never removes half a
  // batch -- `undo_import` is one transaction -- so only a keep has a middle state.
  const outcome = action === 'undo' ? 'Nothing was removed' : partial ? null : 'Nothing was kept';

  if (isOfflineFailure(cause)) {
    if (partial) {
      return 'You appear to be offline. What had already been kept is still there — try again when you are back.';
    }
    const sent = action === 'undo' ? 'Nothing was removed' : 'Nothing was sent';
    return `You appear to be offline. ${sent} — try again when you are back.`;
  }

  if (sqlState(cause) === '57014') {
    return outcome === null
      ? 'That took too long to finish. What had already been kept is still there — try again to send the rest.'
      : `That took too long to finish. ${outcome} — try again.`;
  }

  /*
   * The tombstone, in a sentence rather than as the migration's raise.
   *
   * `batchIsGone` clears the batch id on this code, so by the time it is rendered the
   * counts and the Undo have gone with it and this line is the reader's WHOLE account of
   * what happened. It was `commit_import: no open batch of yours with that id`, alone, in
   * the accent colour -- which is the defect this function exists to prevent, on the one
   * branch the previous round revived.
   *
   * Named for the keep verb because `undo_import` does not raise it: a batch that is
   * already gone is `42704` there (`20260905110000:1222`), and its idempotent branch
   * answers rather than raising at all.
   */
  if (action === 'keep' && sqlState(cause) === '22023') {
    return 'The import this was joining is no longer there. Keeping again starts a fresh one.';
  }

  /*
   * THE BATCH CEILING, WITHOUT THE INSTRUCTION IT CAME WITH. The migration says "You have
   * reached the limit of % import batches. Undo one you no longer need." (`:785-787`) and
   * that second sentence is not true: `v_batches` counts every row in `imports`
   * (`:783`), with no `undone_at is null` -- unlike `v_held` (`:709-711`), which excludes
   * them deliberately and says why. So undoing frees item quota and never a batch slot,
   * and a reader who follows the instruction loses their highlights and gets the same
   * refusal. Forwarding it was a client decision and this unmakes it; correcting the
   * counter is a migration, recorded with the others in `import-fold.ts`.
   */
  if (sqlState(cause) === '54023') {
    return 'This account has as many import batches as it can hold.';
  }

  return cause instanceof Error ? cause.message : fallback;
}

/** A keep that failed, as the screen records it. */
export function keepFailed(e: unknown): ImportFailure {
  return { action: 'keep', message: failureLine('keep', e, 'The import did not go through.') };
}

/**
 * An undo that failed.
 *
 * A pair with `keepFailed` so that WHICH ACTION a failure is recorded under is decided
 * here rather than at the call site. It was two object literals in `routes/Ingestion.tsx`,
 * which no test can import -- and changing the one word `'undo'` to `'keep'` there
 * restored a defect the screen tests were written to prevent, without failing one of
 * them, because the value they check is supplied by the file they cannot reach.
 */
export function undoFailed(e: unknown): ImportFailure {
  return { action: 'undo', message: failureLine('undo', e, 'The undo did not go through.') };
}

/**
 * Does this failure mean the batch id in hand names something that is no longer there?
 *
 * `commit_import`'s named branch answers `22023` for a batch that is not open --
 * "no open batch of yours with that id" (`20260905110000:753-754`) -- and resending that
 * id fails identically on every press after it. Forgetting it lets the next press open a
 * fresh batch, which is what the reader is asking for.
 *
 * IT HAS TO UNWRAP, and the check that did not was dead in both directions. Reaching this
 * at all requires a resumed id, which makes `total.importId` non-null before the first
 * chunk, which makes `foldChunks` wrap the error -- so the code never matched when the
 * tombstone fired, and when it did match `result` was already null and clearing it was a
 * no-op.
 *
 * `22023` IS NOT ONLY THIS. The migration raises it from thirteen sites, and the other
 * twelve are per-item validation -- an empty title (`:833`), an over-long highlight
 * (`:839`), a non-string field (`:805`-`:817`). Clearing the batch id on one of those
 * would take Undo away from rows that really did land. It is safe here because none of
 * them is reachable for a chunk THIS CLIENT BUILDS: `toImportItems` drops empty titles and
 * empty text and anything over 20,000 characters, `chunkItems` guarantees the array and
 * the 500 bound, and the field types are TypeScript's. The durable answer is a distinct
 * errcode for `:754`, which needs a migration and is recorded with the other two in
 * `import-fold.ts`.
 */
export function batchIsGone(e: unknown): boolean {
  return sqlState(classifiable(e)) === '22023';
}

/**
 * Is the Keep button on screen?
 *
 * IS THERE A REST TO SEND -- which is the question, and is not the same as which action
 * failed last. This read `failure?.action === 'keep'`, and `failure` is cleared by three
 * transitions that cannot re-raise it: starting a keep, starting an Undo, and re-parsing.
 * So a partial import lost its "Keep the rest" button for good if the reader pressed Undo
 * and the Undo failed, or if they re-parsed identical text while the retry was in flight
 * -- and in the second case the screen then read "Kept 1500 highlights" with no failure
 * showing, for a file half of which had never been sent.
 *
 * `complete` is carried on the result, so it survives everything that clears a flag and
 * goes only when the result it describes goes.
 *
 * It does not read `undone` either: a completed Undo clears `result`, so this answers
 * true again on its own. Gating on `undone` is what once left the screen with no button
 * at all, under copy telling the reader to upload the file again.
 */
export function showsKeep(state: PanelState): boolean {
  return state.result === null || !state.result.complete;
}

/** Is the Undo button on screen? Only while there is a batch to take back. */
export function showsUndo(state: PanelState): boolean {
  return typeof state.result?.importId === 'string';
}

/**
 * What the Keep button says.
 *
 * The count is what will actually be KEPT, not what was parsed -- `toImportItems` drops
 * what the RPC would refuse, so "Keep 1204 highlights" delivered 1,203. When it drops
 * everything the button promises zero, which is a promise it cannot keep; `canKeep`
 * disables it and the panel says why instead.
 */
export function keepLabel(state: PanelState, busy: ImportAction | null, items: number): string {
  if (busy === 'keep') return 'Keeping…';
  // Something landed and a rest remains. `state.result` is the load-bearing half: a first
  // attempt that failed outright has nothing kept, so there is no "rest" to offer -- the
  // button should name the whole file. Reached both on an ordinary first failure and on
  // the tombstone path, where `result` is cleared just before the failure is written.
  if (state.result && !state.result.complete) return 'Keep the rest';
  return `Keep ${items} ${items === 1 ? 'highlight' : 'highlights'}`;
}

/** Is there anything to send? A button offering "Keep 0 highlights" only raises an error. */
export function canKeep(busy: ImportAction | null, items: number): boolean {
  return busy === null && items > 0;
}

/**
 * The line beside the buttons.
 *
 * It read `result ? 'Kept in your account' : …`, and an Undo does not clear `result`, so
 * a removed import ended with "Removed 3 highlights", "Import undone." and "Kept in your
 * account" stacked in one panel.
 */
export function footerLine(state: PanelState): string {
  if (state.undone) return 'Removed from your account';
  if (state.result) return 'Kept in your account';
  return 'Parsed in your browser · nothing uploaded yet';
}

/**
 * Does a re-parse discard what is on screen?
 *
 * THE SAME TEXT IS THE SAME FILE. Re-parsing identical text used to drop `result`, so the
 * batch id went with it and `commit_import` fell back to its six-hour reuse window --
 * returning the FIRST batch's id under a panel reading "Kept 0 highlights across 0 books",
 * beside an Undo that would take back everything.
 *
 * Changed text is a different import and clears everything, which is what stops a stale
 * batch id being joined to a new file. That includes the failure: keeping it would leave
 * "Keep the rest" offered for a file that no longer has a rest.
 */
export function forgetsOnParse(text: string, previous: string): boolean {
  return text !== previous;
}
