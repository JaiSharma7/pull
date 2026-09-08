import { type PathDetail, type PathItem, shapePathDetail, shapePaths } from './paths.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * Reads all published learning paths and the caller's progress.
 * Callable by both anonymous visitors and authenticated users.
 */
export async function fetchPaths(signal?: AbortSignal): Promise<PathItem[]> {
  const request = supabase.rpc('get_paths');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapePaths(data);
}

/**
 * Reads one learning path by slug, including its steps and caller's progress.
 * Returns null if the path does not exist or is not published.
 */
export async function fetchPath(slug: string, signal?: AbortSignal): Promise<PathDetail | null> {
  const request = supabase.rpc('get_path', { p_slug: slug });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapePathDetail(data);
}

/**
 * Advances progress past a completed step. Authenticated only.
 */
export async function advanceStep(
  pathId: string,
  ordinal: number,
): Promise<{ ok: boolean; completed: boolean }> {
  const { data, error } = await supabase.rpc('advance_path', {
    p_path_id: pathId,
    p_ordinal: ordinal,
  });
  if (error) throw rpcError(error);
  const res = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ok: Boolean(res.ok),
    completed: Boolean(res.completed),
  };
}

/**
 * Pauses a learning path. Authenticated only.
 */
export async function pausePath(pathId: string): Promise<{ ok: boolean; paused: boolean }> {
  const { data, error } = await supabase.rpc('pause_path', { p_path_id: pathId });
  if (error) throw rpcError(error);
  const res = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ok: Boolean(res.ok),
    paused: Boolean(res.paused),
  };
}

/**
 * Resumes a paused learning path. Authenticated only.
 */
export async function resumePath(pathId: string): Promise<{ ok: boolean; paused: boolean }> {
  const { data, error } = await supabase.rpc('resume_path', { p_path_id: pathId });
  if (error) throw rpcError(error);
  const res = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ok: Boolean(res.ok),
    paused: Boolean(res.paused),
  };
}

/**
 * Tests out of steps whose pulls the reader already holds above the retrievability floor.
 */
export async function testOut(
  pathId: string,
): Promise<{ ok: boolean; testedOutOrdinals: number[]; completed: boolean }> {
  const { data, error } = await supabase.rpc('test_out', { p_path_id: pathId });
  if (error) throw rpcError(error);
  const res = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const testedOutOrdinals = Array.isArray(res.testedOutOrdinals)
    ? (res.testedOutOrdinals as number[]).filter((n) => typeof n === 'number')
    : [];
  return {
    ok: Boolean(res.ok),
    testedOutOrdinals,
    completed: Boolean(res.completed),
  };
}

/**
 * Submits an apply step reflection note and advances progress.
 */
export async function applyStep(
  pathId: string,
  ordinal: number,
  reflection: string,
  mutationId?: string,
): Promise<{ ok: boolean; noteId: string | null }> {
  const { data, error } = await supabase.rpc('apply_path_step', {
    p_path_id: pathId,
    p_ordinal: ordinal,
    p_reflection: reflection,
    p_mutation_id: mutationId ?? undefined,
  });
  if (error) throw rpcError(error);
  const res = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ok: Boolean(res.ok),
    noteId: typeof res.noteId === 'string' ? res.noteId : null,
  };
}
