import { describe, expect, it } from 'vitest';
import {
  type CommitChunk,
  foldChunks,
  type ImportResult,
  PartialImportError,
} from './import-fold.js';
import type { ImportItem } from './ingestion.js';

/*
 * `import-fold.ts` rather than `import-api.ts`, and the split exists for this file.
 *
 * `lib/supabase.ts` builds its client at module scope and throws under vitest's `test`
 * mode, so a test that imported the RPC wrapper failed to COLLECT rather than failing an
 * assertion — measured, not assumed: this file was written against `import-api.ts`
 * first and reported "Test Files 1 failed / Tests no tests". That is the shape of the
 * defect that once let a PR report "484 passed" while a whole suite had not run.
 *
 * So the chunking and the accumulation — the parts with a bug in them if there is one —
 * live in a module that imports nothing networked, take a port, and this file supplies
 * a fake.
 */

const item = (n: number): ImportItem => ({ title: 'Meditations', text: `highlight ${n}` });
const many = (n: number): ImportItem[] => Array.from({ length: n }, (_, i) => item(i));

/** A fake `commit_import` that records what it was called with. */
function recorder(replies: Partial<ImportResult>[]) {
  const calls: { size: number; importId: string | null }[] = [];
  const call: CommitChunk = async (chunk, importId) => {
    calls.push({ size: chunk.length, importId });
    return replies[calls.length - 1] ?? {};
  };
  return { call, calls };
}

describe('foldChunks', () => {
  it('splits at the RPC ceiling and sends every item once', async () => {
    const { call, calls } = recorder([{ importId: 'i1' }, {}, {}]);
    await foldChunks(many(1201), call);
    expect(calls.map((c) => c.size)).toEqual([500, 500, 201]);
  });

  it('threads the first importId into every later call', async () => {
    // This is what makes a 3,000-highlight file ONE batch. Without it `commit_import`
    // falls back to a time window, six chunks can land in six batches, and one Undo
    // takes back a sixth of a library.
    const { call, calls } = recorder([{ importId: 'batch-1' }, {}, {}]);
    await foldChunks(many(1100), call);
    expect(calls.map((c) => c.importId)).toEqual([null, 'batch-1', 'batch-1']);
  });

  it('accumulates the counts rather than reading the last chunk', async () => {
    // Each call reports only what that call did. Reading the final chunk's numbers
    // would tell a reader who imported 1,100 highlights that they kept the last 100.
    const { call } = recorder([
      { importId: 'i', added: 500, duplicates: 0 },
      { added: 480, duplicates: 20 },
      { added: 90, duplicates: 10 },
    ]);
    const total = await foldChunks(many(1100), call);
    expect(total).toMatchObject({ importId: 'i', added: 1070, duplicates: 30 });
  });

  it('counts a book once however many chunks mention it', async () => {
    const w = { workId: 'w1', title: 'Meditations', slug: 'meditations' };
    const { call } = recorder([{ importId: 'i', works: [w] }, { works: [w] }, { works: [w] }]);
    const total = await foldChunks(many(1100), call);
    expect(total.works).toEqual([w]);
  });

  it('sorts the books by title, so the screen lists them predictably', async () => {
    const { call } = recorder([
      {
        importId: 'i',
        works: [
          { workId: 'b', title: 'Walden', slug: 'walden' },
          { workId: 'a', title: 'Meditations', slug: 'meditations' },
        ],
      },
    ]);
    const total = await foldChunks(many(2), call);
    expect(total.works.map((w) => w.title)).toEqual(['Meditations', 'Walden']);
  });

  it('stops sending once a ceiling is reported', async () => {
    // Past the item ceiling nothing later can be stored either, so the remaining chunks
    // would each be a round trip that adds nothing. `commit_import` reports the stop
    // rather than raising precisely so the client can act on it.
    const { call, calls } = recorder([
      { importId: 'i', added: 500 },
      { added: 12, ceilingReached: true },
      { added: 500 },
    ]);
    const total = await foldChunks(many(1500), call);
    expect(calls).toHaveLength(2);
    expect(total).toMatchObject({ added: 512, ceilingReached: true });
  });

  it('makes no call at all when nothing survived shaping', async () => {
    // `commit_import` returns early on an empty array, but the round trip is still a
    // round trip, and `toImportItems` can legitimately drop every item.
    const { call, calls } = recorder([]);
    const total = await foldChunks([], call);
    expect(calls).toEqual([]);
    expect(total).toEqual({
      importId: null,
      added: 0,
      duplicates: 0,
      ceilingReached: false,
      works: [],
    });
  });

  it('survives a chunk that answers with nothing', async () => {
    // PostgREST can hand back `null` data on a function that returned SQL NULL, and a
    // provider that predates a field simply omits it. Neither should produce NaN.
    const { call } = recorder([{}, {}]);
    const total = await foldChunks(many(600), call);
    expect(total.added).toBe(0);
    expect(total.duplicates).toBe(0);
    expect(total.importId).toBeNull();
  });

  it('carries what landed on the error, so Undo keeps its batch id', async () => {
    // `commit_import` is one transaction per CALL, not one per file: a chunk that fails
    // leaves the earlier chunks stored. The error has to reach the screen -- but a bare
    // rethrow loses the `importId` those chunks share, and that id is the only handle
    // Undo has. A reader would be told the import failed while 500 highlights sat in
    // their library with no way to take them back.
    //
    // This test was previously named for that property and asserted only that it threw,
    // which it did while discarding the id.
    const boom: CommitChunk = async (_chunk, importId) => {
      if (importId) throw new Error('the second chunk failed');
      return { importId: 'i', added: 500, works: [{ workId: 'w', title: 'W', slug: 'w' }] };
    };

    const err = await foldChunks(many(600), boom).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialImportError);
    const partial = (err as PartialImportError).partial;
    expect(partial.importId).toBe('i');
    expect(partial.added).toBe(500);
    // Collected, not left empty: the screen names the books it kept beside the failure.
    expect(partial.works).toEqual([{ workId: 'w', title: 'W', slug: 'w' }]);
    expect((err as PartialImportError).message).toBe('the second chunk failed');
  });

  it('rethrows plainly when the first chunk fails, because nothing landed', async () => {
    // No batch was opened, so there is nothing to undo and no id to hand back. Dressing
    // this up as a partial success with `importId: null` would put an Undo button on
    // screen that cannot do anything.
    const boom: CommitChunk = async () => {
      throw new Error('the first chunk failed');
    };
    const err = await foldChunks(many(600), boom).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PartialImportError);
    expect((err as Error).message).toBe('the first chunk failed');
  });

  it('resumes an existing batch, so a retry does not open a second one', async () => {
    // What makes a retry after a partial failure recoverable. Without it the rejoin is
    // `commit_import`'s reuse window -- a clock -- and a reader who came back the next
    // day would get a second batch that one Undo could not take back.
    const { call, calls } = recorder([{}, {}]);
    await foldChunks(many(600), call, 'batch-1');
    expect(calls.map((c) => c.importId)).toEqual(['batch-1', 'batch-1']);
  });

  it('still reports the resumed batch id when no call returns one', async () => {
    // `commit_import` returns the id it used, so this is belt and braces -- but a reply
    // that omitted it must not blank out the id the caller supplied, or the Undo button
    // disappears on the retry that was meant to restore it.
    const { call } = recorder([{ added: 3 }]);
    const total = await foldChunks(many(2), call, 'batch-1');
    expect(total.importId).toBe('batch-1');
  });
});
