import { describe, expect, it } from 'vitest';
import { type ImportResult, PartialImportError } from './import-fold.js';
import {
  batchIsGone,
  canKeep,
  failureLine,
  footerLine,
  forgetsOnParse,
  type ImportFailure,
  keepFailed,
  keepLabel,
  type PanelState,
  showsKeep,
  showsUndo,
  undoFailed,
} from './import-screen.js';
import { rpcError } from './rpc-error.js';

/** A file fully sent: every chunk went, so there is no rest. */
const landed: ImportResult = {
  importId: 'batch-1',
  added: 1500,
  duplicates: 0,
  ceilingReached: false,
  complete: true,
  works: [],
};

/** A file whose chunk failed partway: something landed and a rest remains. */
const partway: ImportResult = { ...landed, complete: false };

/** A chunk failure after an earlier chunk landed -- the wrapper both classifiers missed. */
const partial = (raw: unknown) => new PartialImportError(rpcError(raw), landed);

const offline = { code: '', message: 'TypeError: Failed to fetch' };
const timeout = { code: '57014', message: 'canceling statement due to statement timeout' };
const tombstone = { code: '22023', message: 'commit_import: no open batch of yours with that id' };
const overLong = {
  code: '22023',
  message: 'commit_import: a highlight of 20001 characters exceeds 20000',
};
const batchCeiling = {
  code: '54023',
  message: 'You have reached the limit of 50 import batches. Undo one you no longer need.',
};

const panel = (over: Partial<PanelState> = {}): PanelState => ({
  result: null,
  undone: false,
  failure: null,
  ...over,
});

const failed = (action: ImportFailure['action']): ImportFailure => ({ action, message: 'x' });

describe('failureLine', () => {
  it('recognises an offline failure through the partial wrapper', () => {
    // The wrapper renames the error, and `isOfflineFailure` reads `name` -- so before it
    // unwrapped, this returned the raw "TypeError: Failed to fetch" the message carries.
    expect(failureLine('keep', partial(offline), 'fallback')).toContain('You appear to be offline');
    expect(failureLine('keep', partial(offline), 'fallback')).not.toContain('TypeError');
  });

  it('does not tell a reader nothing was sent when a chunk has already landed', () => {
    // "Nothing was sent" under a panel reading "Kept 1500 highlights" is two
    // contradictory statements about the same request.
    expect(failureLine('keep', partial(offline), 'fallback')).not.toContain('Nothing was sent');
    expect(failureLine('keep', partial(offline), 'fallback')).toContain('already been kept');
  });

  it('still says nothing was sent when nothing was', () => {
    expect(failureLine('keep', rpcError(offline), 'fallback')).toContain('Nothing was sent');
  });

  it('replaces the database wording for a statement timeout, wrapped or not', () => {
    // Promoted to `role="alert"` in the accent colour, so this was the most emphatic
    // sentence on the screen.
    expect(failureLine('keep', rpcError(timeout), 'fallback')).not.toContain('canceling statement');
    expect(failureLine('keep', partial(timeout), 'fallback')).not.toContain('canceling statement');
    expect(failureLine('keep', partial(timeout), 'fallback')).toContain('already been kept');
    // The POSITIVE half too: asserting only the absence of the database's wording let any
    // replacement pass, including the partial sentence for an attempt that kept nothing.
    expect(failureLine('keep', rpcError(timeout), 'fallback')).toContain('Nothing was kept');
  });

  it('drops the batch-ceiling instruction, because undoing does not free a batch', () => {
    /*
     * The migration says "Undo one you no longer need" (`:785-787`), and `v_batches`
     * (`:783`) counts every row in `imports` with no `undone_at is null` -- unlike
     * `v_held` (`:709-711`), which excludes them and says why. Following the instruction
     * loses the reader their highlights and returns the same refusal.
     */
    const line = failureLine('keep', rpcError(batchCeiling), 'fallback');
    expect(line).not.toContain('Undo one');
    expect(line).toContain('as many import batches as it can hold');
  });

  it('names the outcome for the verb that failed, not always for keeping', () => {
    /*
     * A timed-out Undo said "Nothing was kept" underneath "Kept 3 highlights across 3
     * books" and a footer reading "Kept in your account" -- and the denial was the only
     * line in the accent colour.
     */
    expect(failureLine('undo', rpcError(timeout), 'fallback')).toContain('Nothing was removed');
    expect(failureLine('undo', rpcError(timeout), 'fallback')).not.toContain('kept');
    expect(failureLine('undo', rpcError(offline), 'fallback')).toContain('Nothing was removed');
  });

  it('explains a tombstone rather than printing the migration raise at the reader', () => {
    /*
     * `batchIsGone` clears the batch id on this code, so the counts and the Undo go with
     * it and this line is the reader's whole account of what happened. It was
     * `commit_import: no open batch of yours with that id`, alone, in the accent colour.
     */
    const line = failureLine('keep', partial(tombstone), 'fallback');
    expect(line).not.toContain('commit_import');
    expect(line).toContain('Keeping again starts a fresh one');
  });

  it('falls back only when there is no message to show', () => {
    expect(failureLine('keep', { not: 'an error' }, 'fallback')).toBe('fallback');
  });
});

describe('keepFailed / undoFailed', () => {
  it('records which action the failure came from', () => {
    /*
     * THE WHOLE REASON THESE EXIST. This was two object literals in
     * `routes/Ingestion.tsx`, which no test can import -- and changing the one word
     * 'undo' to 'keep' there re-created a defect the screen tests were written to
     * prevent, without failing any of them, because the value they check was supplied by
     * the file they cannot reach. Mutation review found it surviving here too, before
     * this test existed.
     */
    expect(keepFailed(rpcError(timeout)).action).toBe('keep');
    expect(undoFailed(rpcError(timeout)).action).toBe('undo');
  });

  it('words the message for its own verb', () => {
    expect(keepFailed(rpcError(timeout)).message).toContain('Nothing was kept');
    expect(undoFailed(rpcError(timeout)).message).toContain('Nothing was removed');
  });

  it('falls back to a sentence naming its own verb', () => {
    expect(keepFailed({ not: 'an error' }).message).toBe('The import did not go through.');
    expect(undoFailed({ not: 'an error' }).message).toBe('The undo did not go through.');
  });
});

describe('batchIsGone', () => {
  it('sees the tombstone through the partial wrapper', () => {
    // The reason the branch was dead: reaching it needs a resumed id, a resumed id makes
    // `foldChunks` wrap, and the wrapper defeats a match on `name`.
    expect(batchIsGone(partial(tombstone))).toBe(true);
  });

  it('sees it unwrapped too', () => {
    expect(batchIsGone(rpcError(tombstone))).toBe(true);
  });

  it('is false for a failure that is not from Postgres', () => {
    expect(batchIsGone(partial(offline))).toBe(false);
    expect(batchIsGone(new Error('plain'))).toBe(false);
  });

  it('cannot tell the tombstone from a per-item refusal, and this pins that it does not try', () => {
    /*
     * `22023` is raised from thirteen sites in the migration and only `:753-754` is the
     * tombstone; the rest are per-item validation. This returns true for both, which is
     * safe ONLY because `toImportItems` and `chunkItems` make the other twelve
     * unreachable for a chunk this client builds -- empty titles and empty text are
     * dropped, over-long highlights are dropped, the 500 bound is guaranteed, and the
     * field types are TypeScript's.
     *
     * Recorded rather than worked around: if that shaping ever stops covering a case,
     * this is where the batch id would be discarded from a batch that really has rows in
     * it. The durable fix is a distinct errcode for `:754`, which needs a migration.
     */
    expect(batchIsGone(partial(overLong))).toBe(true);
  });
});

describe('showsKeep', () => {
  it('offers Keep before anything has been kept', () => {
    expect(showsKeep(panel())).toBe(true);
  });

  it('offers it again after a KEEP fails, so a partial import can be finished', () => {
    expect(showsKeep(panel({ result: partway, failure: failed('keep') }))).toBe(true);
  });

  it('does NOT offer it after an UNDO fails on an import that was complete', () => {
    // One `error` flag served both verbs, so a failed Undo re-armed Keep -- labelled
    // "Keep the rest" -- and pressing it resent the whole file into the batch the reader
    // was trying to delete.
    expect(showsKeep(panel({ result: landed, failure: failed('undo') }))).toBe(false);
  });

  it('DOES offer it after an UNDO fails on a PARTIAL import, because a rest remains', () => {
    /*
     * `handleUndo` clears the failure before it runs, so pressing Undo destroyed the only
     * record that a keep was unfinished -- and if the Undo then failed, the 100 unsent
     * highlights had no button at all, and no re-parse brought one back. Two consecutive
     * network failures on a chunked import is one dropped connection.
     */
    expect(showsKeep(panel({ result: partway, failure: failed('undo') }))).toBe(true);
  });

  it('offers it for a partial import with no failure showing at all', () => {
    /*
     * The silent version, and the worst of the three. A superseded "Keep the rest" --
     * re-parsing identical text while the retry is in flight -- cleared the failure,
     * returned before writing anything back, and left a screen reading "Kept 1500
     * highlights" with an empty alert region for a file half of which had never been
     * sent. Completeness is carried on the result now, so nothing clears it but the
     * result going.
     */
    expect(showsKeep(panel({ result: partway, failure: null }))).toBe(true);
  });

  it('offers it again once an Undo has completed', () => {
    // A completed Undo clears `result`, so this answers true without reading `undone`.
    // Gating on `undone` is what left the screen with no button at all.
    expect(showsKeep(panel({ result: null, undone: true }))).toBe(true);
  });

  it('hides it after a clean keep, when there is nothing left to send', () => {
    expect(showsKeep(panel({ result: landed }))).toBe(false);
  });
});

describe('showsUndo', () => {
  it('offers Undo while a batch exists, including after a failed undo', () => {
    expect(showsUndo(panel({ result: landed }))).toBe(true);
    expect(showsUndo(panel({ result: landed, failure: failed('undo') }))).toBe(true);
    expect(showsUndo(panel({ result: partway }))).toBe(true);
  });

  it('withdraws it once the batch is gone', () => {
    expect(showsUndo(panel({ result: null, undone: true }))).toBe(false);
  });

  it('withdraws it for a result that never opened a batch', () => {
    expect(showsUndo(panel({ result: { importId: null, complete: true } }))).toBe(false);
  });
});

describe('keepLabel', () => {
  it('promises the number that will actually be kept', () => {
    expect(keepLabel(panel(), null, 1203)).toBe('Keep 1203 highlights');
    expect(keepLabel(panel(), null, 1)).toBe('Keep 1 highlight');
  });

  it('says "Keep the rest" when something landed and a rest remains', () => {
    expect(keepLabel(panel({ result: partway, failure: failed('keep') }), null, 5)).toBe(
      'Keep the rest',
    );
    // Still the rest when the last failure was an undo -- the file is unfinished either way.
    expect(keepLabel(panel({ result: partway, failure: failed('undo') }), null, 5)).toBe(
      'Keep the rest',
    );
  });

  it('names the whole file when nothing landed, however the attempt failed', () => {
    /*
     * The `state.result` half of the guard. A first attempt that failed outright, and the
     * tombstone path where `result` is cleared just before the failure is written, both
     * reach here -- and "Keep the rest" would be offering the remainder of an import that
     * never happened.
     */
    expect(keepLabel(panel({ result: null, failure: failed('keep') }), null, 5)).toBe(
      'Keep 5 highlights',
    );
  });

  it('names the whole file after a clean keep', () => {
    expect(keepLabel(panel({ result: landed }), null, 5)).toBe('Keep 5 highlights');
  });

  it('names the running action rather than the screen being busy', () => {
    expect(keepLabel(panel(), 'keep', 5)).toBe('Keeping…');
    expect(keepLabel(panel(), 'undo', 5)).toBe('Keep 5 highlights');
  });
});

describe('canKeep', () => {
  it('refuses a button that would promise zero', () => {
    // It was enabled, read "Keep 0 highlights", and answered a press with an error.
    expect(canKeep(null, 0)).toBe(false);
    expect(canKeep(null, 1)).toBe(true);
  });

  it('refuses while either action is running', () => {
    expect(canKeep('keep', 5)).toBe(false);
    expect(canKeep('undo', 5)).toBe(false);
  });
});

describe('footerLine', () => {
  it('does not say an import is kept after it was removed', () => {
    // It read `result`, which an Undo did not clear, so "Removed 3 highlights" and "Kept
    // in your account" sat in the same panel.
    expect(footerLine(panel({ result: null, undone: true }))).toBe('Removed from your account');
  });

  it('says it is kept while it is', () => {
    expect(footerLine(panel({ result: landed }))).toBe('Kept in your account');
    // An undo that FAILED leaves it kept, and the line should still say so.
    expect(footerLine(panel({ result: landed, failure: failed('undo') }))).toBe(
      'Kept in your account',
    );
  });

  it('says nothing is uploaded before anything is', () => {
    expect(footerLine(panel())).toBe('Parsed in your browser · nothing uploaded yet');
  });
});

describe('forgetsOnParse', () => {
  it('keeps the result when the same text is parsed again', () => {
    // Dropping it sent `resume` null, so `commit_import` fell back to its reuse window
    // and answered with the FIRST batch's id under "Kept 0 highlights across 0 books".
    expect(forgetsOnParse('same', 'same')).toBe(false);
  });

  it('forgets it when the text changes, so a stale id cannot join a new file', () => {
    expect(forgetsOnParse('new', 'old')).toBe(true);
  });
});
