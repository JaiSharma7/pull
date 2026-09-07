/**
 * How this app hands the reader a file.
 *
 * Two screens had already written this by hand and they did not agree.
 * `Library.tsx` revoked the object URL on a later tick with a comment saying why
 * — the browser has not necessarily started reading the blob when `click()`
 * returns — and `Account.tsx` revoked it on the very next line, which is the
 * race that comment describes. 7d adds three more downloads; a fourth and fifth
 * copy of a race is worse than one function.
 *
 * Everything the app offers is text, so that is the whole of the signature. No
 * network, no model, nothing server-side: a file is built from rows the screen
 * already has and handed over by the browser, which is what makes an export work
 * offline and what keeps it free.
 */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on a later tick rather than immediately: the browser has not
  // necessarily started reading the blob by the time `click()` returns, and a
  // URL revoked underneath it produces a download that silently does nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
