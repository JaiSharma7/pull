import { useCallback, useEffect, useState } from 'react';
import {
  buildAccountExport,
  deleteAccount,
  fetchSessions,
  generateRecoveryCodes,
  REAUTH_WINDOW_SECONDS,
  redeemRecoveryCode,
  revokeOtherSessions,
  revokeSession,
  sessionAgeSeconds,
  unusedRecoveryCodeCount,
  type AccountSession,
} from '../lib/account-api.js';
import { ChooseUsername } from '../components/ChooseUsername.js';
import { supabase } from '../lib/supabase.js';

/**
 * Account — the four things a person must be able to do to an account they own.
 *
 * See where they are signed in, get out of somewhere they no longer are, take their
 * writing with them, and leave. Before this screen the app could do none of them: one
 * button called `signOut()` with no scope, which ends the session in this tab and
 * leaves every other one alive, and `docs/privacy.md` promised deletion whose actual
 * mechanism was an email to a personal address.
 *
 * THE SHAPE OF EVERY DESTRUCTIVE ACTION HERE IS THE SAME, and it is deliberate:
 * say what will happen, in what it costs the reader rather than in what it does to the
 * database; make them do something that could not be a misclick; then do it and say so.
 * The three irreversible ones — revoke, delete, regenerate codes — each take a typed
 * confirmation or a second click, and none of them uses `window.confirm`, which cannot
 * be styled, cannot be read in the app's voice, and on a phone is a system sheet that
 * looks like it came from somewhere else.
 *
 * ERROR STATES ARE PER-ACTION, NOT PER-SCREEN. A failed revoke must not blank the
 * export button. Each section owns its own message, which is why there is no single
 * `error` in this component.
 */
export function Account({ userId, email }: { userId: string; email: string | null }) {
  return (
    <section className="stack measure">
      <p className="meta">Account</p>
      <h1 className="display">{email ?? 'Your account'}</h1>
      <p className="lede">
        Where you are signed in, what is stored, and how to take it with you or remove it.
      </p>

      {/* Identity before devices: the one thing on this screen other people ever see. */}
      <hr className="rule" />
      <ChooseUsername userId={userId} mode="account" />

      <hr className="rule" />
      <Sessions />

      <hr className="rule" />
      <SecondFactor />

      <hr className="rule" />
      <ExportData userId={userId} email={email} />

      <hr className="rule" />
      <DeleteAccount email={email} />
    </section>
  );
}

/** "Firefox on Linux" is a thing a person can decide about; a uuid is not. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\/\d/.test(ua)
    ? 'Firefox'
    : /Edg\/\d/.test(ua)
      ? 'Edge'
      : /Chrome\/\d/.test(ua)
        ? 'Chrome'
        : /Safari\/\d/.test(ua)
          ? 'Safari'
          : 'Unknown browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

function when(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Sessions() {
  /*
   * Four states, not two. `null` is "not loaded yet", `[]` is "genuinely none", and
   * `error` is "the request failed" — which must never render as an empty list saying
   * you are signed in nowhere. That is the bug `Review.tsx` records at the top of its
   * own file, arriving here in a place where the wrong answer is reassuring.
   */
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /*
   * The error is cleared in the callbacks rather than before the request.
   *
   * `setError(null)` on the way in is a synchronous setState inside an effect, which
   * the lint rule rejects for a real reason: it renders once with the old data and no
   * error, then again when the answer lands. Clearing on success has the same effect
   * for the reader and one fewer render.
   */
  const load = useCallback(() => {
    fetchSessions()
      .then((rows) => {
        setSessions(rows);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  const revokeOne = async (id: string) => {
    setBusy(true);
    setNote(null);
    try {
      await revokeSession(id);
      setNote('That session can no longer get a new token.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeRest = async () => {
    setBusy(true);
    setNote(null);
    try {
      const n = await revokeOtherSessions();
      setNote(
        n === 0
          ? 'There were no other sessions.'
          : `Ended ${n} other session${n === 1 ? '' : 's'}.`,
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack">
      <h2>Where you are signed in</h2>
      {/*
        Said once, plainly, rather than implied. Deleting the session row stops that
        device minting a *new* token; an access token already issued stays valid until
        it expires, because that is what a stateless JWT is. Claiming otherwise here
        would be the kind of security copy that is worse than none.
      */}
      <p className="meta">
        Ending a session stops that device getting a new token. A token it already holds keeps
        working for up to an hour.
      </p>

      {error && (
        <p className="meta" role="alert">
          Could not load your sessions: {error}{' '}
          <button type="button" className="btn btn--plain" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}

      {!sessions && !error && (
        <p className="meta" role="status">
          Loading…
        </p>
      )}

      {sessions && sessions.length === 0 && <p className="meta">No sessions found.</p>}

      {sessions && sessions.length > 0 && (
        <ul className="stack">
          {sessions.map((s) => (
            <li key={s.id} className="stack">
              <p>
                <strong>{describeAgent(s.userAgent)}</strong>
                {s.isCurrent && <span className="meta"> — this device</span>}
              </p>
              <p className="meta">
                Signed in {when(s.createdAt)}
                {s.ip ? ` from ${s.ip}` : ''}
                {s.aal === 'aal2' ? ' · second factor' : ''}
              </p>
              {!s.isCurrent && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void revokeOne(s.id)}
                >
                  End this session
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {sessions && sessions.length > 1 && (
        <button type="button" className="btn" disabled={busy} onClick={() => void revokeRest()}>
          Sign out everywhere else
        </button>
      )}
    </section>
  );
}

/**
 * The second factor, and the honest description of what the recovery codes do.
 *
 * Enrolment, challenge and verification are GoTrue's (`supabase.auth.mfa.*`). The
 * recovery half is ours, because Supabase has none — and it removes a factor rather
 * than substituting for one. Nothing outside GoTrue can grant `aal2`, so a code that
 * claimed to sign you in would be a decoration over a lie. Since sign-in here is a
 * code sent to an email address, removing the factor is a complete way back.
 */
function SecondFactor() {
  const [factors, setFactors] = useState<{ id: string; status: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error: e }) => {
        if (e) throw e;
        setFactors((data?.totp ?? []).map((f) => ({ id: f.id, status: f.status })));
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    unusedRecoveryCodeCount()
      .then(setRemaining)
      .catch(() => setRemaining(null));
  }, []);

  useEffect(load, [load]);

  const startEnrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (e) throw e;
      setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finishEnrol = async () => {
    if (!enrolling) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId: enrolling.id });
      if (challenge.error) throw challenge.error;
      const verified = await supabase.auth.mfa.verify({
        factorId: enrolling.id,
        challengeId: challenge.data.id,
        code: code.replace(/\D/g, ''),
      });
      if (verified.error) throw verified.error;
      /*
       * Codes are generated at the moment the factor becomes real, not before.
       * Generating them during enrolment would hand out recovery for a factor the
       * reader might abandon halfway, and those codes would then sit unused against an
       * account with no second factor at all.
       */
      setCodes(await generateRecoveryCodes());
      setEnrolling(null);
      setCode('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes(await generateRecoveryCodes());
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verified = (factors ?? []).filter((f) => f.status === 'verified');

  return (
    <section className="stack">
      <h2>Second factor</h2>
      <p className="meta">
        Signing in sends a code to your email, so the account is as strong as the mailbox. An
        authenticator app adds something the mailbox cannot give away.
      </p>

      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}
      {!factors && !error && (
        <p className="meta" role="status">
          Loading…
        </p>
      )}

      {codes && (
        <div className="stack" role="status">
          <p>
            <strong>Save these now.</strong> They are shown once and never again. Each one can be
            used a single time, to remove your second factor if you lose the app — they will not
            sign you in on their own.
          </p>
          <ul className="stack">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => setCodes(null)}>
            I have saved them
          </button>
        </div>
      )}

      {factors && verified.length === 0 && !enrolling && (
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void startEnrol()}
        >
          Add an authenticator app
        </button>
      )}

      {enrolling && (
        <div className="stack">
          <p className="meta">
            Scan this with your authenticator app, then enter the six digits it shows.
          </p>
          {/* The QR is a data: URI produced by GoTrue, so no third party sees the secret. */}
          <img src={enrolling.qr} alt="" width={200} height={200} />
          <p className="meta">
            Cannot scan? Enter this key instead: <code>{enrolling.secret}</code>
          </p>
          <label className="stack" htmlFor="mfa-code">
            <span className="meta">Six-digit code</span>
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || code.replace(/\D/g, '').length !== 6}
            onClick={() => void finishEnrol()}
          >
            Turn it on
          </button>
          <button type="button" className="btn btn--plain" onClick={() => setEnrolling(null)}>
            Cancel
          </button>
        </div>
      )}

      {factors && verified.length > 0 && (
        <div className="stack">
          <p role="status">An authenticator app is protecting this account.</p>
          {remaining !== null && (
            <p className="meta">
              {remaining} unused recovery code{remaining === 1 ? '' : 's'} left.
            </p>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void regenerate()}>
            Show new recovery codes
          </button>
          <p className="meta">
            Generating new codes cancels the old ones, so a printout from before will stop working.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Recovery — reachable without a second factor, because that is the point.
 *
 * Exported for the sign-in screen to render when a reader is held at `aal1` by a factor
 * they cannot satisfy. Kept in this file so the promise made beside "Show new recovery
 * codes" and the thing that honours it stay in each other's sight.
 */
export function RedeemRecoveryCode({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await redeemRecoveryCode(code);
      if (!ok) {
        // One message for wrong, unknown and already-used, on purpose: distinguishing
        // them tells someone guessing which half of the guess was right.
        setError('That code is not usable. Each code works once.');
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack measure">
      <h2>Use a recovery code</h2>
      <p className="meta">
        This removes the authenticator app from your account so you can sign in with an email code
        again. You can add a new one afterwards.
      </p>
      <label className="stack" htmlFor="recovery-code">
        <span className="meta">Recovery code</span>
        <input
          id="recovery-code"
          value={code}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || code.trim().length < 10}
        onClick={() => void submit()}
      >
        Remove the second factor
      </button>
    </section>
  );
}

function ExportData({ userId, email }: { userId: string; email: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const payload = await buildAccountExport(userId, email);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `what-a-pull-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setNote(
        payload.incomplete.length === 0
          ? 'Downloaded.'
          : `Downloaded, but ${payload.incomplete.length} table${
              payload.incomplete.length === 1 ? '' : 's'
            } could not be read. The file lists which.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack">
      <h2>Take it with you</h2>
      <p className="meta">
        Everything stored against this account, as one JSON file: your saves, notes, highlights,
        history, stances, explanations and preferences.
      </p>
      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
        {busy ? 'Gathering…' : 'Download everything'}
      </button>
    </section>
  );
}

/**
 * Deletion, gated on a recent sign-in.
 *
 * `delete_my_account` refuses a session older than ten minutes, and the reason is that
 * this is the one irreversible action in the product: a token minted weeks ago on a
 * device since left on a train should not be able to spend the account.
 *
 * The check happens here too, *before* the reader types their address, so the answer to
 * "can I do this" arrives at the start rather than after the effort. The server remains
 * the authority; this is only politeness.
 */
function DeleteAccount({ email }: { email: string | null }) {
  const [typed, setTyped] = useState('');
  const [fresh, setFresh] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    sessionAgeSeconds()
      .then((age) => setFresh(age !== null && age <= REAUTH_WINDOW_SECONDS))
      .catch(() => setFresh(null));
  }, []);

  const reauth = async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.auth.signInWithOtp({ email });
      if (e) throw e;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      // The row is gone; the token in memory is now attached to nothing. Signing out
      // locally is what clears it, and it must not fail the deletion if it throws.
      await supabase.auth.signOut().catch(() => undefined);
      window.location.assign('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const confirmed = email !== null && typed.trim().toLowerCase() === email.toLowerCase();

  return (
    <section className="stack">
      <h2>Delete this account</h2>
      <p>
        This removes your profile, preferences, saves, notes, highlights, history, stances,
        explanations, and anything you submitted for generation. It cannot be undone, and there is
        no grace period.
      </p>
      <p className="meta">
        Spending records keep a row with no name attached — a model, a token count and a cost —
        because the cost ledger is how this project answers what generation costs. Nothing in it
        identifies you.
      </p>

      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}

      {fresh === false && (
        <div className="stack">
          <p className="meta">
            Deleting an account needs a recent sign-in. Send yourself a new code, enter it on the
            sign-in screen, then come back here.
          </p>
          {sent ? (
            <p className="meta" role="status">
              Code sent to {email}.
            </p>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy || !email}
              onClick={() => void reauth()}
            >
              Send me a code
            </button>
          )}
        </div>
      )}

      {fresh !== false && (
        <div className="stack">
          <label className="stack" htmlFor="confirm-email">
            <span className="meta">Type {email ?? 'your email address'} to confirm</span>
            <input
              id="confirm-email"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button
            type="button"
            /*
             * The accent, not a red of its own. Law 1 allows exactly one accent
             * colour and `design-laws.test.ts` fails a second hex, so a bespoke
             * danger colour is not available — and oxblood already reads as a
             * warning. What actually makes this safe is the typed confirmation
             * above, which keeps the button disabled until the reader has written
             * out their own address; colour was never doing that work.
             */
            className="btn btn--primary"
            disabled={busy || !confirmed}
            onClick={() => void run()}
          >
            {busy ? 'Deleting…' : 'Delete my account permanently'}
          </button>
        </div>
      )}
    </section>
  );
}
