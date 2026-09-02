import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@wap/ui/styles.css';
import './styles/fonts.css';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { bootstrapTarget } from './lib/bootstrap-route.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

/*
 * The design preview is chosen here, above `App`, and BOTH sides are imported
 * dynamically. That is the whole point of the file rather than a bundling
 * preference.
 *
 * `docs/design-strategy-preview.md` promises a surface that "mounts no Supabase
 * client, restores no session, and writes no reader data". None of that is decided
 * by what renders — it is decided by what gets IMPORTED. `App` pulls in
 * `lib/supabase.ts`, which constructs the client and registers an
 * `onAuthStateChange` listener at module scope, so a static `import { App }` here
 * would have restored a session on `/design-preview` before a single fixture was
 * drawn. Measured on the first attempt at this file, which kept the static import:
 * loading the preview fetched `lib/supabase.ts` and the vendored client anyway, and
 * the boundary was a sentence in a document rather than a property of the build.
 *
 * Only the branch that is taken is loaded, so the preview never sees the app's
 * module graph and — just as usefully — a reader never downloads the preview's
 * component or its 383 lines of scoped CSS.
 *
 * An async IIFE rather than top-level `await`, which keeps this working whatever
 * the build target is set to later.
 */
const render = (children: ReactNode) => {
  /*
   * The boundary wraps the whole tree rather than living inside it, on purpose.
   * `App` holds the router, the session and the shell, and a throw from any of
   * those is exactly the case with no UI left to catch it — a boundary nested below
   * them would go down with the tree it was meant to survive.
   */
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>{children}</ErrorBoundary>
    </StrictMode>,
  );
};

void (async () => {
  try {
    if (bootstrapTarget(window.location.pathname) === 'design-preview') {
      const { DesignPreview } = await import('./routes/DesignPreview.js');
      render(<DesignPreview />);
      return;
    }

    const { App } = await import('./App.js');
    render(<App />);
  } catch (cause) {
    /*
     * A chunk that never arrives is the one failure `ErrorBoundary` cannot catch.
     *
     * It is mounted BY `render`, so a rejected `import()` throws before there is any
     * boundary to catch it — an unhandled rejection, and `#root` left empty. Neither
     * import is hypothetical: a first visit over a dropped connection, or a returning
     * reader whose cached `index.html` points at a filename the last deploy replaced,
     * both land here. The old static import could not fail this way, so making the
     * bootstrap dynamic is what introduced the gap and it is fixed in the same file.
     *
     * Reload rather than a message alone, because the stale-asset case is fixed by
     * exactly that, and it is the likelier of the two.
     */
    console.error('Bootstrap failed', cause);
    root.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'meta';
    p.style.padding = '2rem';
    p.textContent = 'This did not load. Reload the page to try again.';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn';
    again.textContent = 'Reload';
    again.addEventListener('click', () => window.location.reload());
    p.append(document.createElement('br'), again);
    root.append(p);
  }
})();
