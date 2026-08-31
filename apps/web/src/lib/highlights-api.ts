import {
  type ExportSource,
  type Highlight,
  type HighlightField,
  shapeHighlights,
} from './highlights.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * Highlights, over a table that has existed since round 1 with nothing writing
 * it. No migration: `highlights_own` is a single `for all` owner policy and
 * nothing here adds a second read path, so CI check 4's fifth invariant — no two
 * permissive SELECT policies for one role on one table — is untouched.
 */

export async function fetchHighlights(userId: string, pullIds: string[]): Promise<Highlight[]> {
  if (pullIds.length === 0) return [];
  const { data, error } = await supabase
    .from('highlights')
    .select('id, pull_id, field, start_offset, end_offset, text')
    .eq('user_id', userId)
    .in('pull_id', pullIds)
    .order('start_offset', { ascending: true });
  if (error) throw rpcError(error);

  return shapeHighlights(
    (data ?? []).map((r) => ({
      id: r.id,
      pullId: r.pull_id,
      field: r.field,
      start: r.start_offset,
      end: r.end_offset,
      text: r.text,
    })),
  );
}

export async function createHighlight(
  userId: string,
  h: {
    id: string;
    pullId: string;
    field: HighlightField;
    start: number;
    end: number;
    text: string;
  },
): Promise<void> {
  const { error } = await supabase.from('highlights').insert({
    id: h.id,
    user_id: userId,
    pull_id: h.pullId,
    field: h.field,
    start_offset: h.start,
    end_offset: h.end,
    text: h.text,
  });
  // Client-minted id, so a replay after a lost response collides rather than
  // underlining the same words twice.
  if (error && error.code !== '23505') throw rpcError(error);
}

export async function deleteHighlight(id: string): Promise<void> {
  const { error } = await supabase.from('highlights').delete().eq('id', id);
  if (error) throw rpcError(error);
}

/**
 * Everything a reader has marked or written, shaped for the Markdown export.
 *
 * Two queries rather than a join through `saved_items`, because a highlight does
 * not require a save: a reader can mark a passage on a source page without
 * keeping it, and an export that silently dropped those would be the kind of
 * quiet incompleteness that makes an export untrustworthy.
 */
export async function fetchExportData(userId: string): Promise<ExportSource[]> {
  const { data: hi, error: hiError } = await supabase
    .from('highlights')
    .select('text, start_offset, pull_id, pulls(headline, summaries(works(id, title)))')
    .eq('user_id', userId)
    .order('start_offset', { ascending: true });
  if (hiError) throw rpcError(hiError);

  const { data: saves, error: saveError } = await supabase
    .from('saved_items')
    .select('note, pull_id, pulls(headline, summaries(works(id, title)))')
    .eq('user_id', userId)
    .not('note', 'is', null);
  if (saveError) throw rpcError(saveError);

  type Row = {
    pull_id: string | null;
    pulls: {
      headline: string;
      summaries: { works: { id: string; title: string } | null } | null;
    } | null;
  };

  // Keyed by work, then by pull, so one idea's highlights and its note arrive
  // together under the source they came from rather than as two flat lists.
  const byWork = new Map<
    string,
    { title: string; ideas: Map<string, ExportSource['ideas'][number]> }
  >();

  const slot = (row: Row) => {
    const work = row.pulls?.summaries?.works;
    const pullId = row.pull_id;
    if (!work || !pullId || !row.pulls) return null;
    let source = byWork.get(work.id);
    if (!source) {
      source = { title: work.title, ideas: new Map() };
      byWork.set(work.id, source);
    }
    let idea = source.ideas.get(pullId);
    if (!idea) {
      idea = { headline: row.pulls.headline, highlights: [], note: null };
      source.ideas.set(pullId, idea);
    }
    return idea;
  };

  for (const r of (hi ?? []) as unknown as (Row & { text: string })[]) {
    const idea = slot(r);
    if (idea) idea.highlights.push(r.text);
  }
  for (const r of (saves ?? []) as unknown as (Row & { note: string | null })[]) {
    const idea = slot(r);
    if (idea && r.note) idea.note = r.note;
  }

  return [...byWork.values()].map((s) => ({ title: s.title, ideas: [...s.ideas.values()] }));
}
