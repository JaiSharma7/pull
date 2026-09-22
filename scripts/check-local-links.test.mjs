import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { localLinkTargets, validateLocalLinks } from './check-local-links.mjs';

describe('local Markdown links', () => {
  it('extracts inline, image, and reference-definition targets', () => {
    const markdown = [
      '[guide](./guide.md#setup)',
      '![diagram](../images/flow.png)',
      '[policy][policy-ref]',
      '[policy-ref]: ../POLICY.md',
      '[external](https://example.com)',
      '[route](/terms)',
    ].join('\n');

    assert.deepEqual(localLinkTargets(markdown), [
      './guide.md#setup',
      '../images/flow.png',
      '../POLICY.md',
    ]);
  });

  it('ignores link-shaped text inside fenced code blocks', () => {
    assert.deepEqual(localLinkTargets('```md\n[not a link](./missing.md)\n```'), []);
  });

  it('reports missing targets with their source document', () => {
    const files = new Map([
      ['docs/index.md', '[exists](./guide.md) [missing](./missing.md)'],
      ['docs/guide.md', '# Guide'],
    ]);

    assert.deepEqual(validateLocalLinks(files), [
      'docs/index.md: local link target does not exist: ./missing.md',
    ]);
  });

  it('accepts directories and URL-encoded local paths', () => {
    const files = new Map([
      ['README.md', '[docs](./docs/) [policy](./docs/content%20policy.md)'],
      ['docs/content policy.md', '# Policy'],
    ]);

    assert.deepEqual(validateLocalLinks(files), []);
  });

  it('accepts links to tracked non-Markdown files', () => {
    const files = new Map([['README.md', '[license](./LICENSE) ![image](./assets/logo.png)']]);
    const trackedPaths = new Set(['README.md', 'LICENSE', 'assets/logo.png']);

    assert.deepEqual(validateLocalLinks(files, trackedPaths), []);
  });
});
