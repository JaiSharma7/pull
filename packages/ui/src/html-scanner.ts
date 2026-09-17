/** Find an ASCII token case-insensitively without changing source offsets. */
const asciiIndexOf = (text: string, token: string, from: number): number => {
  const fold = (code: number) => (code >= 65 && code <= 90 ? code + 32 : code);
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
};

/** Find a tag's closing bracket without treating a quoted bracket as the end. */
const tagEnd = (html: string, from: number): number => {
  let quote: '"' | "'" | undefined;
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
};

/**
 * Return the bodies of one kind of HTML element with a linear scan.
 *
 * This is deliberately only the small piece the design checks need. Tag names
 * are case-insensitive, the character after the name must be a real tag-name
 * boundary, and a browser-tolerated closing tag such as `</script >` ends the
 * body. An unterminated body is ignored rather than treating executable text as
 * page content.
 */
export const elementBodies = (html: string, tag: string): string[] => {
  const open = `<${tag}`;
  const close = `</${tag}`;
  const boundary = (char: string | undefined) =>
    char === undefined || char === '>' || char === '/' || /\s/.test(char);
  const bodies: string[] = [];
  let cursor = 0;

  for (;;) {
    let start = asciiIndexOf(html, open, cursor);
    while (start !== -1 && !boundary(html[start + open.length])) {
      start = asciiIndexOf(html, open, start + open.length);
    }
    if (start === -1) return bodies;

    const openEnd = tagEnd(html, start + open.length);
    if (openEnd === -1) return bodies;

    let end = asciiIndexOf(html, close, openEnd + 1);
    while (end !== -1 && !boundary(html[end + close.length])) {
      end = asciiIndexOf(html, close, end + close.length);
    }
    if (end === -1) return bodies;

    const closeEnd = tagEnd(html, end + close.length);
    if (closeEnd === -1) return bodies;
    bodies.push(html.slice(openEnd + 1, end));
    cursor = closeEnd + 1;
  }
};

/**
 * Remove complete HTML comments until removing one cannot reveal another.
 * Every successful pass shortens the string, so the loop always terminates.
 */
export const withoutHtmlComments = (html: string): string => {
  let previous: string;
  do {
    previous = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  } while (html !== previous);
  return html;
};
