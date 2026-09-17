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

/** Find a tag's closing bracket without treating a quoted bracket as the end. */
function tagEnd(html, from) {
  let quote;
  for (let cursor = from; cursor < html.length; cursor += 1) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return cursor;
    }
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
    const openEnd = tagEnd(html, start + open.length);
    if (openEnd === -1) return output;

    let end = asciiIndexOf(html, close, openEnd + 1);
    while (end !== -1 && !boundary(html[end + close.length])) {
      end = asciiIndexOf(html, close, end + close.length);
    }
    if (end === -1) return output;

    const closeEnd = tagEnd(html, end + close.length);
    if (closeEnd === -1) return output;
    cursor = closeEnd + 1;
  }
}

/** Replace complete tags and comments in one forward pass. */
function stripTags(html) {
  let output = '';
  let cursor = 0;

  for (;;) {
    const start = html.indexOf('<', cursor);
    if (start === -1) return output + html.slice(cursor);

    output += `${html.slice(cursor, start)} `;
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      if (commentEnd === -1) return output;
      cursor = commentEnd + 3;
      continue;
    }

    const end = tagEnd(html, start + 1);
    if (end === -1) {
      return output + html.slice(start);
    }
    cursor = end + 1;
  }
}

/** Rough stand-in for the worker's extractor, enough to identify a prose page. */
export function visibleTextLength(html) {
  return stripTags(stripElementBodies(stripElementBodies(html, 'script'), 'style'))
    .replace(/\s+/g, ' ')
    .trim().length;
}
