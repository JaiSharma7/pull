/** Find an ASCII token case-insensitively without changing source offsets. */
function asciiIndexOf(text, token, from) {
  const fold = (code) => (code >= 65 && code <= 90 ? code + 32 : code);
  const last = text.length - token.length;

  for (let start = from; start <= last; start += 1) {
    let matches = true;
    for (let offset = 0; offset < token.length; offset += 1) {
      if (fold(text.charCodeAt(start + offset)) !== fold(token.charCodeAt(offset))) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }

  return -1;
}

/**
 * Drop an HTML element and its contents with a linear scan.
 *
 * This is intentionally a narrow helper for the corpus preflight, not a general
 * HTML parser. It recognises case-insensitive tag names only at tag-name
 * boundaries, accepts browser-tolerated closing tags such as `</script >`, and
 * drops the remainder when an element is unterminated. Each search resumes after
 * the previous match, so hostile input cannot trigger regexp backtracking.
 */
export function stripElementBodies(html, tag) {
  const open = `<${tag}`;
  const close = `</${tag}`;
  const boundary = (char) => char === undefined || char === '>' || char === '/' || /\s/.test(char);
  let output = '';
  let cursor = 0;

  for (;;) {
    let start = asciiIndexOf(html, open, cursor);
    while (start !== -1 && !boundary(html[start + open.length])) {
      start = asciiIndexOf(html, open, start + open.length);
    }
    if (start === -1) return output + html.slice(cursor);

    output += `${html.slice(cursor, start)} `;
    const openEnd = html.indexOf('>', start + open.length);
    if (openEnd === -1) return output;

    let end = asciiIndexOf(html, close, openEnd + 1);
    while (end !== -1 && !boundary(html[end + close.length])) {
      end = asciiIndexOf(html, close, end + close.length);
    }
    if (end === -1) return output;

    const closeEnd = html.indexOf('>', end + close.length);
    if (closeEnd === -1) return output;
    cursor = closeEnd + 1;
  }
}

/** Rough stand-in for the worker's extractor, enough to identify a prose page. */
export function visibleTextLength(html) {
  return stripElementBodies(stripElementBodies(html, 'script'), 'style')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
