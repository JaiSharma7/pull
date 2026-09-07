import { useEffect, useState } from 'react';
import { handleProblem, normaliseHandle, suggestHandle } from '../lib/handle.js';
import { claimHandle, fetchProfile, type Profile } from '../lib/profile-api.js';

/**
 * A name to be known by, asked for once and changeable afterwards.
 *
 * The database has always given every profile a handle — `reader_` plus sixteen hex
 * characters — because 20260901120000 had to stop deriving one from the email address,
 * and a generated name was the only thing left that was certainly not a disclosure. It
 * is not a name anybody would say out loud, and a Pull handed to somebody else has no
 * way to say who sent it while that is what everyone is called.
 *
 * So this asks, and the asking is the point: `handle_new_user` still generates, this
 * screen still offers rather than assigns, and `suggestHandle` fills the field from the
 * name the provider gave — which a reader can clear, edit or walk past. A name somebody
 * was given and never agreed to is the failure that migration describes, and it does not
 * stop being that because the source changed from an address to a Google profile.
 *
 * Two modes rather than two components, the shape `Preferences` already uses:
 * `onboarding` is the first screen of the first run and can be skipped; `account` is the
 * section on /account that exists so a name is not a decision made once, quickly, by
 * somebody who had not yet seen the product.
 */
export function ChooseUsername({
  userId,
  mode,
  onDone,
}: {
  userId: string;
  mode: 'onboarding' | 'account';
  /** Advance the gate. Not passed on `account`, where there is nowhere to advance to. */
  onDone?: () => void;
}) {
  /** `null` while loading, `'failed'` when the row could not be read at all. */
  const [profile, setProfile] = useState<Profile | null | 'failed'>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /*
   * Whether the reader has touched the field, so the rule is offered as help before it
   * is used as a complaint. Telling somebody their empty username is too short before
   * they have typed anything is scolding them for arriving.
   */
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    let live = true;
    fetchProfile(userId)
      .then((p) => {
        if (!live) return;
        setProfile(p);
        // A name they already hold beats a suggestion made from their display name:
        // this screen is reachable from /account long after the choice was made.
        setValue(p !== null && p.handleSetAt !== null ? p.handle : suggestHandle(p?.displayName));
      })
      .catch(() => {
        /*
         * Fails open, like the `OnboardingGate` around it. A profile that will not load
         * is a reason to let somebody past, never a reason to hold them on a form whose
         * only field cannot be filled in usefully.
         */
        if (live) setProfile('failed');
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const current = profile === null || profile === 'failed' ? null : profile;
  const problem = touched ? handleProblem(value) : null;
  /** In `account` mode, saving the name they already have is a request worth not making. */
  const unchanged =
    current !== null && current.handleSetAt !== null && normaliseHandle(value) === current.handle;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setSaved(null);

    const wrong = handleProblem(value);
    if (wrong) {
      setError(wrong);
      return;
    }

    setBusy(true);
    setError(null);
    // try/finally rather than try/catch-then-reset, for the reason `Auth.tsx` gives:
    // anything that is not a PostgREST error is rethrown, and a bare await would leave
    // the button reading "Saving…" for ever with no way forward but a reload.
    try {
      const handle = await claimHandle(value);
      setSaved(handle);
      setValue(handle);
      setProfile((p) =>
        p === null || p === 'failed' ? p : { ...p, handle, handleSetAt: new Date().toISOString() },
      );
      if (mode === 'onboarding') onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that username.');
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={(e) => void submit(e)} className="stack">
      <label className="field">
        <span className="field__label">Username</span>
        <input
          className="field__input"
          type="text"
          value={value}
          // Lower-cased as it is typed, because that is what will be stored: showing
          // somebody `Ada` and saving `ada` is a small lie about their own name.
          onChange={(e) => {
            setValue(e.target.value.toLowerCase());
            setTouched(true);
            setSaved(null);
            setError(null);
          }}
          onBlur={() => setTouched(true)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={30}
          aria-describedby="username-help"
          disabled={busy}
        />
      </label>
      <p className="meta" id="username-help">
        3–30 characters. Letters, numbers and underscores.
      </p>
      {/* One slot for the live rule and the server's refusal both: two messages about
          one field, one of them stale, is worse than the newer one alone. */}
      {(error ?? problem) && (
        <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
          {error ?? problem}
        </p>
      )}
      {saved !== null && mode === 'account' && (
        <p className="meta" role="status">
          Saved. You are {saved}.
        </p>
      )}

      {mode === 'account' ? (
        <div className="prefs__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || unchanged}>
            {busy ? 'Saving…' : 'Save username'}
          </button>
        </div>
      ) : (
        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid var(--rule)',
            paddingTop: 'var(--space-4)',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
          }}
        >
          {/*
            A way past, because the alternative is holding somebody on the first screen
            of the product over a decision that changes nothing they came for. The
            generated handle keeps working, and /account is where it can be changed.
          */}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => onDone?.()}
            disabled={busy}
          >
            Not now
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </footer>
      )}
    </form>
  );

  const loading = (
    <p className="meta" role="status">
      Loading…
    </p>
  );

  if (mode === 'account') {
    return (
      <section className="stack">
        <h2>Your username</h2>
        <p className="meta">
          How a Pull you send says who sent it. Nobody can look you up by it — a profile is readable
          only by the person it belongs to — so it travels only where you take it.
        </p>
        {profile === null ? loading : form}
      </section>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-5)' }}>
      <header>
        <p className="meta">First, a name</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          What should we call you?
        </h1>
        <p className="meta">
          Until you choose, you are {current?.handle ?? 'a row of hex digits'} — fine for a
          database, no use at all when you hand somebody an idea. This is the name that goes with a
          Pull you share.
        </p>
      </header>
      {profile === null ? loading : form}
    </div>
  );
}
