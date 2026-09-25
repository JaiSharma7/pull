import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { BudgetExhaustedError } from './pipeline.ts';
import type { CachedStage, StudyDb, StudyGeneration } from './study-steps.ts';

/**
 * The study steps' database side, against a real Supabase client.
 *
 * Runs as the service role, like `db.ts`: every table here is owner-scoped under RLS
 * and has no API write grant, so the worker is the only writer, and it writes through
 * `record_study_stage` and `persist_study_course` so the checks those functions make
 * cannot be skipped. Reads are always filtered by the generation's owner as well as
 * by id -- the service role would read any reader's cache entry by id, and an
 * owner-scoped key is only a guarantee if every lookup honours it.
 */

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, any, any>;

function must<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    const e = result.error as { message?: string };
    throw new Error(`${what}: ${e.message ?? JSON.stringify(result.error)}`);
  }
  return result.data;
}

interface CacheRow {
  id: string;
  stage: 'extract' | 'assemble';
  output: unknown;
  model: string;
  prompt_hash: string;
  schema_hash: string;
  provider_call_id: string | null;
}

const CACHE_COLUMNS = 'id, stage, output, model, prompt_hash, schema_hash, provider_call_id';

function asCached(row: CacheRow): CachedStage {
  return {
    id: row.id,
    stage: row.stage,
    output: row.output,
    model: row.model,
    promptHash: row.prompt_hash,
    schemaHash: row.schema_hash,
    providerCallId: row.provider_call_id,
  };
}

export function createStudyDb(supabase: Db): StudyDb {
  return {
    async loadGeneration(jobId) {
      const generation = must(
        await supabase
          .from('study_generations')
          .select('id, owner_id, goal')
          .eq('job_id', jobId)
          .maybeSingle(),
        'read study generation',
      ) as { id: string; owner_id: string; goal: string } | null;
      if (!generation) return null;

      const rows = must(
        await supabase
          .from('study_generation_sources')
          .select('position, study_source_versions(id, title, format, extracted_text)')
          .eq('generation_id', generation.id)
          .eq('owner_id', generation.owner_id)
          .order('position', { ascending: true }),
        'read study sources',
      ) as unknown as {
        position: number;
        study_source_versions: {
          id: string;
          title: string;
          format: string;
          extracted_text: string;
        } | null;
      }[];

      const sources = rows.map((row) => {
        const v = row.study_source_versions;
        if (!v) throw new Error('read study sources: a source version is missing');
        return {
          versionId: v.id,
          position: row.position,
          title: v.title,
          format: v.format,
          text: v.extracted_text,
        };
      });
      const out: StudyGeneration = {
        id: generation.id,
        ownerId: generation.owner_id,
        goal: generation.goal,
        sources,
      };
      return out;
    },

    async findCachedStage(ownerId, stage, cacheKey) {
      const row = must(
        await supabase
          .from('study_stage_cache')
          .select(CACHE_COLUMNS)
          .eq('owner_id', ownerId)
          .eq('stage', stage)
          .eq('cache_key', cacheKey)
          .maybeSingle(),
        'read study cache',
      ) as CacheRow | null;
      return row ? asCached(row) : null;
    },

    async loadCachedStages(ownerId, ids) {
      if (ids.length === 0) return [];
      const rows = must(
        await supabase
          .from('study_stage_cache')
          .select(CACHE_COLUMNS)
          .eq('owner_id', ownerId)
          .in('id', [...ids]),
        'read study cache entries',
      ) as CacheRow[] | null;
      return (rows ?? []).map(asCached);
    },

    async reserveBudget(jobId, step, cents) {
      const { error } = await supabase.rpc('reserve_budget', {
        p_job_id: jobId,
        p_step: step,
        p_cents: cents,
      });
      if (!error) return;
      if ((error as { code?: string }).code === '53400') throw new BudgetExhaustedError(step);
      throw new Error(`reserve budget: ${error.message ?? JSON.stringify(error)}`);
    },

    async recordStage(jobId, step, calls, cache) {
      return must(
        await supabase.rpc('record_study_stage', {
          p_job_id: jobId,
          p_step: step,
          p_calls: calls as never,
          p_cache: cache as never,
        }),
        'record study stage',
      ) as string | null;
    },

    async persistCourse(jobId, payload) {
      return must(
        await supabase.rpc('persist_study_course', {
          p_job_id: jobId,
          p_payload: payload as never,
        }),
        'persist study course',
      ) as Record<string, unknown>;
    },

    journal: {
      async open(call) {
        must(
          await supabase.from('provider_calls').insert({
            id: call.id,
            job_id: call.jobId,
            step: call.step,
            provider: call.provider,
            endpoint: call.endpoint,
          }),
          'journal provider call',
        );
      },
      async close(id, outcome, httpStatus) {
        must(
          await supabase
            .from('provider_calls')
            .update({ outcome, http_status: httpStatus, closed_at: new Date().toISOString() })
            .eq('id', id)
            .eq('outcome', 'open'),
          'close provider call',
        );
      },
    },
  };
}
