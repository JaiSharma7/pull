import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { verifyDocxExpansion } from './study-docx.js';

import {
  assemblePdfPages,
  checkDocxArchive,
  checkPdfPageCount,
  checkStudyFile,
  checkStudyImageDimensions,
  checkStudyText,
  fileStudyFormat,
  unreadablePdfPages,
} from './study-source.js';

function zipDirectoryWithInflatedSize(inflated: number): ArrayBuffer {
  const name = new TextEncoder().encode('word/document.xml');
  const centralSize = 46 + name.length;
  const bytes = new Uint8Array(centralSize + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint32(24, inflated, true);
  view.setUint16(28, name.length, true);
  bytes.set(name, 46);
  view.setUint32(centralSize, 0x06054b50, true);
  view.setUint16(centralSize + 8, 1, true);
  view.setUint16(centralSize + 10, 1, true);
  view.setUint32(centralSize + 12, centralSize, true);
  return bytes.buffer;
}
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

  it('checks decoded image dimensions before OCR, including a hidden WebP frame', () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngView = new DataView(png.buffer);
    pngView.setUint32(8, 13, false);
    pngView.setUint32(12, 0x49484452, false);
    pngView.setUint32(16, 3000, false);
    pngView.setUint32(20, 3000, false);
    expect(checkStudyImageDimensions(png.buffer)).toEqual({ width: 3000, height: 3000 });
    pngView.setUint32(16, 20_000, false);
    expect(() => checkStudyImageDimensions(png.buffer)).toThrow(/too large/);

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 100, 0, 100]);
    expect(checkStudyImageDimensions(jpeg.buffer)).toEqual({ width: 100, height: 100 });
    jpeg[7] = 0x27;
    jpeg[8] = 0x10;
    expect(() => checkStudyImageDimensions(jpeg.buffer)).toThrow(/too large/);

    const webp = new Uint8Array(48);
    const webpView = new DataView(webp.buffer);
    webpView.setUint32(0, 0x52494646, false);
    webpView.setUint32(4, 40, true);
    webpView.setUint32(8, 0x57454250, false);
    webpView.setUint32(12, 0x56503858, false); // VP8X canvas: 100 by 100.
    webpView.setUint32(16, 10, true);
    webp[24] = 99;
    webp[27] = 99;
    webpView.setUint32(30, 0x56503820, false); // VP8 frame: 10,000 by 100.
    webpView.setUint32(34, 10, true);
    webp.set([0x9d, 0x01, 0x2a], 41);
    webpView.setUint16(44, 10_000, true);
    webpView.setUint16(46, 100, true);
    expect(() => checkStudyImageDimensions(webp.buffer)).toThrow(/too large/);
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

  it('rejects a small DOCX container that claims a huge inflated document', () => {
    expect(() => checkDocxArchive(zipDirectoryWithInflatedSize(100))).not.toThrow();
    expect(() => checkDocxArchive(zipDirectoryWithInflatedSize(100 * 1024 * 1024))).toThrow(
      /expands beyond|too much XML/,
    );
    expect(() => checkDocxArchive(new ArrayBuffer(8))).toThrow(/ZIP directory/);
  });
  it('counts actual DOCX decompression even when ZIP metadata lies', async () => {
    const archive = new JSZip();
    archive.file('word/document.xml', 'A'.repeat(9 * 1024 * 1024), { createFolders: false });
    const bytes = await archive.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    const view = new DataView(bytes);
    const eocd = bytes.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    const central = view.getUint32(eocd + 16, true);
    expect(view.getUint32(central, true)).toBe(0x02014b50);
    view.setUint32(central + 24, 100, true);
    expect(() => checkDocxArchive(bytes)).not.toThrow();
    await expect(verifyDocxExpansion(bytes)).rejects.toThrow(/too much XML/);
  });

  it('labels pages and flags sparse extraction for OCR instead of claiming completeness', () => {
    expect(() => checkPdfPageCount(31)).toThrow(/over 30 pages/);
    expect(unreadablePdfPages(['This page has enough extracted text for study.', '  '])).toEqual([
      2,
    ]);
    expect(assemblePdfPages(['first', 'second'])).toBe('Page 1\nfirst\n\nPage 2\nsecond');
  });
});
