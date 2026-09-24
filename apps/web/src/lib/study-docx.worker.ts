import mammoth from 'mammoth';

import { verifyDocxExpansion } from './study-docx.js';
import { MAX_STUDY_TEXT_CHARS } from './study-source.js';

self.addEventListener('message', async (event: MessageEvent<ArrayBuffer>) => {
  try {
    await verifyDocxExpansion(event.data);
    const result = await mammoth.extractRawText({ arrayBuffer: event.data });
    if (result.value.length > MAX_STUDY_TEXT_CHARS) {
      throw new Error('The extracted text is over 200,000 characters. Split this reading.');
    }
    self.postMessage({
      text: result.value,
      warnings: result.messages.map((message) => message.message).slice(0, 3),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'This DOCX could not be read.',
    });
  }
});
