import { useState } from 'react';
import {
  type IngestionSummary,
  type ParsedHighlight,
  parseCsvHighlights,
  parseKindleClippings,
  summarizeIngestion,
} from '../lib/ingestion.js';

/*
 * No props. `onComplete` existed to navigate to /metacognition on Done, which re-implied
 * by navigation the Delta sync this screen does not perform; removing the destination
 * left the callback and its button doing nothing at all, so both are gone.
 */
export function Ingestion() {
  const [rawText, setRawText] = useState('');
  const [summary, setSummary] = useState<IngestionSummary | null>(null);

  const handleParse = (text: string) => {
    setRawText(text);
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
      handleParse(content);
    };
    reader.readAsText(file);
  };

  /*
   * There was a "Sync With My Delta →" button here that wrote three counters to
   * `localStorage`, set a flag, and reported "✓ Synced to your Delta". Nothing read those
   * keys. The feed, the source Delta and the knowledge graph were unchanged, and the
   * Delta itself derives known ideas from `knowledge_states` rows that this never wrote —
   * so the one thing the screen claimed to do was the one thing it did not do.
   *
   * It is not replaced with a working import because that is a design decision rather
   * than a missing function call: see the header of `lib/ingestion.ts` for what law 2 and
   * law 4 each require of one first. What is left is the half that is real — a parser,
   * and a count of what it found.
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
            Read here and nowhere else. Bringing these into your Delta means matching each highlight
            to an idea, which is a cost per reader that has to be bounded before it is spent, and
            storing them means storing text from books under copyright. Both are open questions, so
            neither has been answered by pretending.
          </p>

          <div className="pull-card__footer">
            {/* No button. Removing the misleading /metacognition destination left this
                one resolving to nothing — a control that changed nothing on screen. The
                result panel is the whole outcome, so the line below is the whole footer. */}
            <span className="meta">Parsed in your browser · nothing uploaded</span>
          </div>
        </section>
      )}
    </div>
  );
}
