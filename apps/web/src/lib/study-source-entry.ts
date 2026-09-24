import { searchCatalogue } from './search-api.js';
import { supabase } from './supabase.js';
import {
  candidateWorkIds,
  goalSearchQueries,
  shapeStudySuggestions,
} from './study-source-entry-shape.js';
import type { StudySuggestion } from './study-source-entry-shape.js';
export { isPreviewableStudyUrl } from './study-source-entry-shape.js';
export type { StudySuggestion } from './study-source-entry-shape.js';

/** Deterministic catalogue lookup. An empty answer asks for source text. */
export async function suggestStudySources(goal: string): Promise<StudySuggestion[]> {
  for (const query of goalSearchQueries(goal)) {
    const result = await searchCatalogue(query, { limitIdeas: 12, limitSources: 8 });
    const ids = candidateWorkIds(result);
    if (!ids.length) continue;
    const { data, error } = await supabase
      .from('works')
      .select('id, title, description, source_url, rights_status')
      .in('id', ids)
      .eq('rights_status', 'public_domain');
    if (error) throw error;
    const suggestions = shapeStudySuggestions(ids, data ?? []);
    if (suggestions.length) return suggestions;
  }
  return [];
}

export interface StudyUrlPreview {
  url: string;
  title: string;
  text: string;
  notes: string;
}

export async function fetchStudyUrlPreview(url: string): Promise<StudyUrlPreview> {
  const { data, error } = await supabase.functions.invoke<StudyUrlPreview>('study-url-preview', {
    body: { url },
  });
  if (error) {
    const response = error.context;
    if (response instanceof Response) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (typeof body?.error === 'string') throw new Error(body.error);
    }
    throw new Error('Could not preview this URL. Paste its text or try again.');
  }
  if (
    !data ||
    typeof data.url !== 'string' ||
    typeof data.title !== 'string' ||
    typeof data.text !== 'string' ||
    typeof data.notes !== 'string'
  )
    throw new Error('The source preview was incomplete. Try again.');
  return data;
}
