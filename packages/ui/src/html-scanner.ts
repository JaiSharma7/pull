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
  const lower = html.toLowerCase();
  const name = tag.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}`;
  const boundary = (char: string | undefined) =>
    char === undefined || char === '>' || char === '/' || /\s/.test(char);
  const bodies: string[] = [];
  let cursor = 0;

  for (;;) {
    let start = lower.indexOf(open, cursor);
    while (start !== -1 && !boundary(lower[start + open.length])) {
      start = lower.indexOf(open, start + open.length);
    }
    if (start === -1) return bodies;

    const openEnd = lower.indexOf('>', start + open.length);
    if (openEnd === -1) return bodies;

    let end = lower.indexOf(close, openEnd + 1);
    while (end !== -1 && !boundary(lower[end + close.length])) {
      end = lower.indexOf(close, end + close.length);
    }
    if (end === -1) return bodies;

    const closeEnd = lower.indexOf('>', end + close.length);
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
