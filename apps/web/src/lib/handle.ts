/**
 * A username, before the database sees it.
 *
 * `profiles.handle` is `citext` with `check (handle ~ '^[a-z0-9_]{3,30}$')`, and
 * `claim_handle` (20260906090000) enforces exactly that again on the way in. These
 * helpers are the third copy of the rule and the only one a reader meets: a
 * constraint violation is a correct answer arriving too late and in the wrong voice.
 *
 * Pure, and holding no client, so the rule can be tested over a table of inputs
 * rather than through a network call.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;

/** The database's own rule, written once here and once in SQL. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

/**
 * What the database will actually store.
 *
 * Lower-cased rather than refused, because `Jai_Sharma` is not a mistake somebody
 * made — it is how people type their own name, and `citext` means it is the same
 * name either way. `claim_handle` does this too; doing it here as well is what
 * lets the screen show the reader the name they are about to get.
 */
export function normaliseHandle(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * What is wrong with this username, said in one sentence, or null when nothing is.
 *
 * Written against the normalised value, so "  Ada  " is short rather than
 * mis-punctuated and the reader is told the thing they can act on.
 */
export function handleProblem(input: string): string | null {
  const handle = normaliseHandle(input);
  if (handle.length === 0) return 'Choose a username.';
  if (handle.length < HANDLE_MIN) return `A username is at least ${HANDLE_MIN} characters.`;
  if (handle.length > HANDLE_MAX) return `A username is at most ${HANDLE_MAX} characters.`;
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Letters, numbers and underscores only — no spaces, dots or dashes.';
  }
  /*
   * The prefix the database gives a profile nobody has named yet. Refused here as
   * well as in SQL so the reader hears why rather than watching a request fail: it
   * is the one rejection whose reason is invisible from the outside.
   */
  if (handle.startsWith('reader_')) return 'A username cannot begin with "reader_".';
  return null;
}

/**
 * A username worth offering, made from the name a provider gave us.
 *
 * Offered, never applied: the field is pre-filled and the reader can empty it. A
 * name someone was assigned and never agreed to is the failure 20260901120000
 * describes, and the fact that this one is not derived from an email address does
 * not make assigning it silently any better.
 *
 * AN ADDRESS IS NOT A NAME. `handle_new_user` drops provider metadata containing an
 * `@` for that reason, and this refuses it a second time rather than trusting that
 * it did — the whole point of the rule is that the two are easy to confuse, and this
 * function is the one place in the browser that turns a person's name into an
 * identifier.
 */
export function suggestHandle(displayName: string | null | undefined): string {
  const source = (displayName ?? '').trim();
  if (source.length === 0 || source.includes('@')) return '';

  const suggestion = source
    // `José` becomes `jose` rather than `jos`: decompose, then drop the accents.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // One underscore per run of anything else, so `Ada  Lovelace!` is `ada_lovelace`.
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, HANDLE_MAX);

  // Short enough to be refused is the same as nothing: an empty field asks the
  // reader to type, and a field holding `jo` asks them to work out what is wrong.
  return suggestion.length >= HANDLE_MIN ? suggestion : '';
}
