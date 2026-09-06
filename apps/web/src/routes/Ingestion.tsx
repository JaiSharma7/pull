import { useRef, useState } from 'react';
import {
  commitImport,
  hashFile,
  type ImportResult,
  type ImportSourceKind,
  mergeAttempts,
  PartialImportError,
  type UndoResult,
  undoImport,
} from '../lib/import-api.js';
import {
  type IngestionSummary,
  type ParsedHighlight,
  parseCsvHighlights,
  parseKindleClippings,
  summarizeIngestion,
  toImportItems,
} from '../lib/ingestion.js';

/*
 * No props. `onComplete` existed to navigate to /metacognition on Done, which re-implied
 * by navigation the Delta sync this screen does not perform; removing the destination
 * left the callback and its button doing nothing at all, so both are gone.
 */
/**
 * What an Undo took beyond the highlights, in a sentence, or null if it took nothing.
 *
 * `undo_import` deletes the batch's Pulls and everything that cascades off them. The
 * counts come back in `alsoRemoved` precisely so a reader can be told; naming them is
 * the difference between an Undo and a surprise.
 */
function collateral(u: UndoResult): string | null {
  const parts = [
    [u.alsoRemoved.questions, 'question', 'questions'],
    [u.alsoRemoved.grades, 'recorded review', 'recorded reviews'],
    [u.alsoRemoved.notes, 'note', 'notes'],
    [u.alsoRemoved.highlights, 'highlight of your own', 'highlights of your own'],
    [u.alsoRemoved.explanations, 'explanation', 'explanations'],
    [u.alsoRemoved.convictions, 'recorded stance', 'recorded stances'],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  // `at(-1)` rather than an index, because `noUncheckedIndexedAccess` widens every
  // index to `| undefined` and the emptiness is already decided one line up.
  const last = said.at(-1);
  if (last === undefined) return null;
  return said.length === 1 ? last : `${said.slice(0, -1).join(', ')} and ${last}`;
}

export function Ingestion() {
  const [rawText, setRawText] = useState('');
  const [summary, setSummary] = useState<IngestionSummary | null>(null);
  /*
   * `paste` unless a file was chosen, and the file's own kind when one was.
   * `commit_import` uses it in the reuse window: a hashless source is matched on
   * `source_kind` alone, so calling every upload a paste would let two unrelated files
   * merge into one batch and make an Undo of the second take the first one's highlights.
   */
  const [sourceKind, setSourceKind] = useState<ImportSourceKind>('paste');
  const [keeping, setKeeping] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState<UndoResult | null>(null);
  /*
   * WHICH INPUT A PENDING REQUEST BELONGS TO.
   *
   * The file input and the textarea stay editable while `commitImport` is in flight, and
   * `handleParse` clears the result -- but the in-flight request still resolves, and it
   * used to write its answer under whatever is on screen by then. Two ways that hurt:
   * the counts describe a file the reader is no longer looking at, and "Keep the rest"
   * would then send the OLD batch id with the NEW file's items. `commit_import`'s
   * explicit-id branch checks that the batch is yours and open, not that it is the same
   * source or the same file -- so two unrelated uploads would become one batch, and one
   * Undo would take back both.
   *
   * A counter rather than an AbortController because the work is a chain of RPCs that
   * have already stored rows; the request cannot be recalled, only its answer ignored.
   */
  const generation = useRef(0);

  const handleParse = (text: string, kind: ImportSourceKind = 'paste') => {
    // Anything still in flight now belongs to a file the reader has moved on from.
    generation.current += 1;
    setRawText(text);
    setSourceKind(kind);
    // A new file is a new import: the previous result described a different upload, and
    // leaving it on screen beside fresh counts is the kind of stale number this screen
    // has had to have removed before.
    setResult(null);
    setError(null);
    setUndone(null);
    setSkipped(0);

    if (!text.trim()) {
      setSummary(null);
      return;
    }

    const parsed: ParsedHighlight[] = text.includes('==========')
      ? parseKindleClippings(text)
      : parseCsvHighlights(text);

    setSummary(parsed.length > 0 ? summarizeIngestion(parsed) : null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      handleParse(content, file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'kindle');
    };
    reader.readAsText(file);
  };

  const handleKeep = async () => {
    if (!summary || keeping) return;
    const mine = generation.current;
    setKeeping(true);
    setError(null);
    try {
      const { items, skipped: dropped } = toImportItems(summary.highlights);
      setSkipped(dropped);
      if (items.length === 0) {
        setError('None of these highlights could be kept — each one needs a title and some text.');
        return;
      }
      // Hashed from the raw text rather than the parsed items, because the hash is what
      // joins chunks of ONE FILE into one batch, and two different parses of the same
      // file must produce the same hash.
      // The batch an earlier attempt opened, so a retry joins it rather than starting a
      // second one. Null on a first attempt, which is when `commit_import` opens one.
      const resume = result?.importId ?? null;
      const attempt = await commitImport(sourceKind, await hashFile(rawText), items, resume);
      if (generation.current !== mine) return;
      // MERGED, not replaced. A retry resends the whole file, so its counters describe
      // the attempt and not the batch -- see `mergeAttempts`.
      setResult((prev) => mergeAttempts(prev, attempt));
    } catch (e) {
      /*
       * A chunk that fails after an earlier one landed is not a failed import -- it is a
       * partial one, and `commit_import` is one transaction per call rather than one per
       * file, so what landed stays landed. Showing only the error would leave those
       * highlights in the reader's library with no way to take them back, because Undo
       * needs the batch id and the batch id is on the error.
       *
       * So both are shown: the counts and the Undo button from `partial`, and the
       * failure above them.
       */
      if (generation.current !== mine) return;
      // Merged for the same reason a success is, which also covers the case that used to
      // need its own guard: a retry failing on its first chunk carries the batch id and
      // zeroes, and `mergeAttempts` adds zero rather than overwriting the earlier counts.
      if (e instanceof PartialImportError) {
        const { partial } = e;
        setResult((prev) => mergeAttempts(prev, partial));
      }
      setError(e instanceof Error ? e.message : 'The import did not go through.');
    } finally {
      if (generation.current === mine) setKeeping(false);
    }
  };

  const handleUndo = async () => {
    if (!result?.importId || keeping) return;
    setKeeping(true);
    setError(null);
    try {
      setUndone(await undoImport(result.importId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The undo did not go through.');
    } finally {
      setKeeping(false);
    }
  };

  /*
   * There was a "Sync With My Delta →" button here that wrote three counters to
   * `localStorage`, set a flag, and reported "✓ Synced to your Delta". Nothing read those
   * keys, and the Delta derives known ideas from `knowledge_states` rows it never wrote.
   *
   * "Keep these highlights" is not that button working at last -- it is a different and
   * smaller promise, and the difference is the point. It stores the highlights as the
   * reader's own private Pulls, scheduled and saved, so they reach Review and the Library.
   * It does NOT put them in the Delta: that needs an embedding of the reader's verbatim
   * text, which is a model call over their own words and a privacy promise to revisit
   * first. The screen says what it does and no more.
   */

  return (
    <div className="shell__column" style={{ padding: 'var(--space-4) 0' }}>
      <header style={{ marginBottom: 'var(--space-4)' }}>
        <span className="pull-card__chip" style={{ color: 'var(--accent)' }}>
          Import
        </span>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, margin: 'var(--space-2) 0' }}>
          Bring in your highlights
        </h1>
        <p className="meta">
          Read your Kindle clippings or a Readwise export and see what is in them. This runs in your
          browser: nothing is uploaded, and nothing is added to your Delta yet.
        </p>
      </header>

      <section className="pull-card" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 className="pull-card__headline" style={{ fontSize: '1.25rem' }}>
          Choose a file, or paste your clippings
        </h2>
        <div style={{ margin: 'var(--space-3) 0' }}>
          {/*
            A real label, a focusable input, and no emoji.

            This was a `<label className="btn">` with `border: '1px dashed var(--border)'`
            wrapping a `display: none` file input. Three things wrong with that: `--border`
            is defined nowhere in this repository, so the shorthand was invalid at
            computed-value time and unset the border entirely — the dashed dropzone had no
            border at all; a `<label>` is not focusable and has no keyboard activation, so
            with the input hidden there was no way to upload a file without a pointer; and
            `📁` is ornament in a design system whose brief is that typography is the
            ornament.

            `sr-only` keeps the input reachable by keyboard and screen reader while the
            styled label works as the click target and carries the focus ring.
          */}
          <label
            className="btn btn--plain file-drop"
            htmlFor="clippings-file"
            style={{ cursor: 'pointer', border: '1px dashed var(--rule-strong)' }}
          >
            Upload My Clippings.txt or a CSV
            {/*
              Nested, not a `for`-associated sibling. `:focus-within` matches an element
              that is focused or *contains* a focused descendant, so as siblings the focus
              rule was dead — and the input's own ring is a `box-shadow`, which `sr-only`
              clips away with `clip-path: inset(50%)`. Tabbing here changed nothing on
              screen. Nesting puts the ring on the label the reader can see; the label
              wraps no other labelable control, so the association stays unambiguous.
            */}
            <input
              id="clippings-file"
              type="file"
              accept=".txt,.csv"
              className="sr-only"
              onChange={handleFileUpload}
            />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Or paste text directly</span>
          <textarea
            className="field__textarea"
            rows={5}
            value={rawText}
            onChange={(e) => handleParse(e.target.value)}
            placeholder="Paste raw text from Kindle My Clippings.txt or CSV export..."
          />
        </label>
      </section>

      {summary && (
        <section className="pull-card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <span className="pull-card__chip" style={{ color: 'var(--accent)' }}>
            What the file contains
          </span>
          <h2 className="pull-card__headline" style={{ fontSize: '1.4rem' }}>
            {summary.totalHighlights} highlights across {summary.distinctBooks.length} books
          </h2>

          <div
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              margin: 'var(--space-3) 0',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <p className="meta">Books</p>
              <p style={{ fontSize: '1.75rem', fontWeight: 700 }}>{summary.distinctBooks.length}</p>
            </div>
            <div>
              {/* Authors, from the author column. This tile read `distinctBooks.length`
                  under the heading "Identified Authors", so two books by one author
                  counted twice and a file without authors counted them anyway. Beside it
                  was a "Future Time Spared" figure of three minutes per highlight. */}
              <p className="meta">Authors</p>
              <p style={{ fontSize: '1.75rem', fontWeight: 700 }}>
                {summary.distinctAuthors.length}
              </p>
            </div>
          </div>

          <p className="meta" style={{ marginBottom: 'var(--space-3)' }}>
            Keeping these stores them as your own private ideas: nobody else can see them or see
            that they exist, they are never used to write anything for anyone else, and they go when
            your account does. They will not appear in your Delta — that needs each highlight
            matched to an idea, which is a cost worth answering separately.
          </p>

          {result && !undone && (
            <div role="status" style={{ marginBottom: 'var(--space-3)' }}>
              <p style={{ fontWeight: 600 }}>
                Kept {result.added} {result.added === 1 ? 'highlight' : 'highlights'} across{' '}
                {result.works.length} {result.works.length === 1 ? 'book' : 'books'}.
              </p>
              {result.duplicates > 0 && (
                <p className="meta">{result.duplicates} you already had, left alone.</p>
              )}
              {result.ceilingReached && (
                <p className="meta">
                  That is as many as this account can hold. Undo an import you no longer need to
                  make room.
                </p>
              )}
              {skipped > 0 && (
                <p className="meta">
                  {skipped} could not be kept — a highlight needs a title and some text.
                </p>
              )}
              <p className="meta">They are in your Library, and due for review tomorrow.</p>
            </div>
          )}

          {undone && (
            <div role="status" style={{ marginBottom: 'var(--space-3)' }}>
              <p className="meta">
                {undone.alreadyUndone
                  ? 'Already removed.'
                  : `Removed ${undone.removed} ${undone.removed === 1 ? 'highlight' : 'highlights'}.`}{' '}
                Uploading the same file again brings them back.
              </p>
              {/* WHAT ELSE WENT WITH THEM. `undo_import` cascades through anything a
                  reader built ON these Pulls, and it returns `alsoRemoved` for exactly
                  this -- so discarding it and saying only "Removed" let one click
                  destroy work the reader had done in another tab without ever naming
                  it. Re-importing restores the highlights; it does not restore these. */}
              {collateral(undone) && (
                <p className="meta">
                  That also removed {collateral(undone)}. Re-importing brings the highlights back,
                  but not those.
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="meta" role="status" style={{ marginBottom: 'var(--space-3)' }}>
              {error}
            </p>
          )}

          <div className="pull-card__footer">
            {/* Shown again after a failure, including a PARTIAL one -- otherwise a reader
                whose fourth chunk timed out is left with 1,500 highlights kept, an error,
                and no way to finish. Pressing it again is cheap and safe: `commit_import`
                dedupes on `content_hash`, so what already landed is counted as a
                duplicate rather than stored twice. */}
            {(!result || error) && !undone && (
              <button type="button" className="btn" onClick={handleKeep} disabled={keeping}>
                {keeping
                  ? 'Keeping…'
                  : error && result
                    ? 'Keep the rest'
                    : `Keep ${summary.totalHighlights} ${
                        summary.totalHighlights === 1 ? 'highlight' : 'highlights'
                      }`}
              </button>
            )}
            {result?.importId && !undone && (
              <button
                type="button"
                className="btn btn--plain"
                onClick={handleUndo}
                disabled={keeping}
              >
                {keeping ? 'Undoing…' : 'Undo'}
              </button>
            )}
            <span className="meta">
              {result ? 'Kept in your account' : 'Parsed in your browser · nothing uploaded yet'}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
