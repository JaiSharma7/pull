/**
 * Session state for Interleaved Recall.
 *
 * The interrupt plan is a function of (seed, page, slot), so the seed has to be
 * stable for the whole session and the same across a reload — otherwise a
 * refresh would reshuffle which cards carry questions, which is exactly the
 * kind of inconsistency that makes randomness feel arbitrary rather than
 * designed.
 */
const KEY = 'wap.session';

export interface SessionState {
  seed: number;
  startedAt: number;
  cardsSeen: number;
  interruptsShown: number;
}

/** A session is considered over after this long without activity. */
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function fresh(): SessionState {
  return {
    // 2^31 is plenty of entropy here and stays inside a safe integer everywhere.
    seed: Math.floor(Math.random() * 2 ** 31),
    startedAt: Date.now(),
    cardsSeen: 0,
    interruptsShown: 0,
  };
}

export function loadSession(): SessionState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return persist(fresh());
    const parsed = JSON.parse(raw) as SessionState;
    if (
      typeof parsed?.seed !== 'number' ||
      !Number.isFinite(parsed.seed) ||
      Date.now() - parsed.startedAt > SESSION_MAX_AGE_MS
    ) {
      return persist(fresh());
    }
    return parsed;
  } catch {
    // Private windows and blocked site data both throw; a session that only
    // lives in memory is fine.
    return fresh();
  }
}

export function persist(state: SessionState): SessionState {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* not fatal — the session simply won't survive a reload */
  }
  return state;
}

export function resetSession(): SessionState {
  return persist(fresh());
}
