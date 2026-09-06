import { describe, expect, it } from 'vitest';
import {
  type CommitChunk,
  foldChunks,
  hashFile,
  type ImportResult,
  mergeAttempts,
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

  it('keeps sending after a ceiling, because the flag does not say which one', async () => {
    // `commit_import` raises `ceilingReached` at BOTH its ceilings and behaves
    // oppositely at each: the item ceiling `exit`s the chunk, the book ceiling declines
    // one title and carries on, "because a later item may sit on a book this reader
    // already owns, which costs no book quota". One boolean cannot tell those apart.
    //
    // This test asserted the opposite until Codex pointed at the migration. Stopping
    // meant a reader at the 2,000-book ceiling importing a library silently lost every
    // chunk after the first new title -- including highlights on books they already had
    // room for. The third chunk below is exactly that case.
    const { call, calls } = recorder([
      { importId: 'i', added: 500 },
      { added: 12, ceilingReached: true },
      { added: 500 },
    ]);
    const total = await foldChunks(many(1500), call);
    expect(calls).toHaveLength(3);
    expect(total).toMatchObject({ added: 1012, ceilingReached: true });
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

describe('hashFile', () => {
  it('is the sha256 of the text, as 64 lowercase hex characters', () => {
    // `imports.file_hash` has a `^[0-9a-f]{64}$` check (`20260905110000:65`) and the
    // reuse window matches on it, so this value is what joins six chunks of one
    // clippings file into one batch -- and therefore what makes one Undo take the whole
    // file back rather than a sixth of it. It had no test at all, in the module that
    // exists so the parts with a bug in them are reachable without a network.
    return expect(hashFile('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('answers null rather than throwing where there is no digest to compute', async () => {
    // `crypto.subtle` is secure-context-gated, so over plain http it is absent. The RPC
    // takes a null hash and gives a hashless source its own five-minute window, so
    // losing the hash costs a weaker window; throwing would cost the reader their
    // import.
    // AWAITED INSIDE THE TRY. Returning the assertion instead let `finally` restore
    // `crypto` before `hashFile` ever ran, so the test passed against the real digest
    // path and never entered the fallback it is named for.
    //
    // What this CANNOT distinguish, recorded rather than left for someone to hunt:
    // deleting the `|| !crypto.subtle` guard does not fail this test, because the
    // `try/catch` below it returns null on the resulting TypeError anyway. The two
    // paths are behaviourally identical from outside, so the assertion is about the
    // answer -- null, never a throw -- and not about which branch produced it.
    const real = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      await expect(hashFile('abc')).resolves.toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});

describe('mergeAttempts', () => {
  const base = (over: Partial<ImportResult> = {}): ImportResult => ({
    importId: 'i',
    added: 0,
    duplicates: 0,
    ceilingReached: false,
    works: [],
    ...over,
  });

  it('is the retry itself when there was no earlier attempt', () => {
    const only = base({ added: 3 });
    expect(mergeAttempts(null, only)).toBe(only);
  });

  it('sums what landed, so a retry does not report only its own share', () => {
    // The case Codex named: 500 of 600 land, the retry resends all 600 and reports
    // `added: 100, duplicates: 500`. Read off the retry alone, the screen tells a reader
    // who kept 600 highlights that they kept 100.
    const total = mergeAttempts(base({ added: 500 }), base({ added: 100, duplicates: 500 }));
    expect(total.added).toBe(600);
  });

  it('distinguishes the formula from simply keeping the earlier count', () => {
    // Both of the fixtures below happen to pick numbers where
    // `next.duplicates - prev.added` equals `prev.duplicates`, so the suite could not
    // tell the implemented formula from `duplicates: prev.duplicates` -- a mutation
    // review ran and watched pass. This is the case that separates them: a retry that
    // finds twenty duplicates the first attempt never saw.
    const total = mergeAttempts(
      base({ added: 500, duplicates: 20 }),
      base({ added: 80, duplicates: 540 }),
    );
    expect(total.duplicates).toBe(40);
  });

  it('keeps the earlier count when a retry did not get far enough to restate it', () => {
    // A retry that fails partway has NOT re-walked everything, so its duplicate count is
    // smaller than the truth and the subtraction goes negative. Clamping to zero there
    // erases a number the reader was already shown: 100 highlights they already had
    // would silently stop being mentioned.
    const total = mergeAttempts(
      base({ added: 900, duplicates: 100 }),
      base({ added: 0, duplicates: 0 }),
    );
    expect(total.duplicates).toBe(100);
  });

  it('does not let a partial retry clear a ceiling the reader was told about', () => {
    // Same shape: a retry that drops early initialises the flag false. An Undo between
    // attempts could genuinely free room, but an Undo hides this panel and a new file
    // resets it, so the only sequence that reaches here is retries of one file.
    const total = mergeAttempts(base({ ceilingReached: true }), base({ added: 0 }));
    expect(total.ceilingReached).toBe(true);
  });

  it('prefers the batch id the retry reports, and falls back to the earlier one', () => {
    // Both directions, because neither was covered and the mutation that swaps the
    // coalesce passes.
    expect(mergeAttempts(base({ importId: 'a' }), base({ importId: 'b' })).importId).toBe('b');
    expect(mergeAttempts(base({ importId: 'a' }), base({ importId: null })).importId).toBe('a');
  });

  it('lets the retry win a book both attempts touched', () => {
    // The retry is the newer reading of the same row, so it is the one to keep. Nothing
    // covered a collision, so the mutation that swaps the two loops passes.
    const older = { workId: 'w1', title: 'Meditations', slug: 'meditations' };
    const newer = { workId: 'w1', title: 'Meditations, Book II', slug: 'meditations' };
    const total = mergeAttempts(base({ works: [older] }), base({ works: [newer] }));
    expect(total.works).toEqual([newer]);
  });

  it("does not count the first attempt's own rows as duplicates", () => {
    // `duplicates` means "already in your library BEFORE this import". On the retry,
    // 500 of them are the first attempt's own rows, and 20 were genuinely already held.
    const total = mergeAttempts(
      base({ added: 500, duplicates: 20 }),
      base({ added: 100, duplicates: 520 }),
    );
    expect(total.duplicates).toBe(20);
  });

  it('clamps rather than going negative when the counts do not line up', () => {
    // The two numbers come from different calls; an Undo in between can lower the
    // retry's duplicate count. Nothing guarantees the subtraction stays positive.
    const total = mergeAttempts(base({ added: 500 }), base({ added: 0, duplicates: 1 }));
    expect(total.duplicates).toBe(0);
  });

  it('keeps a book the first attempt created and the retry did not touch', () => {
    const a = { workId: 'w1', title: 'Meditations', slug: 'meditations' };
    const b = { workId: 'w2', title: 'Walden', slug: 'walden' };
    const total = mergeAttempts(base({ works: [b] }), base({ works: [a] }));
    expect(total.works.map((w) => w.title)).toEqual(['Meditations', 'Walden']);
  });

  it('latches the ceiling once any attempt has reported it', () => {
    // This asserted the opposite until review pointed out what it costs. "The retry is
    // the newer fact" is true only of a retry that got far enough to have a fact: one
    // that fails early initialises the flag `false` and would clear a ceiling the reader
    // had already been told about.
    //
    // The case latching was written for -- an Undo freeing room between attempts --
    // cannot reach here: an Undo hides this panel entirely and a new file resets the
    // result, so the only sequence `mergeAttempts` ever sees is retries of one file.
    const total = mergeAttempts(base({ ceilingReached: true }), base({ ceilingReached: false }));
    expect(total.ceilingReached).toBe(true);
  });

  it('keeps the earlier batch id when a retry answers without one', () => {
    const total = mergeAttempts(base({ importId: 'batch-1' }), base({ importId: null }));
    expect(total.importId).toBe('batch-1');
  });
});
