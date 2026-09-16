import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripElementBodies, visibleTextLength } from './html-text.mjs';

describe('stripElementBodies', () => {
  it('drops mixed-case script and style elements with tolerant closers', () => {
    const html =
      '<p>visible</p><ScRiPt>hidden()</sCrIpT ><STYLE>.hidden{}</style data-x><p>end</p>';
    assert.equal(visibleTextLength(html), 'visible end'.length);
  });

  it('requires a tag-name boundary', () => {
    assert.equal(
      stripElementBodies('<scripture>prose</scripture>', 'script'),
      '<scripture>prose</scripture>',
    );
  });

  it('preserves offsets around non-ASCII text', () => {
    assert.equal(
      stripElementBodies('İ<script>hidden</script><p>visible</p>', 'script'),
      'İ <p>visible</p>',
    );
  });

  it('drops the remainder after an unclosed element', () => {
    assert.equal(stripElementBodies('<p>before</p><script>hidden', 'script'), '<p>before</p> ');
    assert.equal(stripElementBodies('<p>before</p><style>.hidden{}', 'style'), '<p>before</p> ');
  });
});
