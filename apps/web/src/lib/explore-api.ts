import {
  type Catalogue,
  type TopicPage,
  TOPIC_PAGE,
  shapeCatalogue,
  shapeTopicPage,
} from './explore.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * The two reads the catalogue needs. Neither calls a model (law 2): both are
 * counting joins over rows, and `/costcheck` audits this file along with
 * `api.ts` and `search-api.ts`.
 */

export async function fetchCatalogue(signal?: AbortSignal): Promise<Catalogue> {
  const request = supabase.rpc('get_catalogue');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapeCatalogue(data);
}

/**
 * One topic, or null when there is nothing behind that slug.
 *
 * Null is a real answer here rather than an error: `get_topic` returns SQL null
 * both for a slug that does not exist and for a topic with nothing readable
 * under it, and the screen renders "not found" for both. Distinguishing them
 * would tell a stranger which topic slugs are real, and would not change what
 * the reader can do about it.
 */
export async function fetchTopic(
  slug: string,
  limit: number = TOPIC_PAGE,
  signal?: AbortSignal,
): Promise<TopicPage | null> {
  const request = supabase.rpc('get_topic', { p_slug: slug, p_limit: limit });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapeTopicPage(data);
}
