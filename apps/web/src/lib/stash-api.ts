import { rpcError } from './rpc-error.js';
import { type Stash, shapeStashes } from './stashes.js';
import { supabase } from './supabase.js';

/**
 * Collections, over tables that have existed since round 1.
 *
 * No migration was needed for any of this: `stashes` has `parent_id`,
 * `visibility`, `position` and RLS, and `saved_items` has `stash_id`, `note`,
 * `archived` and `read_later`. Every one of them was always null or false
 * because nothing ever wrote them.
 *
 * `visibility` is deliberately left alone. A public stash is community
 * territory, and `docs/content-policy.md` is explicit that the rights machinery
 * lands before user-generated content is exposed, not after. Every stash written
 * here stays private.
 */

export async function fetchStashes(userId: string): Promise<Stash[]> {
  const { data, error } = await supabase
    .from('stashes')
    .select('id, name, description, parent_id, position')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw rpcError(error);

  return shapeStashes(
    (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      parentId: r.parent_id,
      position: r.position,
    })),
  );
}

/**
 * The id is minted by the caller, not by the database.
 *
 * `stashes.id` defaults to `gen_random_uuid()`, so the obvious thing is to let
 * Postgres pick and read it back — and that makes creating a stash the one
 * organising action that cannot survive a lost response, because a retry would
 * produce a second stash with the same name. A client-minted uuid turns the
 * insert into something a replay collides with on the primary key, which is the
 * same shape every other queued write in this app already has.
 */
export async function createStash(
  userId: string,
  stash: { id: string; name: string; parentId: string | null },
): Promise<void> {
  const { error } = await supabase.from('stashes').insert({
    id: stash.id,
    user_id: userId,
    name: stash.name,
    parent_id: stash.parentId,
  });
  // The collision means this exact stash already landed, which is what the
  // caller wanted rather than a failure to retry.
  if (error && error.code !== '23505') throw rpcError(error);
}

export async function updateStash(
  id: string,
  patch: { name?: string; parentId?: string | null },
): Promise<void> {
  // Typed rather than `Record<string, unknown>`: the generated types reject a
  // loose record on purpose, and that rejection is the thing standing between a
  // typo in a column name and a silent no-op update.
  const row: { name?: string; parent_id?: string | null } = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.parentId !== undefined) row.parent_id = patch.parentId;
  if (Object.keys(row).length === 0) return;

  const { error } = await supabase.from('stashes').update(row).eq('id', id);
  if (error) throw rpcError(error);
}

/**
 * Deleting a stash does not delete what is in it.
 *
 * `20260829124532_library.sql:28` declares `stash_id … on delete set null`, so
 * the saves detach themselves and the reader's library survives the folder. That
 * is worth naming rather than assuming: a `cascade` there would quietly destroy
 * an unlimited library on one click, which is the single thing law 3 promises
 * cannot happen — and the difference is one word in a migration nobody rereads.
 *
 * Child stashes are NOT the same story. `parent_id` is `on delete cascade`
 * (same migration, line 4), so deleting a parent deletes every stash beneath it
 * — and their saves detach and survive, because that FK is the `set null` one.
 * The two constraints differ by one word and have opposite consequences, which
 * is exactly why the caller has to tell the reader what they are about to lose.
 * `stashes_no_self_parent` is the only cycle the schema forbids; longer ones are
 * `buildStashTree`'s problem.
 */
export async function deleteStash(id: string): Promise<void> {
  const { error } = await supabase.from('stashes').delete().eq('id', id);
  if (error) throw rpcError(error);
}

export interface SavePatch {
  stashId?: string | null;
  note?: string | null;
  archived?: boolean;
  readLater?: boolean;
}

/**
 * Every organising action on one save, as one last-write-wins update.
 *
 * That shape is what makes these safe to queue offline: replaying "archived =
 * true" is the same as applying it once, unlike `grade_recall`, which multiplies
 * a stability and cannot be replayed at all.
 */
export async function updateSavedItem(saveId: string, patch: SavePatch): Promise<void> {
  const row: {
    stash_id?: string | null;
    note?: string | null;
    archived?: boolean;
    read_later?: boolean;
  } = {};
  if (patch.stashId !== undefined) row.stash_id = patch.stashId;
  if (patch.note !== undefined) row.note = patch.note;
  if (patch.archived !== undefined) row.archived = patch.archived;
  if (patch.readLater !== undefined) row.read_later = patch.readLater;
  if (Object.keys(row).length === 0) return;

  const { error } = await supabase.from('saved_items').update(row).eq('id', saveId);
  if (error) throw rpcError(error);
}
