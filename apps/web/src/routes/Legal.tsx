import { useMemo } from 'react';
import privacySource from '../../../../docs/privacy.md?raw';
import termsSource from '../../../../docs/terms.md?raw';
import { Prose } from '../components/Prose.js';
import { parseMarkdown } from '../lib/markdown.js';

/**
 * The privacy policy and the terms, rendered from the committed documents.
 *
 * Two properties this page has to have, and both of them shape where it sits in
 * `App.tsx` rather than how it looks:
 *
 * 1. **Readable before signing in.** Terms you can only read once you have
 *    accepted them are not terms. So this renders ahead of the auth gate, and
 *    the sign-in screen links to it.
 * 2. **Readable offline.** The service worker's navigation fallback already
 *    serves these routes, and the text is part of the bundle rather than a
 *    fetch, so a reader on a plane can still find out what we do with their
 *    data.
 */

export const LEGAL_PATHS = { '/privacy': 'privacy', '/terms': 'terms' } as const;

export type LegalDoc = (typeof LEGAL_PATHS)[keyof typeof LEGAL_PATHS];

const SOURCES: Record<LegalDoc, string> = { privacy: privacySource, terms: termsSource };

const OTHER: Record<LegalDoc, { path: string; label: string }> = {
  privacy: { path: '/terms', label: 'Terms of Service' },
  terms: { path: '/privacy', label: 'Privacy Policy' },
};

export function legalDocFor(pathname: string): LegalDoc | null {
  // Trailing slashes are the same page; anything else is not this route.
  const path = pathname.replace(/\/+$/, '') || '/';
  return LEGAL_PATHS[path as keyof typeof LEGAL_PATHS] ?? null;
}

export function Legal({ doc, onNavigate }: { doc: LegalDoc; onNavigate: (to: string) => void }) {
  const { blocks } = useMemo(() => parseMarkdown(SOURCES[doc]), [doc]);
  const other = OTHER[doc];

  function go(to: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Left click only, and never when the reader asked for a new tab: a
      // modified click belongs to the browser, not to the router.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onNavigate(to);
    };
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell__masthead">
        <span className="shell__wordmark">What a Pull</span>
        <a className="btn btn--plain" href="/" onClick={go('/')} style={{ marginLeft: 'auto' }}>
          Back to reading
        </a>
      </header>

      <main id="main" className="shell__main">
        <div className="legal">
          <Prose blocks={blocks} />

          <hr className="rule" />

          <p className="meta legal__foot">
            <a href={other.path} onClick={go(other.path)}>
              {other.label}
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
