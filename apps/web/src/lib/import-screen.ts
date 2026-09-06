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
  result: { importId: string | null } | null;
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
 * "canceling statement due to statement timeout", which the previous round had just
 * promoted from `meta` to `role="alert"` in the accent colour -- making the database's
 * internal sentence the most emphatic thing on the screen.
 *
 * Anything else keeps the server's own message, deliberately. `54023` -- the import-batch
 * ceiling -- is written as reader copy in the migration ("You have reached the limit of %
 * import batches. Undo one you no longer need."), and swallowing it for a generic
 * sentence would lose the one instruction that resolves it.
 */
export function failureLine(e: unknown, fallback: string): string {
  const partial = e instanceof PartialImportError;
  const cause = classifiable(e);

  if (isOfflineFailure(cause)) {
    return partial
      ? 'You appear to be offline. What had already been kept is still there — try again when you are back.'
      : 'You appear to be offline. Nothing was sent — try again when you are back.';
  }

  if (sqlState(cause) === '57014') {
    return partial
      ? 'That took too long to finish. What had already been kept is still there — try again to send the rest.'
      : 'That took too long to finish. Nothing was kept — try again.';
  }

  return cause instanceof Error ? cause.message : fallback;
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
 * Nothing kept yet, or a KEEP that failed and can be retried. It no longer reads
 * `undone`: a completed Undo clears `result` instead, so this answers true again on its
 * own. Gating on `undone` is what left the screen inert -- both buttons hidden, and the
 * panel above them saying "Uploading the same file again brings them back".
 */
export function showsKeep(state: PanelState): boolean {
  return state.result === null || state.failure?.action === 'keep';
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
  if (state.failure?.action === 'keep' && state.result) return 'Keep the rest';
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
