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

export const MAX_STUDY_IMAGE_PIXELS = 16_000_000;
export const MAX_STUDY_IMAGE_SIDE = 8_192;

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byte = (at: number) => view.getUint8(at);
  if (
    bytes.length >= 33 &&
    byte(0) === 0x89 &&
    byte(1) === 0x50 &&
    byte(2) === 0x4e &&
    byte(3) === 0x47 &&
    byte(4) === 0x0d &&
    byte(5) === 0x0a &&
    byte(6) === 0x1a &&
    byte(7) === 0x0a &&
    view.getUint32(8, false) === 13 &&
    view.getUint32(12, false) === 0x49484452
  ) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }

  if (bytes.length >= 4 && byte(0) === 0xff && byte(1) === 0xd8) {
    let at = 2;
    while (at + 4 < bytes.length) {
      if (byte(at++) !== 0xff) return null;
      while (at < bytes.length && byte(at) === 0xff) at += 1;
      if (at >= bytes.length) return null;
      const marker = byte(at++);
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (at + 2 > bytes.length) return null;
      const length = view.getUint16(at, false);
      if (length < 2 || at + length > bytes.length) return null;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (length < 7) return null;
        return { height: view.getUint16(at + 3, false), width: view.getUint16(at + 5, false) };
      }
      at += length;
    }
    return null;
  }

  if (
    bytes.length >= 20 &&
    view.getUint32(0, false) === 0x52494646 &&
    view.getUint32(8, false) === 0x57454250
  ) {
    const riffEnd = view.getUint32(4, true) + 8;
    if (riffEnd > bytes.length) return null;
    let at = 12;
    let dimensions: { width: number; height: number } | null = null;
    let sawFrame = false;
    for (let chunks = 0; chunks < 2048 && at + 8 <= riffEnd; chunks += 1) {
      const name = view.getUint32(at, false);
      const size = view.getUint32(at + 4, true);
      const body = at + 8;
      if (size > riffEnd - body) return null;
      let current: { width: number; height: number } | null = null;
      if (name === 0x56503858) {
        if (size < 10 || (byte(body) & 0x02) !== 0) return null; // Animated WebP needs a separate bound.
        current = {
          width: 1 + byte(body + 4) + (byte(body + 5) << 8) + (byte(body + 6) << 16),
          height: 1 + byte(body + 7) + (byte(body + 8) << 8) + (byte(body + 9) << 16),
        };
      } else if (name === 0x5650384c) {
        if (size < 5 || byte(body) !== 0x2f) return null;
        current = {
          width: 1 + byte(body + 1) + ((byte(body + 2) & 0x3f) << 8),
          height:
            1 + (byte(body + 2) >> 6) + (byte(body + 3) << 2) + ((byte(body + 4) & 0x0f) << 10),
        };
        sawFrame = true;
      } else if (name === 0x56503820) {
        if (
          size < 10 ||
          byte(body + 3) !== 0x9d ||
          byte(body + 4) !== 0x01 ||
          byte(body + 5) !== 0x2a
        )
          return null;
        current = {
          width: view.getUint16(body + 6, true) & 0x3fff,
          height: view.getUint16(body + 8, true) & 0x3fff,
        };
        sawFrame = true;
      }
      if (current) {
        dimensions = dimensions
          ? {
              width: Math.max(dimensions.width, current.width),
              height: Math.max(dimensions.height, current.height),
            }
          : current;
      }
      at = body + size + (size & 1);
    }
    return at === riffEnd && sawFrame ? dimensions : null;
  }
  return null;
}

/** Read codec dimensions before an image is handed to the OCR decoder. */
export function checkStudyImageDimensions(bytes: ArrayBuffer): { width: number; height: number } {
  const dimensions = imageDimensions(new Uint8Array(bytes));
  if (!dimensions) {
    throw new Error('Could not inspect image dimensions. Choose a standard PNG, JPEG, or WebP.');
  }
  const { width, height } = dimensions;
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_STUDY_IMAGE_SIDE ||
    height > MAX_STUDY_IMAGE_SIDE ||
    width * height > MAX_STUDY_IMAGE_PIXELS
  ) {
    throw new Error('This image is too large for local OCR. Use one under 16 megapixels.');
  }
  return dimensions;
}

/** Reject oversized DOCX members before Mammoth inflates its ZIP entries. */
export function checkDocxArchive(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  const lowerBound = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= lowerBound; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('This DOCX has no readable ZIP directory.');
  const entries = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const start = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    entries !== view.getUint16(eocd + 8, true) ||
    entries > 2048 ||
    size === 0xffffffff ||
    start === 0xffffffff ||
    start + size > eocd
  ) {
    throw new Error('This DOCX ZIP directory is unsupported or too large.');
  }

  let at = start;
  let total = 0;
  let xmlTotal = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > start + size || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error('This DOCX ZIP directory is damaged.');
    }
    const inflated = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (inflated === 0xffffffff || next > start + size) {
      throw new Error('This DOCX ZIP entry is unsupported.');
    }
    total += inflated;
    if (total > 64 * 1024 * 1024) {
      throw new Error('This DOCX expands beyond 64 MB. Split or simplify it.');
    }
    const name = new TextDecoder().decode(new Uint8Array(bytes, at + 46, nameLength)).toLowerCase();
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      xmlTotal += inflated;
      if (inflated > 8 * 1024 * 1024 || xmlTotal > 20 * 1024 * 1024) {
        throw new Error('This DOCX contains too much XML to extract safely.');
      }
    }
    at = next;
  }
  if (at !== start + size) throw new Error('This DOCX ZIP directory is damaged.');
}
