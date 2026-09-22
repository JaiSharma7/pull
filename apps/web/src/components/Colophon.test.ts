import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Colophon } from './Colophon.js';

describe('Colophon', () => {
  it('links Source to the canonical repository', () => {
    const html = renderToStaticMarkup(createElement(Colophon, { onNavigate: () => undefined }));

    expect(html).toContain('href="https://github.com/WhatAPull/pull"');
  });
});
