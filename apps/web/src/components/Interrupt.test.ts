import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Interrupt } from './Interrupt.js';
import type { FeedRow } from '../lib/types.js';

vi.mock('../lib/questions-api.js', () => ({
  fetchQuestions: vi.fn().mockResolvedValue([]),
}));

const mockPull: FeedRow = {
  id: '77777777-7777-4777-8777-777777777777',
  summaryId: '66666666-6666-4666-8666-666666666666',
  ordinal: 1,
  headline: 'Some things are up to you. Most are not.',
  body: 'Your judgements, intentions and effort are yours.',
  explanation: null,
  example: null,
  whyItMatters: 'Filters effort into productive action.',
  estimatedReadSeconds: 30,
  summaryTitle: 'The Enchiridion',
  work: {
    id: '88888888-8888-4888-8888-888888888888',
    title: 'The Enchiridion',
    kind: 'book',
    slug: 'the-enchiridion',
    year: 125,
  },
  score: 0.95,
};

describe('Interrupt component', () => {
  it('renders recall interrupt initially as a prompt card with Show answer and I’m sure', () => {
    const html = renderToStaticMarkup(
      createElement(Interrupt, {
        kind: 'recall',
        pull: mockPull,
        onAnswer: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain('Do you still have this?');
    expect(html).toContain('Some things are up to you. Most are not.');
    expect(html).toContain('Show answer');
    expect(html).toContain('I’m sure');
    expect(html).toContain('The Enchiridion');
    expect(html).toContain('Skip');
  });

  it('renders conviction interrupt with stance choices', () => {
    const html = renderToStaticMarkup(
      createElement(Interrupt, {
        kind: 'conviction',
        pull: mockPull,
        onAnswer: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain('Do you buy this?');
    expect(html).toContain('Agree');
    expect(html).toContain('Disagree');
    expect(html).toContain('Not sure');
  });

  it('renders say_it_back interrupt with field and compare controls', () => {
    const html = renderToStaticMarkup(
      createElement(Interrupt, {
        kind: 'say_it_back',
        pull: mockPull,
        onAnswer: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain('Say it back');
    expect(html).toContain('In your own words');
    expect(html).toContain('Compare with the card');
  });
});
