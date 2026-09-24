import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';
import type { StudySourceFormat } from './study-source.js';

export interface SavedStudySource {
  id: string;
  sourceId: string;
  versionNo: number;
  title: string;
  format: StudySourceFormat;
  originLabel: string | null;
  extractionNotes: string | null;
  createdAt: string;
}

export interface StudySaveResult {
  sourceId: string;
  versionId: string;
  versionNo: number;
  replayed: boolean;
}

export async function saveStudySourceVersion(input: {
  title: string;
  format: StudySourceFormat;
  text: string;
  mutationId: string;
  sourceId?: string;
  originLabel?: string;
  extractionNotes?: string;
}): Promise<StudySaveResult> {
  const { data, error } = await supabase.rpc('save_study_source_version', {
    p_title: input.title,
    p_format: input.format,
    p_text: input.text,
    p_mutation_id: input.mutationId,
    ...(input.sourceId ? { p_source_id: input.sourceId } : {}),
    ...(input.originLabel ? { p_origin_label: input.originLabel } : {}),
    ...(input.extractionNotes ? { p_extraction_notes: input.extractionNotes } : {}),
  });
  if (error) throw rpcError(error);
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.sourceId !== 'string' ||
    typeof data.versionId !== 'string' ||
    typeof data.versionNo !== 'number' ||
    typeof data.replayed !== 'boolean'
  ) {
    throw new Error('The source save returned an unreadable answer. Try again with the same text.');
  }
  return data as unknown as StudySaveResult;
}

/** The 100-version server cap lets one bounded read list every current source. */
export async function fetchStudySources(userId: string): Promise<SavedStudySource[]> {
  const { data, error } = await supabase
    .from('study_source_versions')
    .select('id, source_id, version_no, title, format, origin_label, extraction_notes, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw rpcError(error);

  const latest = new Map<string, SavedStudySource>();
  for (const row of data ?? []) {
    const previous = latest.get(row.source_id);
    if (previous && previous.versionNo >= row.version_no) continue;
    latest.set(row.source_id, {
      id: row.id,
      sourceId: row.source_id,
      versionNo: row.version_no,
      title: row.title,
      format: row.format as StudySourceFormat,
      originLabel: row.origin_label,
      extractionNotes: row.extraction_notes,
      createdAt: row.created_at,
    });
  }
  return [...latest.values()].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export async function fetchStudySourceText(userId: string, versionId: string): Promise<string> {
  const { data, error } = await supabase
    .from('study_source_versions')
    .select('extracted_text')
    .eq('owner_id', userId)
    .eq('id', versionId)
    .single();
  if (error) throw rpcError(error);
  return data.extracted_text;
}

export async function deleteStudySource(userId: string, sourceId: string): Promise<void> {
  const { error } = await supabase
    .from('study_sources')
    .delete()
    .eq('owner_id', userId)
    .eq('id', sourceId);
  if (error) throw rpcError(error);
}
