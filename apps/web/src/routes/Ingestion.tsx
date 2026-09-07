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
  batchIsGone,
  canKeep,
  footerLine,
  forgetsOnParse,
  type ImportAction,
  type ImportFailure,
  keepFailed,
  keepLabel,
  showsKeep,
  showsUndo,
  resultHeadline,
  undoLabel,
  undoFailed,
} from '../lib/import-screen.js';
import { collateral } from '../lib/undo-summary.js';
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
  /*
   * WHICH action is running, not merely that one is. A shared boolean made the Undo
   * button relabel itself "Undoing…" while a retry was resending 1,200 highlights --
   * and on that path it is the only button on screen, because clearing `failure` at the
   * start of the retry unmounts the Keep button for as long as the retry runs.
   */
  const [busy, setBusy] = useState<ImportAction | null>(null);
  const keeping = busy !== null;
  const [result, setResult] = useState<ImportResult | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [shaped, setShaped] = useState<ReturnType<typeof toImportItems> | null>(null);
  /*
   * WHICH ACTION FAILED -- and, now, ONLY for the wording.
   *
   * A single `error` string used to gate the Keep button's visibility and its label too,
   * so a failed UNDO re-armed Keep as "Keep the rest" on an import that had fully
   * succeeded and that the reader was trying to delete; pressing it resent the whole file
   * into the batch under deletion. Splitting the flag by action fixed that and broke
   * something else, because a flag is the wrong home for "there is a rest to send": three
   * transitions clear this one and none can re-raise it, so a partial import lost its
   * button whenever an Undo was attempted or a retry was superseded.
   *
   * So the affordances read `result.complete` instead (see `import-screen`), and this
   * decides only which sentence is shown and that it is shown in the accent colour.
   */
  const [failure, setFailure] = useState<ImportFailure | null>(null);
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

    /*
     * THE SAME TEXT IS THE SAME FILE, and clearing the result for it was two defects.
     *
     * Re-parsing an identical file dropped `result`, so `resume` went null and
     * `commit_import` fell back to its six-hour reuse window -- which returns the FIRST
     * batch's id. The panel then said "Kept 0 highlights across 0 books" beside an Undo
     * that would take back everything the first attempt stored. And any re-parse at all
     * destroyed the only handle on that batch, since this PR ships no other surface that
     * can undo one.
     *
     * Unchanged text keeps the result and its Undo; changed text is a different import
     * and clears them, which is what stops a stale batch id being joined to a new file.
     *
     * THE FAILURE IS CLEARED WITH THEM RATHER THAN ALWAYS, which it was. Clearing it on
     * every parse removed "Keep the rest" from a partial import the moment the reader
     * re-picked the same file, back when the Keep button read the failure to decide
     * whether a rest remained. The button reads `result.complete` now, so that particular
     * stranding cannot recur through this path -- but the failure still belongs to the
     * text it was raised for, and carrying it onto a different file would show the reader
     * a sentence about an import they have moved on from.
     */
    if (forgetsOnParse(text, rawText)) {
      setResult(null);
      setUndone(null);
      setSkipped(0);
      setFailure(null);
    }

    if (!text.trim()) {
      setSummary(null);
      setShaped(null);
      return;
    }

    const parsed: ParsedHighlight[] = text.includes('==========')
      ? parseKindleClippings(text)
      : parseCsvHighlights(text);

    setSummary(parsed.length > 0 ? summarizeIngestion(parsed) : null);
    // SHAPED HERE, not at the moment of keeping, so the button can promise the number it
    // will actually deliver. It said `summary.totalHighlights` and then reported fewer,
    // because `toImportItems` drops what the RPC would refuse -- so a file with one
    // 20,001-character highlight offered "Keep 1204 highlights" and kept 1,203.
    const next = parsed.length > 0 ? toImportItems(parsed) : null;
    setShaped(next);
    // AND COUNTED HERE TOO, for the same reason the shaping moved. `skipped` was set
    // inside `handleKeep`, so the sentence explaining what would be dropped only appeared
    // after the reader had already committed to keeping -- and when EVERYTHING was
    // dropped the button read "Keep 0 highlights", was enabled, and answered a press with
    // an error. Now the count is known before the button is, so the panel can say so.
    setSkipped(next?.skipped ?? 0);
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

  /*
   * One sentence for the permanent live region, so the outcome is spoken rather than
   * only drawn. Deliberately short: the panels carry the detail visually, and a screen
   * reader repeating six lines on every state change is worse than a summary.
   */
  const announcement = undone
    ? 'Import undone.'
    : result
      ? `Kept ${result.added} ${result.added === 1 ? 'highlight' : 'highlights'}.`
      : '';

  /*
   * The three values every affordance below is decided from. Gathered once so the
   * decisions are made in `import-screen.ts`, where they can be tested -- nothing renders
   * this route under a `node` suite with no jsdom, and six mutants on the conditions that
   * used to be written inline here all survived because of it.
   */
  const panel = { result, undone: undone !== null, failure };

  const handleKeep = async () => {
    if (!summary || !shaped || keeping) return;
    const mine = generation.current;
    setBusy('keep');
    setFailure(null);
    // A new attempt supersedes the last Undo's message. Without this a successful keep
    // rendered "Kept 500 highlights" and "Removed 500 highlights" in the same panel.
    setUndone(null);
    try {
      const { items } = shaped;
      // A backstop now rather than the first line of defence: `canKeep` disables the
      // button when there is nothing to send, so this is unreachable from the screen. It
      // stays because the alternative is sending an empty chunk, which opens no batch and
      // would leave "Kept 0 highlights across 0 books" on screen with no button beside it.
      if (items.length === 0) {
        setFailure({
          action: 'keep',
          message:
            'None of these could be kept — each needs a title, some text, and fewer than 20,000 characters.',
        });
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
       * failure below them, in the alert region at the foot of the panel.
       */
      if (generation.current !== mine) return;
      // Merged for the same reason a success is: a retry that fails early carries the
      // batch id and small numbers, and `mergeAttempts` keeps the larger reading rather
      // than overwriting what the reader was already shown.
      if (e instanceof PartialImportError) {
        const { partial } = e;
        setResult((prev) => mergeAttempts(prev, partial));
      }
      /*
       * A BATCH THAT IS GONE IS NOT ONE TO KEEP RESENDING. If the batch was undone --
       * in another tab, or here by an Undo whose answer was lost -- `result.importId`
       * names a tombstone, `commit_import`'s named branch refuses it with 22023, and it
       * refuses it identically on every press after this one. Forgetting the id lets the
       * next press open a fresh batch, which is what the reader is asking for.
       *
       * `batchIsGone` rather than `sqlState(e)` directly, because the error here is
       * wrapped: see its own comment for why the direct check could never match.
       */
      if (batchIsGone(e)) setResult(null);
      setFailure(keepFailed(e));
    } finally {
      /*
       * UNCONDITIONALLY, and it was conditioned on the generation first.
       *
       * `keeping` is one flag for one screen, not a fact about a request: a superseded
       * attempt that skipped the reset left it `true` for the life of the tab, so the
       * button read "Keeping…" and stayed disabled, `handleKeep` refused on its own
       * guard, and `handleUndo` refused on the same flag. The screen was dead until a
       * reload -- reachable by doing exactly what the inputs are deliberately left
       * editable for: picking a second file while the first is still uploading.
       *
       * Clearing it always is safe because only one attempt can be in flight: both
       * handlers refuse while it is set.
       */
      setBusy(null);
    }
  };

  const handleUndo = async () => {
    if (!result?.importId || keeping) return;
    // The same capture `handleKeep` makes, and for the same reason: an Undo in flight
    // when the reader picks another file would otherwise write the old batch's counts
    // under the new one.
    const mine = generation.current;
    setBusy('undo');
    setFailure(null);
    try {
      const answer = await undoImport(result.importId);
      if (generation.current !== mine) return;
      setUndone(answer);
      /*
       * AND THE RESULT GOES WITH IT. The batch is a tombstone now: its id cannot be added
       * to and cannot be undone again to any effect, so holding it only misreports the
       * screen. Keeping it is what made `undone` have to gate both buttons -- and that
       * gate, once a re-parse of identical text stopped clearing `undone`, left the panel
       * with no control at all, under copy telling the reader to upload the file again.
       * Clearing it here means Keep comes back on its own and Undo goes on its own.
       */
      setResult(null);
    } catch (e) {
      if (generation.current !== mine) return;
      setFailure(undoFailed(e));
    } finally {
      setBusy(null);
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
          browser, and nothing leaves it until you choose to keep these. Nothing is added to your
          Delta either way.
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

          {/* THE ANNOUNCEMENT IS THE PERMANENT REGION BELOW, not these panels.
              `App.tsx:1149` states the rule: "A live region that is always present and
              changes its text is what gets announced; rendering the region itself
              conditionally is the version that stays silent." All three panels here were
              created at the same moment as their text, so a reader using a screen reader
              was told nothing when an import finished, failed, or was undone. */}
          {result && (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <p style={{ fontWeight: 600 }}>{resultHeadline(result)}</p>
              {result.duplicates > 0 && (
                <p className="form-note">{result.duplicates} you already had, left alone.</p>
              )}
              {/* NO REMEDY, because the one that used to be here is false at one of the
                  two ceilings. `ceilingReached` cannot say which was hit -- the item
                  ceiling ends the chunk, the book ceiling declines one title and carries
                  on -- and at the BOOK ceiling undoing frees nothing: `v_books` counts
                  distinct works over every `import_items` row with no `undone_at` filter,
                  unlike `v_held` which excludes tombstones deliberately. A reader who
                  followed the instruction destroyed an import and got the identical
                  refusal. `failureLine` strips this same sentence from the batch-ceiling
                  message with the same reasoning; it was left standing one panel over. */}
              {result.ceilingReached && (
                <p className="form-note">
                  Some highlights were not kept — this account is at a limit (20,000 highlights
                  held, or 2,000 books ever imported).
                </p>
              )}
              <p className="form-note">They are in your Library, and due for review tomorrow.</p>
            </div>
          )}

          {/* BEFORE THE BUTTON RATHER THAN AFTER THE IMPORT. This sat inside the panel
              above, so the reader learned what would be dropped only once it had been --
              and when everything was dropped there was no panel to say it in, just a
              button reading "Keep 0 highlights" that answered a press with an error. */}
          {skipped > 0 && (
            <p className="meta" style={{ marginBottom: 'var(--space-3)' }}>
              {/* "3 of these cannot be kept" reads as a subset, and for a three-highlight
                  file it was the whole thing. */}
              {shaped?.items.length === 0
                ? 'None of these can be kept'
                : `${skipped} of these cannot be kept`}{' '}
              — each needs a title, some text, and fewer than 20,000 characters.
            </p>
          )}

          {undone && (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <p className="meta">
                {undone.alreadyUndone
                  ? 'Already removed.'
                  : `Removed ${undone.removed} ${undone.removed === 1 ? 'highlight' : 'highlights'}.`}{' '}
                {/* It said "Uploading the same file again brings them back", and since a
                    completed Undo now clears `result`, the Keep button is already back on
                    screen with the file still parsed -- so a reader who followed that
                    sentence uploaded the same file and watched nothing happen. */}
                Keeping them again brings them back.
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

          {/* THE TWO PERMANENT REGIONS. Always mounted, empty until there is something
              to say, so a screen reader is actually told. `role="alert"` on the failure
              rather than `status`.

              `.form-error` rather than `.meta` and an inline colour, which is what this
              was and which review showed was only half a fix. `.meta` is the LABEL face
              -- mono, uppercase, tracked -- so a statement timeout rendered as THAT TOOK
              TOO LONG TO FINISH in 12px; and having moved it to the accent, it still
              differed from "They are in your Library" one line above by nothing but hue,
              which design law 5 says is never enough on its own. `.form-error` is body
              face with a hairline rule beside it, so the difference survives without
              colour.

              An earlier version of this comment cited `Auth.tsx`, `Review.tsx` and
              `Interrupt.tsx` as all doing accent-plus-role. `Review.tsx` does not: it has
              three `role="alert"` nodes and no `var(--accent)` at all, two of them plain
              `.meta`. Two of the three. */}
          <p role="status" className="form-note" style={{ marginBottom: 'var(--space-3)' }}>
            {announcement}
          </p>
          <p role="alert" className="form-error" style={{ marginBottom: 'var(--space-3)' }}>
            {failure?.message ?? ''}
          </p>

          <div className="pull-card__footer">
            {/* Shown again after a KEEP fails, including a PARTIAL one -- otherwise a
                reader whose fourth chunk timed out is left with 1,500 highlights kept, an
                error, and no way to finish. Pressing it again is cheap and safe:
                `commit_import` dedupes on `content_hash`, so what already landed is
                counted as a duplicate rather than stored twice.

                After a failed UNDO it stays hidden, which it did not: one `error` flag
                served both verbs, so a failed Undo put "Keep the rest" back on screen for
                an import that had succeeded, and pressing it resent the whole file into
                the batch the reader was trying to delete. */}
            {showsKeep(panel) && (
              <button
                type="button"
                className="btn"
                onClick={handleKeep}
                disabled={!canKeep(busy, shaped?.items.length ?? 0)}
              >
                {keepLabel(panel, busy, shaped?.items.length ?? 0)}
              </button>
            )}
            {showsUndo(panel) && (
              <button
                type="button"
                className="btn btn--plain"
                onClick={handleUndo}
                disabled={keeping}
              >
                {undoLabel(result, busy)}
              </button>
            )}
            <span className="meta">{footerLine(panel)}</span>
          </div>
        </section>
      )}
    </div>
  );
}
