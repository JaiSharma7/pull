import { describe, expect, it } from 'vitest';
import { type ImportResult, PartialImportError } from './import-fold.js';
import {
  batchIsGone,
  canKeep,
  failureLine,
  footerLine,
  forgetsOnParse,
  type ImportFailure,
  keepLabel,
  type PanelState,
  showsKeep,
  showsUndo,
} from './import-screen.js';
import { rpcError } from './rpc-error.js';

const landed: ImportResult = {
  importId: 'batch-1',
  added: 1500,
  duplicates: 0,
  ceilingReached: false,
  works: [],
};

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
    expect(failureLine(partial(offline), 'fallback')).toContain('You appear to be offline');
    expect(failureLine(partial(offline), 'fallback')).not.toContain('TypeError');
  });

  it('does not tell a reader nothing was sent when a chunk has already landed', () => {
    // "Nothing was sent" under a panel reading "Kept 1500 highlights" is two
    // contradictory statements about the same request.
    expect(failureLine(partial(offline), 'fallback')).not.toContain('Nothing was sent');
    expect(failureLine(partial(offline), 'fallback')).toContain('already been kept');
  });

  it('still says nothing was sent when nothing was', () => {
    expect(failureLine(rpcError(offline), 'fallback')).toContain('Nothing was sent');
  });

  it('replaces the database wording for a statement timeout, wrapped or not', () => {
    // Promoted to `role="alert"` in the accent colour, so this was the most emphatic
    // sentence on the screen.
    expect(failureLine(rpcError(timeout), 'fallback')).not.toContain('canceling statement');
    expect(failureLine(partial(timeout), 'fallback')).not.toContain('canceling statement');
    expect(failureLine(partial(timeout), 'fallback')).toContain('already been kept');
  });

  it('keeps a server message that was written for the reader', () => {
    // 54023 carries the one instruction that resolves it. A generic sentence loses it.
    expect(failureLine(rpcError(batchCeiling), 'fallback')).toContain(
      'Undo one you no longer need',
    );
  });

  it('falls back only when there is no message to show', () => {
    expect(failureLine({ not: 'an error' }, 'fallback')).toBe('fallback');
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
    expect(showsKeep(panel({ result: landed, failure: failed('keep') }))).toBe(true);
  });

  it('does NOT offer it after an UNDO fails', () => {
    // One `error` flag served both verbs, so a failed Undo re-armed Keep -- labelled
    // "Keep the rest" -- and pressing it resent the whole file into the batch the reader
    // was trying to delete.
    expect(showsKeep(panel({ result: landed, failure: failed('undo') }))).toBe(false);
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
  });

  it('withdraws it once the batch is gone', () => {
    expect(showsUndo(panel({ result: null, undone: true }))).toBe(false);
  });

  it('withdraws it for a result that never opened a batch', () => {
    expect(showsUndo(panel({ result: { importId: null } }))).toBe(false);
  });
});

describe('keepLabel', () => {
  it('promises the number that will actually be kept', () => {
    expect(keepLabel(panel(), null, 1203)).toBe('Keep 1203 highlights');
    expect(keepLabel(panel(), null, 1)).toBe('Keep 1 highlight');
  });

  it('says "Keep the rest" only after a keep failed', () => {
    expect(keepLabel(panel({ result: landed, failure: failed('keep') }), null, 5)).toBe(
      'Keep the rest',
    );
    // Not after an undo failed -- the import succeeded; there is no rest.
    expect(keepLabel(panel({ result: landed, failure: failed('undo') }), null, 5)).toBe(
      'Keep 5 highlights',
    );
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
