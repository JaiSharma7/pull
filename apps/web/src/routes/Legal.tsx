import { useMemo } from 'react';
import { Mark } from '@wap/ui';
import privacySource from '../../../../docs/privacy.md?raw';
import termsSource from '../../../../docs/terms.md?raw';
import { Prose } from '../components/Prose.js';
import { LEGAL_PATHS, type LegalDoc, legalDocFor } from '../lib/legal-routes.js';
import { parseMarkdown } from '../lib/markdown.js';
import { routerClick } from '../lib/routes.js';

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

// Re-exported so existing importers of this module keep working; the definitions now
// live in `lib/legal-routes.ts` so `App` can ask the question without loading the text.
export { LEGAL_PATHS, legalDocFor };
export type { LegalDoc };

const SOURCES: Record<LegalDoc, string> = { privacy: privacySource, terms: termsSource };

const OTHER: Record<LegalDoc, { path: string; label: string }> = {
  privacy: { path: '/terms', label: 'Terms of Service' },
  terms: { path: '/privacy', label: 'Privacy Policy' },
};

export function Legal({ doc, onNavigate }: { doc: LegalDoc; onNavigate: (to: string) => void }) {
  const { blocks } = useMemo(() => parseMarkdown(SOURCES[doc]), [doc]);
  const other = OTHER[doc];

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell__masthead">
        <span className="shell__brand">
          <Mark className="shell__mark" />
          <span className="shell__wordmark">What a Pull</span>
        </span>
        <a
          className="btn btn--plain"
          href="/"
          onClick={routerClick(onNavigate, '/')}
          style={{ marginLeft: 'auto' }}
        >
          Back to reading
        </a>
      </header>

      <main id="main" className="shell__main">
        <div className="legal">
          <Prose blocks={blocks} />

          <hr className="rule" />

          <p className="meta legal__foot">
            <a href={other.path} onClick={routerClick(onNavigate, other.path)}>
              {other.label}
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
