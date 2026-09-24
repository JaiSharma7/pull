import JSZip from 'jszip';

import { checkDocxArchive } from './study-source.js';

const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;

type StreamingZipEntry = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

/**
 * ZIP metadata is attacker-controlled. Count bytes emitted by decompression before
 * Mammoth is allowed to materialize any member into a string.
 */
export async function verifyDocxExpansion(bytes: ArrayBuffer): Promise<void> {
  checkDocxArchive(bytes);
  const archive = await JSZip.loadAsync(bytes, { createFolders: false });
  let total = 0;
  let xmlTotal = 0;

  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const isXml = /\.(xml|rels)$/i.test(entry.name);
    let entryBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (entry as StreamingZipEntry).internalStream('uint8array');
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        stream.pause();
        reject(new Error(message));
      };
      stream.on('data', (chunk: Uint8Array) => {
        if (settled) return;
        entryBytes += chunk.byteLength;
        total += chunk.byteLength;
        if (total > MAX_TOTAL_BYTES) {
          fail('This DOCX expands beyond 64 MB. Split or simplify it.');
        } else if (isXml) {
          xmlTotal += chunk.byteLength;
          if (entryBytes > MAX_XML_ENTRY_BYTES || xmlTotal > MAX_XML_BYTES) {
            fail('This DOCX contains too much XML to extract safely.');
          }
        }
      });
      stream.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      stream.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      stream.resume();
    });
  }
}
