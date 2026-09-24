import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchImportedItems, fetchImportedWorks } from '../lib/import-api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { mutationId } from '../lib/submission.js';
import {
  fetchStudyUrlPreview,
  isPreviewableStudyUrl,
  suggestStudySources,
  type StudySuggestion,
} from '../lib/study-source-entry.js';
import { fitImportSource } from '../lib/studio.js';
import {
  extractStudyFile,
  recognizeStudyFile,
  type StudyExtraction,
} from '../lib/study-extraction.js';
import {
  deleteStudySource,
  fetchStudySources,
  fetchStudySourceText,
  saveStudySourceVersion,
  type SavedStudySource,
} from '../lib/study-source-api.js';
import {
  checkStudyText,
  MAX_STUDY_OCR_PAGES,
  MAX_STUDY_TEXT_CHARS,
  MAX_STUDY_TITLE_CHARS,
  type StudySourceFormat,
} from '../lib/study-source.js';

type IntakeMode = 'paste' | 'file' | 'highlights' | 'url' | 'goal';
type Book = { workId: string; title: string; kind: string | null };

export function StudyImport({ userId }: { userId: string }) {
  const [mode, setMode] = useState<IntakeMode>('paste');
  const [urlInput, setUrlInput] = useState('');
  const [goal, setGoal] = useState('');
  const [suggestions, setSuggestions] = useState<StudySuggestion[]>([]);
  const [goalSearched, setGoalSearched] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [format, setFormat] = useState<StudySourceFormat>('paste');
  const [originLabel, setOriginLabel] = useState('');
  const [extractionNotes, setExtractionNotes] = useState('');
  const [extraction, setExtraction] = useState<StudyExtraction | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [saved, setSaved] = useState<SavedStudySource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const [rightsChecked, setRightsChecked] = useState(false);
  const [sparseChecked, setSparseChecked] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [manualTextEdited, setManualTextEdited] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const [bookError, setBookError] = useState('');
  const [libraryReload, setLibraryReload] = useState(0);
  const [bookReload, setBookReload] = useState(0);
  const selection = useRef(0);
  const editRevision = useRef(0);
  const libraryRequest = useRef(0);
  const saving = useRef(false);
  const deleting = useRef(false);
  const submission = useRef<string | null>(null);

  const reloadSaved = useCallback(() => {
    const request = ++libraryRequest.current;
    fetchStudySources(userId)
      .then((rows) => {
        if (request !== libraryRequest.current) return;
        setSaved(rows);
        setLibraryError('');
      })
      .catch((cause: unknown) => {
        if (request !== libraryRequest.current) return;
        console.error('Could not read study sources', cause);
        setLibraryError('Could not read your saved study sources.');
      });
  }, [userId]);

  useEffect(() => {
    reloadSaved();
  }, [reloadSaved, libraryReload]);

  useEffect(() => {
    if (mode !== 'highlights') return;
    let live = true;
    fetchImportedWorks(userId)
      .then((rows) => {
        if (live) setBooks(rows);
      })
      .catch((cause: unknown) => {
        console.error('Could not list imported highlights', cause);
        if (live) setBookError('Could not read your imported books.');
      });
    return () => {
      live = false;
    };
  }, [mode, userId, bookReload]);

  function edited() {
    editRevision.current += 1;
    submission.current = null;
    setDirty(true);
    setSavedNotice('');
    setError('');
  }

  function confirmDiscard(): boolean {
    return !dirty || window.confirm('Discard your unsaved study text?');
  }

  function chooseMode(next: IntakeMode, force = false) {
    if (saving.current || (deleting.current && !force) || (next === mode && sourceId === null))
      return;
    if (!force && !confirmDiscard()) return;
    selection.current += 1;
    submission.current = null;
    setMode(next);
    setUrlInput('');
    setGoal('');
    setSuggestions([]);
    setGoalSearched(false);
    setTitle('');
    setText('');
    setFormat(next === 'highlights' ? 'highlights' : 'paste');
    setOriginLabel('');
    setExtractionNotes('');
    setExtraction(null);
    setFile(null);
    setSourceId(null);
    setVersionNo(null);
    setRightsChecked(false);
    setSparseChecked(false);
    setDirty(false);
    setManualTextEdited(false);
    setWorking(false);
    setError('');
    setStatus('');
    setSavedNotice('');
  }

  async function searchGoal() {
    if (working || saving.current || deleting.current) return;
    const request = ++selection.current;
    setWorking(true);
    setGoalSearched(false);
    setSuggestions([]);
    setError('');
    setStatus('Finding source-backed readings…');
    try {
      const found = await suggestStudySources(goal);
      if (selection.current !== request) return;
      setSuggestions(found);
      setGoalSearched(true);
      setStatus(found.length ? 'Choose a source to preview.' : '');
    } catch (cause: unknown) {
      if (selection.current !== request) return;
      console.error('Could not find study sources', cause);
      setError('Could not search the public catalogue. Try again or bring your own material.');
      setStatus('');
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function previewUrl(raw: string) {
    if (working || saving.current || deleting.current || !confirmDiscard()) return;
    if (!isPreviewableStudyUrl(raw)) {
      setError(
        'Use a short HTTPS link from Wikisource, MIT Classics, or Project Gutenberg. For other sites, paste the text.',
      );
      return;
    }
    const request = ++selection.current;
    submission.current = null;
    setWorking(true);
    setError('');
    setSavedNotice('');
    setStatus('Fetching the page for extraction…');
    setSourceId(null);
    setVersionNo(null);
    setText('');
    setTitle('');
    setExtraction(null);
    setFile(null);
    setDirty(false);
    setRightsChecked(false);
    setSparseChecked(false);
    try {
      const result = await fetchStudyUrlPreview(raw);
      if (selection.current !== request) return;
      setUrlInput(result.url);
      setTitle(result.title);
      setText(result.text);
      setOriginLabel(result.url);
      setExtractionNotes(result.notes);
      setFormat('text');
      setDirty(true);
      setStatus(
        'Preview ready. Compare the text with the linked page and correct it before saving.',
      );
    } catch (cause: unknown) {
      if (selection.current !== request) return;
      setError(cause instanceof Error ? cause.message : 'Could not preview this URL.');
      setStatus('');
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function chooseFile(selected: File) {
    if (saving.current || deleting.current || !confirmDiscard()) return;
    const request = ++selection.current;
    submission.current = null;
    setFile(selected);
    setExtraction(null);
    setText('');
    setFormat('paste');
    setOriginLabel('');
    setExtractionNotes('');
    setStatus('');
    setManualTextEdited(false);
    setTitle(selected.name.replace(/\.[^.]+$/, '').slice(0, MAX_STUDY_TITLE_CHARS));
    setSourceId(null);
    setVersionNo(null);
    setDirty(false);
    setRightsChecked(false);
    setSparseChecked(false);
    setError('');
    setSavedNotice('');
    setWorking(true);
    try {
      const result = await extractStudyFile(selected, (message) => {
        if (selection.current === request) setStatus(message);
      });
      if (selection.current !== request) return;
      setExtraction(result);
      setText(result.text);
      setFormat(result.format);
      setOriginLabel(result.originLabel);
      setExtractionNotes(result.notes);
      setStatus(
        result.sparsePages.length
          ? 'Some pages may have missing text. Run OCR or check them against the original.'
          : 'Extraction is ready for your review.',
      );
      setDirty(true);
    } catch (cause: unknown) {
      if (selection.current === request) {
        setError(cause instanceof Error ? cause.message : 'This file could not be read.');
      }
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function runOcr() {
    if (!file || !extraction || working) return;
    if (
      manualTextEdited &&
      !window.confirm('OCR will replace your edits in the text preview. Continue?')
    )
      return;
    const request = selection.current;
    setWorking(true);
    setError('');
    try {
      const result = await recognizeStudyFile(file, extraction, (message) => {
        if (selection.current === request) setStatus(message);
      });
      if (selection.current !== request) return;
      setExtraction(result);
      setText(result.text);
      setManualTextEdited(false);
      setFormat(result.format);
      setExtractionNotes(result.notes);
      setSparseChecked(false);
      setStatus('OCR is ready. Compare the text with the original before saving.');
      edited();
    } catch (cause: unknown) {
      if (selection.current === request) {
        setError(cause instanceof Error ? cause.message : 'OCR could not finish.');
      }
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function chooseBook(book: Book) {
    if (saving.current || deleting.current || !confirmDiscard()) return;
    const request = ++selection.current;
    submission.current = null;
    setSourceId(null);
    setVersionNo(null);
    setTitle(book.title.slice(0, MAX_STUDY_TITLE_CHARS));
    setText('');
    setFormat('highlights');
    setOriginLabel(book.title);
    setExtraction(null);
    setFile(null);
    setRightsChecked(false);
    setSparseChecked(false);
    setError('');
    setSavedNotice('');
    setWorking(true);
    setStatus('Reading your highlights…');
    try {
      const items = await fetchImportedItems(userId, book.workId);
      if (selection.current !== request) return;
      const fitted = fitImportSource(items, MAX_STUDY_TEXT_CHARS);
      setText(fitted.text);
      setExtractionNotes(
        fitted.complete
          ? 'Highlights kept in their saved order, with locators where available.'
          : 'Only the first ' +
              fitted.used +
              ' of ' +
              fitted.total +
              ' highlights fit in this source. Review this partial selection.',
      );
      setStatus(
        fitted.complete
          ? 'Highlights are ready for your review.'
          : 'This is only a prefix of your highlights. Split the reading if you need the rest.',
      );
      setDirty(true);
    } catch (cause: unknown) {
      if (selection.current === request) {
        setError(cause instanceof Error ? cause.message : 'Could not read those highlights.');
      }
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function openSaved(row: SavedStudySource) {
    if (saving.current || deleting.current || !confirmDiscard()) return;
    const request = ++selection.current;
    submission.current = null;
    setWorking(true);
    setError('');
    setStatus('Reading saved version…');
    try {
      const body = await fetchStudySourceText(userId, row.id);
      if (selection.current !== request) return;
      setMode('paste');
      setSourceId(row.sourceId);
      setVersionNo(row.versionNo);
      setTitle(row.title);
      setText(body);
      setFormat(row.format);
      setOriginLabel(row.originLabel ?? '');
      setExtractionNotes(row.extractionNotes ?? '');
      setFile(null);
      setExtraction(null);
      setSparseChecked(false);
      setRightsChecked(false);
      setDirty(false);
      setManualTextEdited(false);
      setSavedNotice('');
      setStatus('Version ' + row.versionNo + ' is open. Edits will create a new version.');
    } catch (cause: unknown) {
      if (selection.current === request) {
        setError(cause instanceof Error ? cause.message : 'Could not open that source.');
      }
    } finally {
      if (selection.current === request) setWorking(false);
    }
  }

  async function removeSaved(row: SavedStudySource) {
    if (
      working ||
      saving.current ||
      deleting.current ||
      !window.confirm('Delete this private source and all its versions? This cannot be undone.')
    )
      return;
    deleting.current = true;
    setWorking(true);
    setError('');
    try {
      await deleteStudySource(userId, row.sourceId);
      if (sourceId === row.sourceId) chooseMode('paste', true);
      reloadSaved();
      setSavedNotice('The private source and its versions were deleted.');
    } catch (cause: unknown) {
      console.error('Could not delete study source', cause);
      setError('Could not delete this source. Try again.');
    } finally {
      deleting.current = false;
      setWorking(false);
    }
  }
  async function save() {
    if (saving.current || deleting.current || working || !dirty) return;
    setError('');
    setSavedNotice('');
    if (!rightsChecked) {
      setError('Confirm that you may use this material for private study.');
      return;
    }
    if (extraction?.sparsePages.length && !sparseChecked) {
      setError('Check the sparse pages against the original or run OCR before saving.');
      return;
    }
    let checked: { title: string; text: string };
    try {
      checked = checkStudyText({ title, text });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Review the text before saving.');
      return;
    }
    saving.current = true;
    const revision = editRevision.current;
    setWorking(true);
    try {
      const result = await saveStudySourceVersion({
        title: checked.title,
        text: checked.text,
        format,
        mutationId: (submission.current ??= mutationId()),
        ...(sourceId ? { sourceId } : {}),
        ...(originLabel ? { originLabel } : {}),
        ...(extractionNotes ? { extractionNotes } : {}),
      });
      submission.current = null;
      setSourceId(result.sourceId);
      setVersionNo(result.versionNo);
      if (editRevision.current === revision) setDirty(false);
      setSavedNotice(
        result.replayed
          ? 'This version was already saved. Nothing was duplicated.'
          : 'Private version ' +
              result.versionNo +
              ' saved. Only the text you approved was stored.',
      );
      reloadSaved();
    } catch (cause: unknown) {
      console.error('Could not save study source', cause);
      setError(
        isOfflineFailure(cause)
          ? 'That may not have reached your account. Your text stays here; try Save again.'
          : cause instanceof Error
            ? cause.message
            : 'The source could not be saved just now.',
      );
    } finally {
      saving.current = false;
      setWorking(false);
    }
  }

  return (
    <section className="stack measure" aria-labelledby="study-import-heading">
      <p className="meta">Studio · Study material</p>
      <h1 id="study-import-heading">Bring a reading to study.</h1>
      <p className="lede">
        Extract the words, check them against your source, and keep a private version. A later step
        will turn the version you choose into lessons and practice.
      </p>
      <p className="studio__consent">
        Files are read in this browser. A URL preview fetches an allowlisted public page on our
        server; review its extracted text before saving. Saving stores only the text you approve in
        your private account. OCR runs here too, though it may download recognition data. No model
        processes this material until you separately request generation.
      </p>

      <div className="library__filters" role="group" aria-label="Material type">
        {(['paste', 'file', 'highlights', 'url', 'goal'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            className="btn btn--plain library__filter"
            aria-pressed={mode === choice}
            onClick={() => chooseMode(choice)}
          >
            {choice === 'paste'
              ? 'Paste text'
              : choice === 'file'
                ? 'Choose a file'
                : choice === 'highlights'
                  ? 'Imported highlights'
                  : choice === 'url'
                    ? 'Source URL'
                    : 'Start with a goal'}
          </button>
        ))}
      </div>

      {mode === 'url' && (
        <div className="stack">
          <label className="field__label" htmlFor="study-source-url">
            Public source URL
          </label>
          <input
            id="study-source-url"
            className="field__input"
            type="url"
            value={urlInput}
            disabled={working}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://en.wikisource.org/wiki/…"
          />
          <p className="meta">
            HTTPS pages on Wikisource, MIT Classics, and Project Gutenberg can be previewed. For
            another site, paste text or upload a file. The page may contain navigation or omit
            tables and footnotes.
          </p>
          <p>
            <button
              type="button"
              className="btn btn--plain"
              disabled={working}
              onClick={() => void previewUrl(urlInput)}
            >
              Preview page
            </button>
          </p>
        </div>
      )}

      {mode === 'goal' && (
        <div className="stack">
          <label className="field__label" htmlFor="study-goal">
            What do you want to study?
          </label>
          <input
            id="study-goal"
            className="field__input"
            value={goal}
            maxLength={160}
            disabled={working}
            onChange={(event) => {
              setGoal(event.target.value);
              setGoalSearched(false);
              setSuggestions([]);
            }}
            placeholder="e.g. natural selection"
          />
          <p className="meta">
            Search rights-cleared public readings already in the Archive. Your goal does not create
            a source or a course by itself.
          </p>
          <p>
            <button
              type="button"
              className="btn btn--plain"
              disabled={working || goal.trim().length < 2}
              onClick={() => void searchGoal()}
            >
              Find readings
            </button>
          </p>
          {suggestions.length > 0 && (
            <ul className="stack">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    className="btn btn--plain"
                    disabled={working}
                    onClick={() => void previewUrl(suggestion.url)}
                  >
                    {suggestion.title}
                  </button>
                  {suggestion.description && <p className="meta">{suggestion.description}</p>}
                  <p className="meta">
                    Catalogue status: public domain · {new URL(suggestion.url).hostname}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {goalSearched && suggestions.length === 0 && (
            <p className="meta" role="status">
              No inspectable public-domain source matched this goal. Paste your own notes or upload
              a document to study it privately.
            </p>
          )}
        </div>
      )}

      {mode === 'file' && (
        <>
          <label className="field__label" htmlFor="study-file">
            Local file
          </label>
          <input
            id="study-file"
            type="file"
            className="field__input"
            accept=".txt,.md,.markdown,.pdf,.docx,.png,.jpg,.jpeg,.webp"
            disabled={working}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (selected) void chooseFile(selected);
            }}
          />
          <p className="meta">
            TXT, Markdown, PDF, DOCX, or an image. Up to 12 MB; PDFs up to 30 pages. Only the
            extracted text can be saved.
          </p>
        </>
      )}

      {mode === 'highlights' && (
        <>
          <p className="meta">Choose a book you have already imported.</p>
          {bookError && (
            <p className="remember__error" role="alert">
              {bookError}{' '}
              <button
                type="button"
                className="btn btn--plain"
                onClick={() => {
                  setBookError('');
                  setBookReload((count) => count + 1);
                }}
              >
                Try again
              </button>
            </p>
          )}
          <div className="library__filters">
            {books.map((book) => (
              <button
                key={book.workId}
                type="button"
                className="btn btn--plain library__filter"
                onClick={() => void chooseBook(book)}
              >
                {book.title}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="field__label" htmlFor="study-source-title">
        Title
      </label>
      <input
        id="study-source-title"
        className="field__input"
        value={title}
        maxLength={MAX_STUDY_TITLE_CHARS}
        disabled={working}
        onChange={(event) => {
          edited();
          setTitle(event.target.value);
        }}
        placeholder="Name this reading"
      />

      <label className="field__label" htmlFor="study-source-text">
        Extracted text to save
      </label>
      <textarea
        id="study-source-text"
        className="field__textarea"
        rows={14}
        value={text}
        maxLength={MAX_STUDY_TEXT_CHARS + 1}
        disabled={working}
        onChange={(event) => {
          edited();
          setText(event.target.value);
          if (extraction && file) setManualTextEdited(true);
        }}
        aria-describedby="study-source-count"
      />
      <p className="meta" id="study-source-count">
        {text.length.toLocaleString()} of {MAX_STUDY_TEXT_CHARS.toLocaleString()} characters.
        Compare passages, tables, and page order with the original before saving.
      </p>

      {extractionNotes && <p className="meta">{extractionNotes}</p>}

      {extraction && extraction.sparsePages.length > 0 && (
        <div className="stack">
          <p className="remember__error" role="status">
            Pages needing a closer look: {extraction.sparsePages.join(', ')}. Text may be missing.
          </p>
          {file && extraction.sparsePages.length <= MAX_STUDY_OCR_PAGES && (
            <button
              type="button"
              className="btn btn--plain"
              aria-disabled={working}
              onClick={() => void runOcr()}
            >
              Recognize these pages in this browser
            </button>
          )}
          {extraction.sparsePages.length > MAX_STUDY_OCR_PAGES && (
            <p className="meta">OCR is limited to five pages at a time. Split this document.</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={sparseChecked}
              onChange={(event) => setSparseChecked(event.target.checked)}
            />{' '}
            I checked the sparse pages against the original and supplied or accepted their text.
          </label>
        </div>
      )}

      {sourceId && (
        <p className="meta">
          Revising version {versionNo}. Saving an edit adds a version; previous text remains
          unchanged.
        </p>
      )}
      {status && (
        <p className="meta" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="remember__error" role="alert">
          {error}
        </p>
      )}
      {savedNotice && (
        <p className="meta" role="status">
          {savedNotice}
        </p>
      )}

      <label>
        <input
          type="checkbox"
          checked={rightsChecked}
          onChange={(event) => setRightsChecked(event.target.checked)}
        />{' '}
        I have the right to use this material for my private study.
      </label>
      <p>
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={working || !dirty}
          onClick={() => void save()}
        >
          {working ? 'Working…' : sourceId ? 'Save a corrected version' : 'Save private source'}
        </button>
      </p>

      <hr className="rule" />
      <h2 style={{ fontSize: 'var(--step-1)' }}>Your private study sources</h2>
      {libraryError && (
        <p className="remember__error" role="alert">
          {libraryError}{' '}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => setLibraryReload((count) => count + 1)}
          >
            Try again
          </button>
        </p>
      )}
      {saved.length === 0 && !libraryError && <p className="meta">No source versions saved yet.</p>}
      {saved.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {saved.map((row) => (
            <li key={row.id} className="library__item">
              <button type="button" className="btn btn--plain" onClick={() => void openSaved(row)}>
                {row.title}
              </button>{' '}
              <button
                type="button"
                className="btn btn--plain"
                onClick={() => void removeSaved(row)}
                disabled={working}
              >
                Delete
              </button>{' '}
              <span className="meta">
                Version {row.versionNo} · {row.format}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta">Your imported material and its versions are visible only to you.</p>
    </section>
  );
}
