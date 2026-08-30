import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { PipelineDb } from './pipeline.ts';

/**
 * The pipeline's database side, against a real Supabase client.
 *
 * Separate from `pipeline.ts` so the steps stay testable without a database:
 * the pipeline depends on the `PipelineDb` interface, and this is the one
 * implementation of it that talks to Postgres.
 *
 * Everything here runs as the service role. RLS denies canonical content writes
 * to every API role by design, so this is the only path that can create a
 * summary — which is also why none of it is reachable from a browser.
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

export function createPipelineDb(supabase: Db): PipelineDb {
  return {
    async findPublishedSummaryByHash(contentHash) {
      // `works.content_hash` is the canonical identity of a source. Joining
      // through to a published summary in one query keeps the reuse decision to
      // a single round trip, because it sits directly in front of the only
      // expensive call in the product.
      const rows = must(
        await supabase
          .from('works')
          .select('id, summaries(id, status)')
          .eq('content_hash', contentHash)
          .limit(1),
        'find published summary by hash',
      ) as { id: string; summaries: { id: string; status: string }[] | null }[] | null;

      const work = rows?.[0];
      if (!work) return null;
      const published = (work.summaries ?? []).find((s) => s.status === 'published');
      return published ? { workId: work.id, summaryId: published.id } : null;
    },

    async upsertWork({ title, kind, contentHash, rightsStatus }) {
      const existing = must(
        await supabase.from('works').select('id').eq('content_hash', contentHash).limit(1),
        'look up work',
      ) as { id: string }[] | null;

      const found = existing?.[0];
      if (found) return { workId: found.id, existing: true };

      const slug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80) || 'untitled';

      const inserted = must(
        await supabase
          .from('works')
          .insert({
            title,
            kind,
            content_hash: contentHash,
            // Suffixed with part of the hash because `slug` is unique and two
            // different sources can easily share a title.
            slug: `${slug}-${contentHash.slice(0, 8)}`,
            // The status `resolve_identity` validated, not a literal. This used to
            // send `user_private`, which is not a member of `rights_status` — so
            // Postgres rejected the insert and no new source could ever reach
            // summary creation. The enum is the rights posture in `content-policy.md`
            // made unbypassable, and inventing a value defeats exactly that.
            rights_status: rightsStatus,
          })
          .select('id')
          .single(),
        'insert work',
      ) as { id: string };

      return { workId: inserted.id, existing: false };
    },

    async createSummary({
      workId,
      title,
      elevatorPitch,
      whyItMatters,
      sections,
      visibility,
      authorId,
    }) {
      const row = must(
        await supabase
          .from('summaries')
          .insert({
            work_id: workId,
            title,
            elevator_pitch: elevatorPitch,
            why_it_matters: whyItMatters,
            sections,
            // Draft until `publish`. A summary that is visible before the critic
            // and the rights gate have run is the one outcome this pipeline
            // exists to prevent.
            status: 'draft',
            visibility,
            // Who this was generated for, and the only thing that makes a
            // non-public summary readable at all: `summary_is_readable` grants
            // access when `status = 'published' and visibility = 'public'`, or
            // when `author_id = auth.uid()`. Jobs default to `private`, so a
            // summary written without this is one the person who asked for it
            // cannot open — the pipeline succeeding and the reader seeing
            // nothing.
            author_id: authorId,
          })
          .select('id')
          .single(),
        'insert summary',
      ) as { id: string };
      return row.id;
    },

    async insertPulls(summaryId, pulls) {
      if (pulls.length === 0) return [];

      const rows = must(
        await supabase
          .from('pulls')
          .upsert(
            pulls.map((p, ordinal) => ({
              summary_id: summaryId,
              ordinal,
              headline: p.headline,
              body: p.body,
              why_it_matters: p.whyItMatters,
            })),
            // `(summary_id, ordinal)` is unique. Upserting rather than inserting
            // makes a retry after a partial write converge instead of colliding
            // and failing the step permanently.
            { onConflict: 'summary_id,ordinal' },
          )
          .select('id, ordinal'),
        'insert pulls',
      ) as { id: string; ordinal: number }[] | null;

      return (rows ?? []).map((r) => ({ id: r.id, ordinal: r.ordinal }));
    },

    async setPullEmbeddings(rows) {
      // One statement per Pull: PostgREST cannot update distinct values across
      // rows in a single call, and an upsert would need every not-null column
      // restated. The counts here are tens, not thousands.
      for (const row of rows) {
        must(
          await supabase
            .from('pulls')
            .update({ embedding: row.embedding as unknown as string })
            .eq('id', row.id)
            .select('id'),
          'set pull embedding',
        );
      }
    },

    async publishSummary(summaryId) {
      must(
        await supabase
          .from('summaries')
          // `published_at` is not decoration: a check constraint refuses a
          // published row without one.
          .update({ status: 'published', published_at: new Date().toISOString() })
          .eq('id', summaryId)
          .select('id'),
        'publish summary',
      );
    },

    async attachSummaryToJob(jobId, summaryId, workId) {
      must(
        await supabase
          .from('generation_jobs')
          .update({ summary_id: summaryId, work_id: workId })
          .eq('id', jobId)
          .select('id'),
        'attach summary to job',
      );
    },
  };
}
