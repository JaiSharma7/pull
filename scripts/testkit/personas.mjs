/**
 * The accounts, and what each one is for.
 *
 * A test account is only worth having if it makes some screen behave differently. Four
 * accounts are here because the app has four genuinely different states — not signed
 * in, signed in with nothing, signed in with a working memory, and signed in with a
 * memory that has decayed — and every one of them lays out differently on a phone.
 *
 * The addresses are all `@pull.test`. RFC 2606 reserves that suffix, so none of them
 * can route: a stray password reset, a stray digest, a stray anything goes nowhere.
 * `make-personas.mjs` will delete and rebuild an account, and it does that by address —
 * so the addresses being unroutable by construction is a safety property, not tidiness.
 */
import { PERSONA_DOMAIN } from './stack.mjs';

/**
 * Names, not `Test User 1`.
 *
 * The Delta, the graph and the census all render a reader back to themselves, and a
 * screen full of placeholder text hides exactly the bugs a screen full of real-length
 * words shows: a display name is a layout risk on a 393px viewport and a nine-character
 * one never proves it.
 */
export const PERSONAS = [
  {
    key: 'visitor',
    guest: true,
    label: 'Visitor → guest',
    blurb:
      'No account at all. The recorder presses “Look around as a guest”, which is a real ' +
      'anonymous session in sessionStorage — so this is also the persona that proves the ' +
      'guest bounds (no generation, no authoring, no reports) are visible rather than silent.',
  },
  {
    key: 'first-run',
    email: `first-run@${PERSONA_DOMAIN}`,
    fullName: 'Wren Ashby-Okonkwo',
    label: 'First run',
    blurb:
      'Created seconds ago and nothing else. `onboarded_at` is null, so OnboardingGate holds ' +
      'the shell and the reader sees the first-run screens. The one persona that must be ' +
      'rebuilt before every recording, because answering onboarding once spends it.',
    seed: { onboarded: false },
  },
  {
    key: 'reader',
    email: `reader@${PERSONA_DOMAIN}`,
    fullName: 'Ingrid Vasquez-Lindqvist',
    label: 'Seasoned reader',
    blurb:
      'Three weeks of reading, half of it graded, a library in two stashes. The feed ' +
      'interleaves, the Delta has covered distance to report, Review has a short queue and ' +
      'History has something to scroll. This is the persona most screens should be judged on.',
    seed: {
      onboarded: true,
      topicWeights: { philosophy: 0.9, science: 0.7, history: 0.6 },
      reads: 24,
      grades: 14,
      convictions: 4,
      stashes: ['Arguments I keep losing', 'For the reading group'],
      saves: 9,
      ageDays: 21,
    },
  },
  {
    key: 'lapsed',
    email: `lapsed@${PERSONA_DOMAIN}`,
    fullName: 'Théo Marchetti',
    label: 'Lapsed reader',
    blurb:
      'Read a lot, then stopped for two months. Every knowledge state is past due, so the ' +
      'Delta shows decay rather than progress and Review opens with a full queue. The state ' +
      'that only appears after real time has passed, which is why the seeder backdates it.',
    seed: {
      onboarded: true,
      topicWeights: { economics: 0.8, psychology: 0.7 },
      reads: 16,
      grades: 16,
      convictions: 2,
      stashes: ['Unfinished'],
      saves: 4,
      ageDays: 62,
    },
  },
];

export const ACCOUNTS = PERSONAS.filter((p) => !p.guest);

export function personaByKey(key) {
  const found = PERSONAS.find((p) => p.key === key);
  if (!found) {
    throw new Error(`Unknown persona "${key}". Known: ${PERSONAS.map((p) => p.key).join(', ')}`);
  }
  return found;
}
