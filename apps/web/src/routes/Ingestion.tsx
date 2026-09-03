import { useState } from 'react';
import {
  type IngestionSummary,
  type ParsedHighlight,
  parseCsvHighlights,
  parseKindleClippings,
  summarizeIngestion,
} from '../lib/ingestion.js';

export interface IngestionProps {
  onComplete?: (summary: IngestionSummary) => void;
}

export function Ingestion({ onComplete }: IngestionProps) {
  const [rawText, setRawText] = useState('');
  const [summary, setSummary] = useState<IngestionSummary | null>(null);
  const [synced, setSynced] = useState(false);

  const handleParse = (text: string) => {
    setRawText(text);
    if (!text.trim()) {
      setSummary(null);
      return;
    }

    const parsed: ParsedHighlight[] = text.includes('==========')
      ? parseKindleClippings(text)
      : parseCsvHighlights(text);

    if (parsed.length > 0) {
      setSummary(summarizeIngestion(parsed));
      setSynced(false);
    } else {
      setSummary(null);
    }
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

  const handleSync = () => {
    if (!summary) return;
    try {
      localStorage.setItem('wap_ingested_highlights_count', String(summary.totalHighlights));
      localStorage.setItem('wap_ingested_books_count', String(summary.distinctBooks.length));
      localStorage.setItem('wap_ingested_hours_saved', String(summary.estimatedHoursSaved));
    } catch {
      // Local storage unavailable or full
    }
    setSynced(true);
    onComplete?.(summary);
  };

  return (
    <div className="shell__column" style={{ padding: 'var(--space-4) 0' }}>
      <header style={{ marginBottom: 'var(--space-4)' }}>
        <span className="pull-card__chip" style={{ color: 'var(--accent)' }}>
          The Universal Bridge
        </span>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, margin: 'var(--space-2) 0' }}>
          Universal Reading Ingestion
        </h1>
        <p className="meta">
          Never start from zero. Import your Kindle clippings or Readwise exports so What a Pull
          knows which core concepts you already understand.
        </p>
      </header>

      <section className="pull-card" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 className="pull-card__headline" style={{ fontSize: '1.25rem' }}>
          Choose your file or paste clippings
        </h2>
        <div style={{ margin: 'var(--space-3) 0' }}>
          <label
            className="btn btn--plain"
            style={{ cursor: 'pointer', border: '1px dashed var(--border)' }}
          >
            <span>📁 Upload My Clippings.txt or CSV</span>
            <input
              type="file"
              accept=".txt,.csv"
              style={{ display: 'none' }}
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
            Calibration Analysis
          </span>
          <h2 className="pull-card__headline" style={{ fontSize: '1.4rem' }}>
            {summary.totalHighlights} Highlights Across {summary.distinctBooks.length} Books
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
              <p className="meta">Future Time Spared</p>
              <p style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--accent)' }}>
                ~{summary.estimatedHoursSaved}h
              </p>
            </div>
            <div>
              <p className="meta">Identified Authors</p>
              <p style={{ fontSize: '1.75rem', fontWeight: 700 }}>{summary.distinctBooks.length}</p>
            </div>
          </div>

          <p className="meta" style={{ marginBottom: 'var(--space-3)' }}>
            These highlights seed your retrievability lattice. When encountering these authors and
            principles, What a Pull automatically calculates the delta rather than re-explaining
            them.
          </p>

          <div className="pull-card__footer">
            <span className="meta">{synced ? '✓ Synced to your Delta' : 'Ready to calibrate'}</span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={synced}
              onClick={handleSync}
            >
              {synced ? 'Import Completed' : 'Sync With My Delta →'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
