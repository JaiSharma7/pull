import {
  assemblePdfPages,
  checkPdfPageCount,
  checkStudyFile,
  checkStudyImageDimensions,
  MAX_STUDY_OCR_PAGES,
  MAX_STUDY_TEXT_CHARS,
  type StudySourceFormat,
  unreadablePdfPages,
} from './study-source.js';

export interface StudyExtraction {
  format: StudySourceFormat;
  text: string;
  originLabel: string;
  notes: string;
  pageTexts: string[] | null;
  sparsePages: number[];
}

async function openPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  try {
    return { pdf: await task.promise, close: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

function boundedText(text: string): string {
  if (text.length > MAX_STUDY_TEXT_CHARS) {
    throw new Error('The extracted text is over 200,000 characters. Split this reading.');
  }
  return text;
}

type DocxReply = { text: string; warnings: string[] } | { error: string };

async function readDocx(file: File): Promise<{ text: string; warnings: string[] }> {
  const bytes = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./study-docx.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error('DOCX extraction took too long. Try a shorter document.'));
    }, 20_000);
    worker.onmessage = (event: MessageEvent<DocxReply>) => {
      finish();
      const reply = event.data;
      if ('error' in reply) reject(new Error(reply.error));
      else resolve(reply);
    };
    worker.onerror = () => {
      finish();
      reject(new Error('This DOCX could not be read in the browser.'));
    };
    try {
      worker.postMessage(bytes, [bytes]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
/**
 * Local extraction only. The binary file is never uploaded; the reader reviews the
 * extracted text before the save RPC receives it.
 */
export async function extractStudyFile(
  file: File,
  onProgress: (message: string) => void,
): Promise<StudyExtraction> {
  const format = checkStudyFile(file);
  if (format === 'text' || format === 'markdown') {
    onProgress('Reading text…');
    const text = boundedText(await file.text());
    return {
      format,
      text,
      originLabel: file.name,
      notes: 'Imported from a local text file; review the text before saving.',
      pageTexts: null,
      sparsePages: [],
    };
  }
  if (format === 'docx') {
    onProgress('Extracting Word document text…');
    const result = await readDocx(file);
    return {
      format,
      text: boundedText(result.text),
      originLabel: file.name,
      notes: [
        'Text extracted locally from DOCX. Images and layout are not preserved.',
        ...result.warnings,
      ].join(' '),
      pageTexts: null,
      sparsePages: [],
    };
  }
  if (format === 'image_ocr') {
    return {
      format,
      text: '',
      originLabel: file.name,
      notes: 'Image text needs OCR. Check every word against the image before saving.',
      pageTexts: null,
      sparsePages: [1],
    };
  }

  onProgress('Reading PDF pages…');
  const { pdf, close } = await openPdf(file);
  try {
    checkPdfPageCount(pdf.numPages);
    const pageTexts: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      onProgress('Reading PDF page ' + number + ' of ' + pdf.numPages + '…');
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let body = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        body += item.str;
        body += item.hasEOL ? '\n' : ' ';
      }
      pageTexts.push(body.trim());
      boundedText(assemblePdfPages(pageTexts));
      page.cleanup();
    }
    return {
      format: 'pdf',
      text: assemblePdfPages(pageTexts),
      originLabel: file.name,
      notes:
        'Text extracted locally from PDF. Reading order, tables, and short pages need checking against the original.',
      pageTexts,
      sparsePages: unreadablePdfPages(pageTexts),
    };
  } finally {
    await close();
  }
}

/** OCR is opt-in and bounded. Recognition runs in this browser, one worker per job. */
export async function recognizeStudyFile(
  file: File,
  extraction: StudyExtraction,
  onProgress: (message: string) => void,
): Promise<StudyExtraction> {
  if (extraction.sparsePages.length === 0) return extraction;
  if (extraction.sparsePages.length > MAX_STUDY_OCR_PAGES) {
    throw new Error('More than five PDF pages need OCR. Split the file into shorter readings.');
  }
  if (extraction.format === 'image_ocr') {
    checkStudyImageDimensions(await file.arrayBuffer());
  }
  const { createWorker, OEM } = await import('tesseract.js');
  onProgress('Preparing local OCR…');
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: new URL('/ocr/worker.min.js', window.location.origin).href,
    corePath: new URL('/ocr/core', window.location.origin).href,
    langPath: new URL('/ocr/lang', window.location.origin).href,
    workerBlobURL: false,
  });
  try {
    if (extraction.format === 'image_ocr') {
      onProgress('Recognizing image text…');
      const result = await worker.recognize(file);
      return {
        ...extraction,
        text: boundedText(result.data.text),
        sparsePages: result.data.text.trim() ? [] : [1],
        notes: 'OCR ran in this browser. Compare every word with the image before saving.',
      };
    }
    if ((extraction.format !== 'pdf' && extraction.format !== 'pdf_ocr') || !extraction.pageTexts) {
      throw new Error('OCR is available only for local images and sparse PDF pages.');
    }
    const { pdf, close } = await openPdf(file);
    try {
      const pageTexts = [...extraction.pageTexts];
      for (const number of extraction.sparsePages) {
        onProgress('Recognizing PDF page ' + number + '…');
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width < 1 ||
          base.height < 1 ||
          base.width > 20_000 ||
          base.height > 20_000
        ) {
          throw new Error('This PDF page is too large for local OCR. Split the reading.');
        }
        const scale = Math.min(
          1.7,
          Math.sqrt(4_000_000 / (base.width * base.height)),
          4095 / base.width,
          4095 / base.height,
        );
        if (scale < 0.2) {
          throw new Error('This PDF page is too large for readable local OCR.');
        }
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser cannot render a page for OCR.');
        try {
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const result = await worker.recognize(canvas);
          pageTexts[number - 1] = result.data.text.trim();
          boundedText(assemblePdfPages(pageTexts));
        } finally {
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
        }
      }
      return {
        ...extraction,
        format: 'pdf_ocr',
        pageTexts,
        text: assemblePdfPages(pageTexts),
        sparsePages: unreadablePdfPages(pageTexts),
        notes:
          'OCR ran in this browser on sparse PDF pages. Compare every word and page against the PDF before saving.',
      };
    } finally {
      await close();
    }
  } finally {
    await worker.terminate();
  }
}
