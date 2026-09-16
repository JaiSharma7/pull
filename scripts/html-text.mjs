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
  const lower = html.toLowerCase();
  const name = tag.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}`;
  const boundary = (char) => char === undefined || char === '>' || char === '/' || /\s/.test(char);
  let output = '';
  let cursor = 0;

  for (;;) {
    let start = lower.indexOf(open, cursor);
    while (start !== -1 && !boundary(lower[start + open.length])) {
      start = lower.indexOf(open, start + open.length);
    }
    if (start === -1) return output + html.slice(cursor);

    output += `${html.slice(cursor, start)} `;
    const openEnd = lower.indexOf('>', start + open.length);
    if (openEnd === -1) return output;

    let end = lower.indexOf(close, openEnd + 1);
    while (end !== -1 && !boundary(lower[end + close.length])) {
      end = lower.indexOf(close, end + close.length);
    }
    if (end === -1) return output;

    const closeEnd = lower.indexOf('>', end + close.length);
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
