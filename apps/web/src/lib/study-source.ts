/** Limits shared by the preview and the database save function. */
export const MAX_STUDY_TEXT_CHARS = 200_000;
export const MAX_STUDY_TITLE_CHARS = 200;
export const MAX_STUDY_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_STUDY_PDF_PAGES = 30;
export const MAX_STUDY_OCR_PAGES = 5;

export type StudySourceFormat =
  'paste' | 'text' | 'markdown' | 'pdf' | 'docx' | 'image_ocr' | 'pdf_ocr' | 'highlights';

export type FileStudyFormat = 'text' | 'markdown' | 'pdf' | 'docx' | 'image_ocr';

export function fileStudyFormat(name: string): FileStudyFormat | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'txt') return 'text';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image_ocr';
  return null;
}

export function checkStudyFile(file: Pick<File, 'name' | 'size'>): FileStudyFormat {
  const format = fileStudyFormat(file.name);
  if (!format) throw new Error('Choose a TXT, Markdown, PDF, DOCX, PNG, JPEG, or WebP file.');
  if (file.size === 0) throw new Error('That file is empty.');
  if (file.size > MAX_STUDY_FILE_BYTES) {
    throw new Error('That file is over 12 MB. Split it into smaller readings.');
  }
  return format;
}

export function checkStudyText(input: { title: string; text: string }): {
  title: string;
  text: string;
} {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title || title.length > MAX_STUDY_TITLE_CHARS) {
    throw new Error('Give this source a title of 1 to 200 characters.');
  }
  if (!text || text.includes('\u0000')) {
    throw new Error('Review the extraction and provide readable text before saving.');
  }
  if (text.length > MAX_STUDY_TEXT_CHARS) {
    throw new Error('This source is over 200,000 characters. Split it into smaller readings.');
  }
  return { title, text };
}

export function checkPdfPageCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) throw new Error('This PDF has no readable pages.');
  if (count > MAX_STUDY_PDF_PAGES) {
    throw new Error('This PDF has over 30 pages. Split it into shorter readings.');
  }
}

export function formatPdfPage(number: number, text: string): string {
  return 'Page ' + number + '\n' + text.trim();
}

export function assemblePdfPages(pages: readonly string[]): string {
  return pages.map((text, index) => formatPdfPage(index + 1, text)).join('\n\n');
}

export function unreadablePdfPages(pages: readonly string[]): number[] {
  return pages.flatMap((text, index) => (text.trim().length < 30 ? [index + 1] : []));
}
