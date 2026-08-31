/**
 * The footer, and the only place in the reading shell that leaves it.
 *
 * Law 7 says the session has visible edges. A colophon is one of them: the page
 * ends in something, rather than trailing off into whatever loads next.
 */
export function Colophon({ onNavigate }: { onNavigate: (to: string) => void }) {
  function go(to: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onNavigate(to);
    };
  }

  return (
    <footer className="colophon">
      <nav className="colophon__links" aria-label="About this service">
        <a href="/privacy" onClick={go('/privacy')}>
          Privacy
        </a>
        <a href="/terms" onClick={go('/terms')}>
          Terms
        </a>
        <a href="https://github.com/JaiSharma7/pull" target="_blank" rel="noreferrer noopener">
          Source
        </a>
      </nav>
      <p className="colophon__note">
        Audio, offline, history, stashes and Daily Pulls are free permanently.
      </p>
    </footer>
  );
}
