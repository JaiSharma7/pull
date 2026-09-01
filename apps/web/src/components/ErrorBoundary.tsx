import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last thing between a thrown render and a white page.
 *
 * There was no boundary anywhere in this app, so any exception during render
 * unmounted the entire tree and left the reader looking at nothing — no message, no
 * way back, and on a PWA no browser chrome to suggest reloading. That is not a
 * hypothetical: `lib/routes.ts` records `/topic/%` throwing a `URIError` out of
 * `decodeURIComponent` and blanking the app. The specific crash was fixed; the class
 * of crash was not, and the next one arrives the same way.
 *
 * A class component because that is the only thing React offers for this. There is no
 * hook equivalent of `getDerivedStateFromError`, and there is not expected to be.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: retry by itself, or reset when the route changes.
 * A boundary that re-renders the subtree that just threw usually throws again
 * immediately, and a loop of white flashes is worse than one honest screen. The reader
 * gets two explicit choices instead, and both are ordinary navigations rather than
 * anything clever.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    /*
     * Logged, not reported anywhere.
     *
     * `docs/privacy.md` states that nothing about a reader is sent to a third party,
     * and a crash reporter is exactly the kind of thing that gets added without
     * anybody thinking of it as one — a component stack routinely carries the props
     * that caused the failure. If error reporting is ever wanted here it is a privacy
     * policy change first and a dependency second, in that order.
     */
    console.error('Unhandled render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="stack measure" style={{ padding: 'var(--space-6)' }} role="alert">
        <p className="meta">Something broke</p>
        <h1 className="display">This screen stopped working.</h1>
        <p>
          The rest of the app is probably fine. Reloading usually fixes it, and nothing you have
          saved is affected — your library lives on the server, not in this page.
        </p>
        {/*
          The message, not the stack. It is frequently the useful half — "Failed to
          fetch" tells a reader something actionable — and it is what they will quote if
          they report it. The stack goes to the console, where it is useful to whoever
          can read it and invisible to whoever cannot.
        */}
        <p className="meta">{error.message}</p>
        <div className="stack">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.location.reload()}
          >
            Reload this page
          </button>
          {/*
            `assign`, not `pushState`. The router lives inside the subtree that just
            threw, so asking it to navigate would re-render the thing that is broken.
            A full load is the only reliable way back to a known state from here.
          */}
          <button type="button" className="btn" onClick={() => window.location.assign('/')}>
            Go to the feed
          </button>
        </div>
      </main>
    );
  }
}
