/**
 * What an Undo took beyond the highlights, in a sentence.
 *
 * ITS OWN MODULE BECAUSE IT COULD NOT BE TESTED WHERE IT WAS. It lived inside
 * `routes/Ingestion.tsx`, which this PR made un-importable under vitest: the route now
 * imports `lib/import-api.ts`, which imports `lib/supabase.ts`, which builds its client
 * at module scope and throws without `VITE_*` env. A test that reached it failed to
 * COLLECT rather than failing an assertion — the same defect this PR's own comments hold
 * up as the reason `import-fold.ts` exists, reintroduced one file over.
 *
 * That was not academic. The function had a live crash in it, and no test could have
 * caught it.
 */

import type { UndoResult } from './import-fold.js';

/**
 * Name what an Undo removed besides the highlights, or nothing if it removed nothing.
 *
 * `undo_import` deletes the batch's Pulls and everything that cascades off them —
 * questions, grades, notes, highlights, explanations, convictions — and returns the
 * counts in `alsoRemoved` precisely so a reader can be told. Naming them is the
 * difference between an Undo and a surprise: re-importing brings the highlights back and
 * brings none of this back.
 *
 * `alsoRemoved` IS ABSENT ON A SECOND UNDO, which is what made this a crash rather than
 * a nicety. The idempotent branch returns `{importId, removed, alreadyUndone}` and stops
 * (`20260905110000_your_highlights_are_yours_to_keep.sql:1227-1231`) — there is nothing
 * left to count, so it counts nothing. Read unconditionally, that threw during render,
 * and because the error boundary wraps the whole tree the reader lost the entire app to
 * "This screen stopped working". Reachable without anything exotic: the first Undo
 * commits, its response is lost, the button is still on screen, they press it again.
 */
export function collateral(undone: UndoResult): string | null {
  const also = undone.alsoRemoved;
  if (!also) return null;

  const parts = [
    [also.questions, 'question', 'questions'],
    [also.grades, 'recorded review', 'recorded reviews'],
    [also.notes, 'note', 'notes'],
    [also.highlights, 'highlight of your own', 'highlights of your own'],
    [also.explanations, 'explanation', 'explanations'],
    [also.convictions, 'recorded stance', 'recorded stances'],
  ] as const;

  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);

  // `at(-1)` rather than an index, because `noUncheckedIndexedAccess` widens every index
  // to `| undefined` and the emptiness is already decided by the filter above.
  const last = said.at(-1);
  if (last === undefined) return null;
  return said.length === 1 ? last : `${said.slice(0, -1).join(', ')} and ${last}`;
}
