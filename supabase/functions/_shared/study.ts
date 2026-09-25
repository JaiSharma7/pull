/**
 * Study generation, the deterministic half.
 *
 * Everything here is a pure function of its inputs: how a reader's source versions
 * are cut into bounded windows, how a model's verbatim quote is found in the stored
 * text, which claims reach the course assembly, and how the assembled course is
 * checked and normalised into rows. No IO and no model -- the steps in
 * `study-steps.ts` call the provider and the database, and call these in between.
 *
 * Two units of offset appear, and they are kept apart by name:
 *
 *   UTF-16 index   what JavaScript slices with. Windows are planned and quotes are
 *                  searched in these, because that is what the string methods take.
 *   code point     what Postgres `char_length` and `substr` count. Every offset that
 *                  is PERSISTED is converted to this first, so `persist_study_course`
 *                  can check a span against the stored version with `substr`, and a
 *                  character outside the Basic Multilingual Plane cannot shift a span.
 */

import { PROMPTS, promptFor } from './prompts.ts';

export const STUDY_LIMITS = {
  maxSources: 5,
  maxTotalChars: 200_000,
  /** One extraction call reads at most this many code points of one version. */
  windowChars: 30_000,
  /**
   * A window may end early at a paragraph or sentence boundary, but never before this
   * share of `windowChars`. So every window but a version's last is at least 24,000
   * code points, and 200,000 characters over five versions is at most 13 windows.
   */
  minWindowShare: 0.8,
  maxWindows: 16,
  /** Claims the course assembly may see. Beyond this the prompt stops being small. */
  maxAssemblyClaims: 120,
  /**
   * The most UTF-8 bytes the claims digest may carry. The assembly's hold is priced from
   * the prompt's bytes, so an unbounded digest is an unbounded hold -- one that could
   * exceed a reader's whole daily share and wait for ever. At default prices this keeps
   * the assembly's ceiling near 30 cents; `study.test.ts` pins that it fits the share.
   */
  maxDigestBytes: 200_000,
  /** Evidence spans per claim, and characters per span, in the digest. */
  digestSpans: 2,
  digestSpanChars: 600,
  /** A quote shorter than this matches too easily to prove anything. */
  minQuoteChars: 8,
} as const;

export type StudyPromptName = 'ExtractStudyClaims' | 'AssembleStudyCourse';

export interface StudySourceText {
  versionId: string;
  /** 1-based, the order the reader chose. */
  position: number;
  title: string;
  format: string;
  text: string;
}

export interface StudyWindow {
  versionId: string;
  position: number;
  /** UTF-16 indices into the version's text, end exclusive. */
  start: number;
  end: number;
}

// ------------------------------------------------------------------------ hashing

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PromptVersion {
  promptName: StudyPromptName;
  /** SHA-256 of the exported message templates. */
  promptHash: string;
  /** SHA-256 of the exported output schema. */
  schemaHash: string;
}

/**
 * The identity of a prompt and its schema, as exported from BAML.
 *
 * Hashing the exported artefact rather than a version string means an edit to the
 * `.baml` source changes the hash with no one having to remember to bump anything --
 * and therefore invalidates every cache entry made under the old prompt.
 */
export async function promptVersion(name: StudyPromptName): Promise<PromptVersion> {
  const exported = PROMPTS[name];
  return {
    promptName: name,
    promptHash: await sha256Hex(JSON.stringify(exported.messages)),
    schemaHash: await sha256Hex(JSON.stringify(exported.schema)),
  };
}

/**
 * The cache key for one stage.
 *
 * The owner is part of the key material as well as the table's unique key, so a key
 * computed for one reader cannot name another reader's entry even if it leaked.
 */
export function stageCacheKey(parts: {
  stage: 'extract' | 'assemble';
  ownerId: string;
  version: PromptVersion;
  providerSignature: string;
  input: unknown;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      parts.stage,
      parts.ownerId,
      parts.version.promptHash,
      parts.version.schemaHash,
      parts.providerSignature,
      parts.input,
    ]),
  );
}

// ------------------------------------------------------------------------ windows

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Never cut between the two halves of a surrogate pair. */
function safeCut(text: string, at: number): number {
  if (at > 0 && at < text.length && isHighSurrogate(text.charCodeAt(at - 1))) return at - 1;
  return at;
}

/** The UTF-16 index `points` code points after `from`, or the end of the text. */
function advanceCodePoints(text: string, from: number, points: number): number {
  let i = from;
  for (let n = 0; n < points && i < text.length; n++) {
    i += isHighSurrogate(text.charCodeAt(i)) && i + 1 < text.length ? 2 : 1;
  }
  return i;
}

/**
 * Where to end a window that starts at `start`: the last paragraph break, else the
 * last sentence end, inside the final fifth of the allowance -- else a hard cut.
 *
 * Measured in CODE POINTS, the unit the 200,000-character limit counts. Measured in
 * UTF-16 units, a source written mostly outside the Basic Multilingual Plane is twice
 * as long, and five of them planned past `maxWindows` and failed at `study_prepare`.
 */
function windowEnd(text: string, start: number): number {
  const limit = advanceCodePoints(text, start, STUDY_LIMITS.windowChars);
  if (limit >= text.length) return text.length;
  const floor = advanceCodePoints(
    text,
    start,
    Math.floor(STUDY_LIMITS.windowChars * STUDY_LIMITS.minWindowShare),
  );
  const region = text.slice(floor, limit);
  const paragraph = region.lastIndexOf('\n\n');
  if (paragraph >= 0) return floor + paragraph + 2;
  const sentence = Math.max(region.lastIndexOf('. '), region.lastIndexOf('.\n'));
  if (sentence >= 0) return floor + sentence + 2;
  return safeCut(text, limit);
}

export function planWindows(sources: readonly StudySourceText[]): StudyWindow[] {
  const windows: StudyWindow[] = [];
  for (const source of [...sources].sort((a, b) => a.position - b.position)) {
    let start = 0;
    while (start < source.text.length) {
      const end = windowEnd(source.text, start);
      if (source.text.slice(start, end).trim().length > 0) {
        windows.push({ versionId: source.versionId, position: source.position, start, end });
      }
      start = end;
    }
  }
  if (windows.length > STUDY_LIMITS.maxWindows) {
    throw new Error(
      `study_prepare: ${windows.length} windows exceeds ${STUDY_LIMITS.maxWindows}; ` +
        'the source limits should make this unreachable',
    );
  }
  return windows;
}

// -------------------------------------------------------------- offsets and pages

/**
 * Convert UTF-16 indices to code-point offsets, for text that may contain surrogates.
 *
 * Built once per version and reused for every span in it: a 200,000-character text
 * with a few hundred spans would otherwise rescan the prefix each time.
 */
export function codePointIndexer(text: string): (utf16Index: number) => number {
  if (!/[\uD800-\uDFFF]/.test(text)) return (i) => i;
  const prefix = new Uint32Array(text.length + 1);
  let points = 0;
  for (let i = 0; i < text.length; i++) {
    prefix[i] = points;
    const code = text.charCodeAt(i);
    // The low half of a pair is not a new code point.
    if (!(code >= 0xdc00 && code <= 0xdfff && i > 0 && isHighSurrogate(text.charCodeAt(i - 1)))) {
      points += 1;
    }
  }
  prefix[text.length] = points;
  return (i) => prefix[Math.max(0, Math.min(i, text.length))] as number;
}

/**
 * The PDF page a span starts on, from the "Page N" line the importer writes at the
 * top of each page (`formatPdfPage` in apps/web). Only for PDF formats: in pasted text
 * a line reading "Page 3" is just a line.
 */
export function pageIndexer(format: string, text: string): (utf16Index: number) => number | null {
  if (format !== 'pdf' && format !== 'pdf_ocr') return () => null;
  // Only the importer's own markers: each at the top of a page block (the start of the
  // text, or after the blank line `assemblePdfPages` joins pages with), numbered 1, 2,
  // 3 in order. A body line that happens to read "Page 7" breaks the sequence and is
  // not a page, and there is no page 0 for `study_claim_evidence.page` to refuse.
  const marks: { at: number; page: number }[] = [];
  for (const m of text.matchAll(/(^|\n\n)Page (\d{1,4})\n/g)) {
    const page = Number(m[2]);
    if (page !== (marks.at(-1)?.page ?? 0) + 1) continue;
    marks.push({ at: (m.index ?? 0) + (m[1] ?? '').length, page });
  }
  return (i) => {
    let page: number | null = null;
    for (const mark of marks) {
      if (mark.at > i) break;
      page = mark.page;
    }
    return page;
  };
}

// ------------------------------------------------------------------ quote finding

export type EvidenceMatch = 'exact' | 'normalized' | 'unresolved';

/**
 * Fold the differences a faithful copy can still pick up: runs of whitespace, curly
 * versus straight quotes, dash variants, and case. Returns the folded text and, for
 * each folded character, the UTF-16 index it came from, so a match in the folded text
 * maps back to an exact span of the original.
 */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i] as string;
    if (/\s/.test(ch)) {
      if (inSpace) continue;
      inSpace = true;
      ch = ' ';
    } else {
      inSpace = false;
      if (ch === '‘' || ch === '’' || ch === '‛' || ch === '′') ch = "'";
      else if (ch === '“' || ch === '”' || ch === '‟' || ch === '″') ch = '"';
      else if (ch === '–' || ch === '—' || ch === '−') ch = '-';
      else if (ch === ' ') ch = ' ';
      ch = ch.toLowerCase();
    }
    // One origin entry per folded UTF-16 unit, not per source character: lowercasing
    // can lengthen a string ('\u0130' becomes two units), and an origin array one short
    // shifts every span after it onto the wrong text.
    for (let unit = 0; unit < ch.length; unit++) {
      folded += ch[unit];
      origin.push(i);
    }
  }
  return { folded, origin };
}

/** Strip what a model wraps a quote in: whitespace, quotation marks, trailing ellipses. */
export function cleanQuote(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“‘]+/, '')
    .replace(/["'”’]+$/, '')
    .replace(/(\.\.\.|…)$/, '')
    .replace(/^(\.\.\.|…)/, '')
    .trim();
}

export interface ResolvedSpan {
  /** UTF-16 indices into the version text. */
  start: number;
  end: number;
  match: Exclude<EvidenceMatch, 'unresolved'>;
}

/**
 * Find a quote in the text: exactly first, then folded. The window it was extracted
 * from is searched before the rest of the version, so a phrase that recurs resolves to
 * the passage the model actually read.
 */
export interface FoldedText {
  folded: string;
  /** For each folded character, the UTF-16 index of the character it came from. */
  origin: number[];
}

export function foldText(text: string): FoldedText {
  return fold(text);
}

/** The first folded index whose origin is at or after `utf16`. `origin` is increasing. */
function foldedIndexAt(origin: readonly number[], utf16: number): number {
  let lo = 0;
  let hi = origin.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((origin[mid] as number) < utf16) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Find a quote in the text: exactly first, then folded. The window it was extracted
 * from is searched before the rest of the version, so a phrase that recurs resolves to
 * the passage the model actually read.
 *
 * `folded` is the version folded ONCE, supplied lazily by the caller. Folding is
 * linear in the text, and a step resolving a few hundred quotes over a 200,000-character
 * version would otherwise fold it a few hundred times -- against an Edge Function's two
 * seconds of CPU. The window is searched as a range of the one folded text rather than
 * folded again.
 */
export function resolveQuote(
  text: string,
  rawQuote: string,
  window?: { start: number; end: number },
  folded?: () => FoldedText,
): ResolvedSpan | null {
  const quote = cleanQuote(rawQuote);
  if (quote.length < STUDY_LIMITS.minQuoteChars) return null;

  if (window) {
    const at = text.indexOf(quote, window.start);
    if (at >= 0 && at + quote.length <= window.end) {
      return { start: at, end: at + quote.length, match: 'exact' };
    }
  }
  const anywhere = text.indexOf(quote);
  if (anywhere >= 0) return { start: anywhere, end: anywhere + quote.length, match: 'exact' };

  const q = fold(quote).folded.trim();
  if (q.length < STUDY_LIMITS.minQuoteChars) return null;
  const f = folded ? folded() : fold(text);

  let at = -1;
  if (window) {
    const from = foldedIndexAt(f.origin, window.start);
    const to = foldedIndexAt(f.origin, window.end);
    const inWindow = f.folded.indexOf(q, from);
    if (inWindow >= 0 && inWindow + q.length <= to) at = inWindow;
  }
  if (at < 0) at = f.folded.indexOf(q);
  if (at < 0) return null;

  const first = f.origin[at] as number;
  const last = f.origin[at + q.length - 1] as number;
  let end = last + 1;
  // Include the low half when the last folded character began a surrogate pair.
  if (isHighSurrogate(text.charCodeAt(end - 1))) end += 1;
  return { start: first, end, match: 'normalized' };
}

// ----------------------------------------------------------------- claim index

export const CLAIM_KINDS = [
  'finding',
  'definition',
  'argument',
  'method',
  'example',
  'caveat',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** One extraction as stored in the stage cache, with where it came from. */
export interface ExtractionRecord {
  cacheId: string;
  window: StudyWindow;
  output: unknown;
  provenance: StageProvenance;
}

export interface StageProvenance {
  promptHash: string;
  schemaHash: string;
  model: string;
  providerCallId: string | null;
}

export interface EvidenceRow {
  modelQuote: string;
  spanText: string | null;
  /** Code points, end exclusive; null when unresolved. */
  start: number | null;
  end: number | null;
  page: number | null;
  match: EvidenceMatch;
}

export interface ClaimRow {
  key: string;
  sourceVersionId: string;
  position: number;
  sourceTitle: string;
  kind: ClaimKind;
  statement: string;
  qualifications: string[];
  attribution: string | null;
  evidence: EvidenceRow[];
  status: 'draft' | 'rejected';
  rejectionReasons: string[];
  provenance: StageProvenance;
}

const LIMITS = {
  statement: 1000,
  qualification: 300,
  attribution: 300,
  modelQuote: 1000,
  spanText: 2000,
} as const;

/**
 * Cut to at most `max` UTF-16 units without splitting a surrogate pair. A lone high
 * surrogate is invalid in jsonb, and one at the end of a truncated field made Postgres
 * refuse the whole course -- permanently, since the model output it came from is cached.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown, max: number, eachMax: number): { kept: string[]; long: boolean } {
  if (!Array.isArray(value)) return { kept: [], long: false };
  let long = false;
  const kept: string[] = [];
  for (const v of value) {
    const s = str(v);
    if (!s) continue;
    if (s.length > eachMax) long = true;
    kept.push(truncate(s, eachMax));
    if (kept.length >= max) break;
  }
  return { kept, long };
}

/**
 * Every claim from every extraction, keyed `s{position}c{n}` in document order, with
 * each evidence quote resolved against the stored version.
 *
 * A claim with no quote that resolves is REJECTED with `evidence_missing`. It is kept
 * rather than dropped so the audit can see what the model asserted without support,
 * and it never reaches the course assembly.
 */
export function buildClaimIndex(
  sources: readonly StudySourceText[],
  extractions: readonly ExtractionRecord[],
): ClaimRow[] {
  const byVersion = new Map(sources.map((s) => [s.versionId, s]));
  const counters = new Map<number, number>();
  const toPoints = new Map<string, (i: number) => number>();
  const toPage = new Map<string, (i: number) => number | null>();
  const folds = new Map<string, FoldedText>();
  const claims: ClaimRow[] = [];

  const ordered = [...extractions].sort(
    (a, b) => a.window.position - b.window.position || a.window.start - b.window.start,
  );

  for (const extraction of ordered) {
    const source = byVersion.get(extraction.window.versionId);
    if (!source)
      throw new Error(
        `claim index: extraction names unknown version ${extraction.window.versionId}`,
      );
    if (!toPoints.has(source.versionId)) {
      toPoints.set(source.versionId, codePointIndexer(source.text));
      toPage.set(source.versionId, pageIndexer(source.format, source.text));
    }
    const points = toPoints.get(source.versionId) as (i: number) => number;
    const pageAt = toPage.get(source.versionId) as (i: number) => number | null;
    const folded = () => {
      let f = folds.get(source.versionId);
      if (!f) {
        f = fold(source.text);
        folds.set(source.versionId, f);
      }
      return f;
    };

    const raw = (extraction.output as { claims?: unknown } | null)?.claims;
    if (!Array.isArray(raw)) continue;

    for (const entry of raw) {
      const claim = (entry ?? {}) as Record<string, unknown>;
      const reasons: string[] = [];
      const statement = str(claim.statement);
      if (!statement) continue;
      if (statement.length > LIMITS.statement) reasons.push('too_long');

      const n = (counters.get(source.position) ?? 0) + 1;
      counters.set(source.position, n);
      if (n > 9999) break;

      const kind = (CLAIM_KINDS as readonly string[]).includes(str(claim.kind))
        ? (str(claim.kind) as ClaimKind)
        : 'finding';
      const qualifications = strings(claim.qualifications, 6, LIMITS.qualification);
      if (qualifications.long) reasons.push('too_long');
      const attributionRaw = str(claim.attribution);
      if (attributionRaw.length > LIMITS.attribution) reasons.push('too_long');

      const quotes = strings(claim.evidence, 3, 5000).kept;
      const evidence: EvidenceRow[] = quotes.map((quote) => {
        const span = resolveQuote(source.text, quote, extraction.window, folded);
        const modelQuote = truncate(quote, LIMITS.modelQuote);
        if (!span || span.end - span.start > LIMITS.spanText) {
          return {
            modelQuote,
            spanText: null,
            start: null,
            end: null,
            page: null,
            match: 'unresolved',
          };
        }
        return {
          modelQuote,
          spanText: source.text.slice(span.start, span.end),
          start: points(span.start),
          end: points(span.end),
          page: pageAt(span.start),
          match: span.match,
        };
      });
      if (!evidence.some((e) => e.match !== 'unresolved')) reasons.push('evidence_missing');

      claims.push({
        key: `s${source.position}c${n}`,
        sourceVersionId: source.versionId,
        position: source.position,
        sourceTitle: source.title,
        kind,
        statement: truncate(statement, LIMITS.statement),
        qualifications: qualifications.kept,
        attribution: attributionRaw ? truncate(attributionRaw, LIMITS.attribution) : null,
        evidence,
        status: reasons.length > 0 ? 'rejected' : 'draft',
        rejectionReasons: [...new Set(reasons)],
        provenance: extraction.provenance,
      });
    }
  }
  return claims;
}

/**
 * The claims the assembly may build on: grounded ones only, spread across the
 * material when there are more than the prompt should carry.
 *
 * An even spread in document order rather than the first N, so a long reading's
 * later chapters are not silently left out of its course. Deterministic, because
 * `study_ground` recomputes it to know which keys the model was actually shown.
 */
export function selectAssemblyClaims(claims: readonly ClaimRow[]): ClaimRow[] {
  const grounded = claims.filter((c) => c.status === 'draft');
  const spread = (cap: number): ClaimRow[] => {
    if (grounded.length <= cap) return grounded;
    const picked: ClaimRow[] = [];
    for (let i = 0; i < cap; i++) {
      picked.push(grounded[Math.floor((i * grounded.length) / cap)] as ClaimRow);
    }
    return picked;
  };
  // Then within the digest's byte budget, thinning the same even spread until it fits.
  let cap = Math.min(STUDY_LIMITS.maxAssemblyClaims, grounded.length);
  let picked = spread(cap);
  while (cap > 1 && utf8Bytes(claimsDigest(picked)) > STUDY_LIMITS.maxDigestBytes) {
    cap = Math.max(1, Math.floor(cap * 0.85));
    picked = spread(cap);
  }
  return picked;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * One line per claim, and it stays one line: every field is the reader's text or the
 * model's reading of it, and a newline inside one would let a document write a line that
 * looks like a claim of its own -- `[s1c2] (Source 1: ...) ... Evidence: "..."` -- which a
 * question could then cite by a real key.
 */
function oneLine(text: string): string {
  // `\s` misses NEL (U+0085), and a bracket inside a field could open a key of its own
  // on the same line; both are neutralised.
  return text
    .replace(/[\s\u0085]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .trim();
}

/** The text the assembly reads: one line per claim, keyed, attributed, with evidence. */
export function claimsDigest(claims: readonly ClaimRow[]): string {
  return claims
    .map((c) => {
      const parts = [
        `[${c.key}] (Source ${c.position}: ${oneLine(c.sourceTitle)}) ${oneLine(c.statement)}`,
      ];
      if (c.qualifications.length > 0)
        parts.push(`Qualifications: ${c.qualifications.map(oneLine).join('; ')}.`);
      if (c.attribution) parts.push(`Attributed to: ${oneLine(c.attribution)}.`);
      const quotes = c.evidence
        .filter((e) => e.spanText)
        .slice(0, STUDY_LIMITS.digestSpans)
        .map((e) => `"${truncate(oneLine(e.spanText as string), STUDY_LIMITS.digestSpanChars)}"`);
      parts.push(`Evidence: ${quotes.join(' | ')}`);
      return parts.join(' ');
    })
    .join('\n');
}

// ------------------------------------------------------------- prompts rendered

export function extractionArgs(source: StudySourceText, window: StudyWindow) {
  return { sourceTitle: source.title, passage: source.text.slice(window.start, window.end) };
}

export function assemblyArgs(goal: string, claims: readonly ClaimRow[]) {
  return { goal, claims: claimsDigest(claims) };
}

export function renderStudyPrompt(name: StudyPromptName, args: Record<string, string>): string {
  return promptFor(name, args);
}

// ---------------------------------------------------------------- the course

export const QUESTION_KINDS = [
  'multiple_choice',
  'cloze',
  'ordering',
  'matching',
  'short_recall',
  'comparison',
  'application',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_PURPOSES = ['placement', 'practice', 'review'] as const;
export type QuestionPurpose = (typeof QUESTION_PURPOSES)[number];

const CHOICE_KINDS = new Set<QuestionKind>(['multiple_choice', 'comparison', 'application']);

export interface LessonRow {
  key: string;
  position: number;
  unitNo: number;
  unitTitle: string;
  title: string;
  objective: string;
  explanation: string;
  example: string | null;
  recap: string;
  minutes: number;
  claimKeys: string[];
  status: 'draft' | 'rejected';
  rejectionReasons: string[];
}

export interface ItemRow {
  key: string;
  lessonKey: string | null;
  purpose: QuestionPurpose;
  kind: QuestionKind;
  prompt: string;
  answer: string;
  acceptedAnswers: string[];
  distractors: { text: string; why: string }[];
  cloze: string | null;
  sequence: string[];
  pairs: { left: string; right: string }[];
  explanation: string;
  difficulty: number;
  claimKeys: string[];
  status: 'draft' | 'rejected';
  rejectionReasons: string[];
}

export interface CourseHeader {
  title: string | null;
  overview: string | null;
  objectives: string[];
  recap: string | null;
  disagreements: { claimKeys: string[]; description: string }[];
  withheld: { prompt: string; reason: string }[];
}

export interface NormalizedCourse {
  course: CourseHeader;
  lessons: LessonRow[];
  items: ItemRow[];
  /** Entries the model returned that could not be stored at all (no text to keep). */
  dropped: { lessons: number; items: number };
}

/** Compare answers the way a reader would see them: case, spacing and punctuation folded. */
export function answerKey(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // ASCII and curly quotes and punctuation, and the CJK full stops, commas, brackets
      // and marks NFKC leaves in place.
      .replace(/[‘’“”"'`.,;:!?()[\]{}。、「」『』【】〈〉《》・]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Scripts where a word does not end at a space: written without spaces (Han, kana, Thai
 * and its neighbours) or with particles attached to the word (Hangul).
 */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A character that continues a spaced-script word: a letter or digit outside those scripts. */
function continuesWord(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch) && !UNSPACED_SCRIPT.test(ch);
}

/** A phrase short enough to be a give-away: a few words, or a couple of characters of CJK. */
export function isShortAnswer(answer: string): boolean {
  const key = answerKey(answer);
  if (UNSPACED_SCRIPT.test(key)) return [...key].length >= 2 && [...key].length <= 20;
  return key.length >= 4 && key.split(' ').length <= 6;
}

/**
 * Whether `phrase` occurs in `text` as a whole word or words, after `answerKey`
 * folding. A match's edges must not continue a spaced-script word -- so "rest" is not
 * found in "interesting", and "mRNA" is found in "mRNA的作用" -- and a phrase in a
 * script without word spaces is matched as a plain substring, where a whole-word test
 * could never match at all.
 */
function containsPhrase(text: string, phrase: string): boolean {
  const p = answerKey(phrase);
  const t = answerKey(text);
  if (p.length === 0) return false;
  if (UNSPACED_SCRIPT.test(p)) return t.includes(p);
  for (let at = t.indexOf(p); at >= 0; at = t.indexOf(p, at + 1)) {
    if (!continuesWord(t[at - 1]) && !continuesWord(t[at + p.length])) return true;
  }
  return false;
}

function bounded(value: unknown, max: number, reasons: string[]): string {
  const s = str(value);
  if (s.length > max) {
    reasons.push('too_long');
    return truncate(s, max);
  }
  return s;
}

function intIn(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Check and normalise an assembled course into rows.
 *
 * Structural rules only -- the ones a machine can decide without judging meaning:
 * every lesson and question must cite a claim the model was shown; a choice question
 * needs two to four distinct wrong options, none equal to an accepted answer; a cloze
 * has exactly one blank and does not print its answer; an ordering has three to six
 * distinct steps; a matching has two to six pairs with no side repeated; no question
 * prints its own answer in its prompt. A question that breaks one is kept as
 * `rejected` with its reasons, for the audit. Groundedness and ambiguity are human
 * judgements (docs/eval/study-quality.md), and passing here is not a claim of either.
 *
 * Keys are reassigned in order -- `l1..`, `q1..` -- so whatever the model called them,
 * what is stored is a stable, well-formed key; the model's own keys are only used to
 * resolve references between its lessons and questions.
 */
export function normalizeStudyCourse(raw: unknown, shown: readonly ClaimRow[]): NormalizedCourse {
  const course = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(shown.map((c) => c.key));
  const cite = (value: unknown, max: number) =>
    [...new Set(strings(value, 32, 32).kept.filter((k) => known.has(k)))].slice(0, max);

  const lessons: LessonRow[] = [];
  const lessonKeyMap = new Map<string, string>();
  let droppedLessons = 0;
  const units = Array.isArray(course.units) ? course.units.slice(0, 6) : [];
  units.forEach((unitRaw, unitIndex) => {
    const unit = (unitRaw ?? {}) as Record<string, unknown>;
    const unitTitle = truncate(str(unit.title), 200) || `Unit ${unitIndex + 1}`;
    const unitLessons = Array.isArray(unit.lessons) ? unit.lessons.slice(0, 4) : [];
    for (const lessonRaw of unitLessons) {
      const lesson = (lessonRaw ?? {}) as Record<string, unknown>;
      const reasons: string[] = [];
      const title = bounded(lesson.title, 200, reasons);
      const objective = bounded(lesson.objective, 500, reasons);
      const explanation = bounded(lesson.explanation, 6000, reasons);
      const recap = bounded(lesson.recap, 1000, reasons);
      if (!title || !objective || !explanation || !recap || lessons.length >= 24) {
        droppedLessons += 1;
        continue;
      }
      const example = bounded(lesson.example, 2000, reasons) || null;
      const claimKeys = cite(lesson.claimKeys, 8);
      if (claimKeys.length === 0) reasons.push('no_known_claims');
      const key = `l${lessons.length + 1}`;
      const modelKey = str(lesson.key);
      if (modelKey && !lessonKeyMap.has(modelKey)) lessonKeyMap.set(modelKey, key);
      lessons.push({
        key,
        position: lessons.length + 1,
        unitNo: unitIndex + 1,
        unitTitle,
        title,
        objective,
        explanation,
        example,
        recap,
        minutes: intIn(lesson.minutes, 1, 5, 3),
        claimKeys,
        status: reasons.length > 0 ? 'rejected' : 'draft',
        rejectionReasons: [...new Set(reasons)],
      });
    }
  });

  const items: ItemRow[] = [];
  let droppedItems = 0;
  const questions = Array.isArray(course.questions) ? course.questions.slice(0, 48) : [];
  for (const questionRaw of questions) {
    const q = (questionRaw ?? {}) as Record<string, unknown>;
    const reasons: string[] = [];
    const kind = (QUESTION_KINDS as readonly string[]).includes(str(q.kind))
      ? (str(q.kind) as QuestionKind)
      : null;
    const purpose = (QUESTION_PURPOSES as readonly string[]).includes(str(q.purpose))
      ? (str(q.purpose) as QuestionPurpose)
      : 'practice';
    const prompt = bounded(q.prompt, 1000, reasons);
    const answer = bounded(q.answer, 1000, reasons);
    const explanation = bounded(q.explanation, 2000, reasons);
    if (!kind || !prompt || !answer || !explanation) {
      droppedItems += 1;
      continue;
    }

    const claimKeys = cite(q.claimKeys, 6);
    if (claimKeys.length === 0) reasons.push('no_known_claims');
    const lessonKey = lessonKeyMap.get(str(q.lessonKey)) ?? null;

    const accepted = strings(q.acceptedAnswers, 6, 1000);
    if (accepted.long) reasons.push('too_long');
    let acceptedAnswers: string[] = [];
    let distractors: { text: string; why: string }[] = [];
    let cloze: string | null = null;
    let sequence: string[] = [];
    let pairs: { left: string; right: string }[] = [];

    if (CHOICE_KINDS.has(kind)) {
      const rawDistractors = Array.isArray(q.distractors) ? q.distractors : [];
      // Over the limit is a malformed question, not one to trim quietly into a draft.
      if (rawDistractors.length > 4) reasons.push('too_many_distractors');
      distractors = rawDistractors
        .slice(0, 4)
        .map((d) => {
          const entry = (d ?? {}) as Record<string, unknown>;
          return {
            text: bounded(entry.distractor, 1000, reasons),
            why: bounded(entry.why, 1000, reasons),
          };
        })
        .filter((d) => d.text);
      const correct = new Set([answerKey(answer)]);
      const seen = new Set<string>();
      if (distractors.length < 2) reasons.push('too_few_distractors');
      for (const d of distractors) {
        const k = answerKey(d.text);
        if (correct.has(k)) reasons.push('distractor_matches_answer');
        if (seen.has(k)) reasons.push('duplicate_options');
        seen.add(k);
        if (!d.why) reasons.push('distractor_without_rationale');
      }
    } else if (kind === 'cloze') {
      cloze = bounded(q.cloze, 1000, reasons) || null;
      acceptedAnswers = accepted.kept;
      const blanks = cloze ? cloze.split('____').length - 1 : 0;
      if (blanks !== 1) reasons.push('cloze_malformed');
      else if (isShortAnswer(answer) && containsPhrase(cloze as string, answer)) {
        reasons.push('answer_in_prompt');
      }
    } else if (kind === 'ordering') {
      const steps = strings(q.sequence, 7, 500);
      sequence = steps.kept.slice(0, 6);
      if (steps.long) reasons.push('too_long');
      const distinct = new Set(sequence.map(answerKey));
      if (steps.kept.length > 6 || sequence.length < 3 || distinct.size !== sequence.length)
        reasons.push('ordering_malformed');
    } else if (kind === 'matching') {
      const rawPairs = Array.isArray(q.pairs) ? q.pairs : [];
      if (rawPairs.length > 6) reasons.push('matching_malformed');
      pairs = rawPairs
        .slice(0, 6)
        .map((p) => {
          const entry = (p ?? {}) as Record<string, unknown>;
          return {
            left: bounded(entry.left, 300, reasons),
            right: bounded(entry.right, 300, reasons),
          };
        })
        .filter((p) => p.left && p.right);
      const lefts = new Set(pairs.map((p) => answerKey(p.left)));
      const rights = new Set(pairs.map((p) => answerKey(p.right)));
      if (pairs.length < 2 || lefts.size !== pairs.length || rights.size !== pairs.length) {
        reasons.push('matching_malformed');
      }
    } else {
      acceptedAnswers = accepted.kept;
    }

    // Typed answers only, and only a short phrase, matched as whole words. A choice
    // question may name its options in the prompt ("retrieval or restudying?") without
    // giving anything away, and a long model answer for short recall shares words with
    // its own prompt; a substring test also found "rest" inside "interesting".
    if (
      (kind === 'cloze' || kind === 'short_recall') &&
      isShortAnswer(answer) &&
      containsPhrase(prompt, answer)
    ) {
      reasons.push('answer_in_prompt');
    }

    items.push({
      key: `q${items.length + 1}`,
      lessonKey,
      purpose,
      kind,
      prompt,
      answer,
      acceptedAnswers,
      distractors,
      cloze,
      sequence,
      pairs,
      explanation,
      difficulty: intIn(q.difficulty, 1, 3, 2),
      claimKeys,
      status: reasons.length > 0 ? 'rejected' : 'draft',
      rejectionReasons: [...new Set(reasons)],
    });
  }

  const disagreements = (
    Array.isArray(course.disagreements) ? course.disagreements.slice(0, 10) : []
  )
    .map((d) => {
      const entry = (d ?? {}) as Record<string, unknown>;
      return {
        claimKeys: cite(entry.claimKeys, 6),
        description: truncate(str(entry.description), 1000),
      };
    })
    .filter((d) => d.claimKeys.length >= 2 && d.description);
  const withheld = (Array.isArray(course.withheld) ? course.withheld.slice(0, 10) : [])
    .map((w) => {
      const entry = (w ?? {}) as Record<string, unknown>;
      return {
        prompt: truncate(str(entry.prompt), 1000),
        reason: truncate(str(entry.reason), 1000),
      };
    })
    .filter((w) => w.prompt);

  return {
    course: {
      title: truncate(str(course.title), 200) || null,
      overview: truncate(str(course.overview), 2000) || null,
      objectives: strings(course.objectives, 6, 500).kept,
      recap: truncate(str(course.recap), 2000) || null,
      disagreements,
      withheld,
    },
    lessons,
    items,
    dropped: { lessons: droppedLessons, items: droppedItems },
  };
}

/** Shape checks on what a provider returned, before it is cached. */
export function looksLikeClaimMap(value: unknown): boolean {
  return (
    !!value && typeof value === 'object' && Array.isArray((value as { claims?: unknown }).claims)
  );
}

export function looksLikeCourse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as { units?: unknown; questions?: unknown };
  return Array.isArray(v.units) && Array.isArray(v.questions);
}
