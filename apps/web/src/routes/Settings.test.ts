import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
const child = vi.hoisted(() => ({ onDone: undefined as (() => void) | undefined }));
// The preferences editor owns its network writes. Exercise the Settings completion
// contract without running unrelated account/preferences requests during rendering.
vi.mock('./Preferences.js', () => ({
  Preferences: (props: { onDone: () => void }) => {
    child.onDone = props.onDone;
    return null;
  },
}));
vi.mock('./Appearance.js', () => ({ Appearance: () => null }));
import { Settings } from './Settings.js';
describe('reading settings completion', () => {
  it('invalidates the feed before leaving the saved preferences', () => {
    const events: string[] = [];
    renderToStaticMarkup(
      createElement(Settings, {
        session: { user: { id: 'reader', is_anonymous: false } } as Session,
        section: 'reading',
        onPreferencesSaved: () => events.push('refresh feed'),
        onNavigate: (path) => events.push(path),
      }),
    );
    expect(child.onDone).toBeTypeOf('function');
    child.onDone!();
    expect(events).toEqual(['refresh feed', '/settings']);
  });
});
