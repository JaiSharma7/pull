import { describe, expect, it } from 'vitest';

import {
  assemblePdfPages,
  checkPdfPageCount,
  checkStudyFile,
  checkStudyText,
  fileStudyFormat,
  unreadablePdfPages,
} from './study-source.js';

describe('private study source intake', () => {
  it('accepts supported local formats and rejects empty or oversized files', () => {
    expect(fileStudyFormat('reading.MD')).toBe('markdown');
    expect(fileStudyFormat('page.jpeg')).toBe('image_ocr');
    expect(fileStudyFormat('chapter.docx')).toBe('docx');
    expect(fileStudyFormat('webpage.html')).toBeNull();
    expect(() => checkStudyFile({ name: 'reading.pdf', size: 0 })).toThrow(/empty/);
    expect(() => checkStudyFile({ name: 'reading.pdf', size: 12 * 1024 * 1024 + 1 })).toThrow(
      /over 12 MB/,
    );
  });

  it('refuses binary-looking, blank, and overlong extraction text before a save', () => {
    expect(() => checkStudyText({ title: 'A', text: '\u0000binary' })).toThrow(/readable text/);
    expect(() => checkStudyText({ title: 'A', text: ' ' })).toThrow(/readable text/);
    expect(() => checkStudyText({ title: 'A', text: 'x'.repeat(200_001) })).toThrow(/200,000/);
    expect(checkStudyText({ title: ' Reading ', text: ' Notes ' })).toEqual({
      title: 'Reading',
      text: 'Notes',
    });
  });

  it('labels pages and flags sparse extraction for OCR instead of claiming completeness', () => {
    expect(() => checkPdfPageCount(31)).toThrow(/over 30 pages/);
    expect(unreadablePdfPages(['This page has enough extracted text for study.', '  '])).toEqual([
      2,
    ]);
    expect(assemblePdfPages(['first', 'second'])).toBe('Page 1\nfirst\n\nPage 2\nsecond');
  });
});
