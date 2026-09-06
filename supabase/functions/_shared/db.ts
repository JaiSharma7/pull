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

/**
 * The `summaries.version` the pipeline writes, matching the column default.
 *
 * Named because it is half of the uniqueness key `(work_id, version, author_id)`
 * and the insert relies on the default rather than sending it. Adopting a row
 * after a collision has to match on the same value, and "1" appearing bare in a
 * query is the kind of thing that survives a schema change it should not.
 */
const SUMMARY_VERSION = 1;

function must<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    const e = result.error as { message?: string };
    throw new Error(`${what}: ${e.message ?? JSON.stringify(result.error)}`);
  }
  return result.data;
}

export function createPipelineDb(supabase: Db): PipelineDb {
  return {
    async findPublishedSummaryByHash(contentHash, requesterId) {
      // `works.content_hash` is the canonical identity of a source. Joining
      // through to a published summary in one query keeps the reuse decision to
      // a single round trip, because it sits directly in front of the only
      // expensive call in the product.
      const rows = must(
        await supabase
          .from('works')
          .select('id, summaries(id, status, visibility, author_id)')
          .eq('content_hash', contentHash)
          .limit(1),
        'find published summary by hash',
      ) as
        | {
            id: string;
            summaries:
              { id: string; status: string; visibility: string; author_id: string | null }[] | null;
          }[]
        | null;

      const work = rows?.[0];
      if (!work) return null;

      /*
       * Reuse only what this requester could actually read.
       *
       * Summaries are published with the job's visibility, which defaults to
       * `private`. Matching on `status = 'published'` alone meant the second
       * person to submit a given source adopted the first person's private
       * summary: the job skipped synthesis, reported success, and produced a
       * result `summary_is_readable` then refused to show them. A job that
       * succeeds and returns nothing is worse than one that fails, because
       * nothing anywhere records that something went wrong.
       *
       * This does not weaken the cost argument in law 2. What amortises across
       * thousands of readers is the *public* canonical summary, and that is
       * exactly the branch still taken here; a private summary was never
       * shareable, so declining to share it costs nothing that was ever real.
       */
      const reusable = (work.summaries ?? []).find(
        (s) =>
          s.status === 'published' &&
          (s.visibility === 'public' || (s.author_id !== null && s.author_id === requesterId)),
      );
      return reusable ? { workId: work.id, summaryId: reusable.id } : null;
    },

    async upsertWork({
      title,
      kind,
      contentHash,
      rightsStatus,
      topics,
      qualityScore,
      trustScore,
      sourceUrl,
      author,
    }) {
      /*
       * File a newly created work under its topics.
       *
       * Separate from the insert on purpose. `work_topics` is a join table with no
       * bearing on whether the summary is readable, so a failure here must not fail
       * a job that has already paid for synthesis — an unclassified work is a worse
       * feed position, while a failed job is nothing at all.
       *
       * Slugs are resolved rather than trusted: `narrowTopics` has already dropped
       * anything outside the mirrored taxonomy, and this drops anything the mirror
       * claims but the database has not actually been migrated to carry. That second
       * gap is real — the Edge Function deploys independently of the migration, so
       * for a window they disagree.
       *
       * Weight 1.0 for the first slug, 0.6 for the rest: `topic_affinity` multiplies
       * this by the reader's preference and takes the max, so the model's ordering
       * becomes primary-versus-secondary rather than being discarded.
       */
      const fileUnderTopics = async (workId: string, { onlyIfUnclassified = false } = {}) => {
        if (topics.length === 0) return;
        try {
          /*
           * An adopted work is filed only when it carries no classification at all.
           *
           * Both early returns below hand back a work this call did not create — a
           * reuse hit, or the loser of the `content_hash` race — and neither reached
           * this function before, so a work created by an older worker, or by a
           * winning invocation that died between the insert and the topic write,
           * stayed at `topic_affinity` = 0.0 for the life of the row with nothing
           * ever revisiting it.
           *
           * The guard is what keeps this from being worse than the gap it closes:
           * two jobs over one source produce two independent classifications, and
           * merging them would blend one model's ranking into another's, leaving a
           * work with two primaries and no way to tell which. First classification
           * wins; a later one declines rather than argues. Racy by construction, and
           * harmlessly so — the upsert's `on conflict do nothing` makes a lost race a
           * no-op rather than a duplicate.
           */
          if (onlyIfUnclassified) {
            const existingTopics = must(
              await supabase.from('work_topics').select('work_id').eq('work_id', workId).limit(1),
              'check existing classification',
            ) as { work_id: string }[] | null;
            if (existingTopics && existingTopics.length > 0) return;
          }

          const rows = must(
            await supabase.from('topics').select('id, slug').in('slug', topics),
            'look up topics',
          ) as { id: string; slug: string }[] | null;

          const bySlug = new Map((rows ?? []).map((r) => [r.slug, r.id]));
          /*
           * Weight is assigned *after* resolving, not from the model's index.
           *
           * Ranking off the original position looks equivalent and is not: if the
           * primary slug is one the database does not carry — the deploy-versus-
           * migration window this function's header anticipates — it is dropped, and
           * every surviving link is left at 0.6. The work then has no primary topic
           * at all and scores 40% under what it should in `topic_affinity`, quietly
           * and for as long as the row lives. Whichever topic survives first is the
           * most central one that actually exists, which is the honest answer.
           */
          const links = topics
            .map((slug) => bySlug.get(slug))
            .filter((id): id is string => Boolean(id))
            .map((topic_id, rank) => ({
              work_id: workId,
              topic_id,
              weight: rank === 0 ? 1.0 : 0.6,
            }));
          if (links.length === 0) return;

          // Ignores a duplicate rather than raising: two jobs can race onto the same
          // work through the 23505 adoption path below, and the second one filing the
          // same topics is a no-op, not an error.
          must(
            await supabase.from('work_topics').upsert(links, { onConflict: 'work_id,topic_id' }),
            'file work under topics',
          );
        } catch (e) {
          /*
           * Swallowed, but never silent.
           *
           * Classification is worth less than the summary it accompanies, so this
           * must not fail a job that has already paid for synthesis. But an
           * unclassified work is invisible in exactly the way that matters — the job
           * reports success, no step row records a problem, and the only symptom is a
           * work no reader's preferences can ever reach. Without this line the
           * difference between "the model returned no topics" and "the write failed"
           * is unrecoverable after the fact.
           */
          console.error(
            `work_topics: failed to file ${workId} under [${topics.join(', ')}]:`,
            e instanceof Error ? e.message : e,
          );
        }
      };

      /*
       * Credit the author, on the same terms as topic filing.
       *
       * Swallowed-but-logged for the same reason: attribution is worth less than the
       * summary it accompanies, so a failure here must not fail a job that has already
       * paid a provider. It is not silent, because a work with no author credited is
       * invisible in exactly the way that matters — the job reports success and the
       * only symptom is a source page that cannot say who wrote the thing.
       *
       * Applied to an adopted work as well as a new one, unlike topics. A second
       * classification can overwrite a first and there is no way to tell which was
       * right; a second author is either the same person, in which case
       * `attribute_work` is a no-op, or a genuinely missing credit worth adding.
       */
      const creditAuthor = async (workId: string) => {
        if (!author) return;
        try {
          const { error } = await supabase.rpc('attribute_work', {
            p_work_id: workId,
            p_author: author,
          } as never);
          if (error) throw new Error(error.message);
        } catch (e) {
          console.error(
            `attribute_work: failed to credit "${author}" on ${workId}:`,
            e instanceof Error ? e.message : e,
          );
        }
      };

      const existing = must(
        await supabase.from('works').select('id').eq('content_hash', contentHash).limit(1),
        'look up work',
      ) as { id: string }[] | null;

      /*
       * A canonical job re-scores the row it adopts; anything else leaves it
       * alone.
       *
       * Without this, gating the write on visibility would have made the
       * poisoning worse rather than better: a private job would create the row
       * with the column defaults, and the canonical generation that later
       * adopted it would decline to score it, so every pre-created work would
       * sit at 0.5 forever with no way to correct it.
       */
      /*
       * An adopted work gets a source URL if it has none.
       *
       * Only if it has none: overwriting would let a later job redirect an existing
       * work's outbound link, and that link is the thing law 4's argument rests on.
       * Filling an empty one is how the 102 works generated before this column existed
       * acquire a source without a separate backfill script for each new one.
       */
      const backfillSourceUrl = async (id: string) => {
        if (!sourceUrl) return;
        must(
          await supabase
            .from('works')
            .update({ source_url: sourceUrl } as never)
            .eq('id', id)
            .is('source_url', null),
          'backfill source url',
        );
      };

      const rescore = async (id: string) => {
        if (qualityScore === null || trustScore === null) return;
        must(
          await supabase
            .from('works')
            .update({ quality_score: qualityScore, trust_score: trustScore })
            .eq('id', id),
          'rescore adopted work',
        );
      };

      const found = existing?.[0];
      if (found) {
        await fileUnderTopics(found.id, { onlyIfUnclassified: true });
        await creditAuthor(found.id);
        await backfillSourceUrl(found.id);
        await rescore(found.id);
        return { workId: found.id, existing: true };
      }

      const slug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80) || 'untitled';

      const { data, error } = await supabase
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
          // Omitted entirely when null, so the column defaults stand, rather
          // than sent as null — both are `not null` with a 0.5 default, and an
          // explicit null would fail the insert rather than fall back.
          // `template` passes null for every job that is not publishing
          // canonically; see `upsertWork`'s interface for the attack that makes
          // that a boundary rather than a preference.
          ...(qualityScore === null ? {} : { quality_score: qualityScore }),
          ...(trustScore === null ? {} : { trust_score: trustScore }),
          // Where a reader can go and read the thing itself. Omitted rather than
          // nulled when absent, matching the scores above.
          ...(sourceUrl ? { source_url: sourceUrl } : {}),
        } as never)
        .select('id')
        .single();

      // The select above this insert is not a lock, so two jobs fingerprinting
      // the same source can both miss it. The unique index on `content_hash` is
      // what actually decides; losing that race is the index working, not an
      // error, and the loser adopts the winner's row.
      if (error) {
        if ((error as { code?: string }).code !== '23505') {
          throw new Error(`insert work: ${error.message}`);
        }
        const raced = must(
          await supabase.from('works').select('id').eq('content_hash', contentHash).single(),
          'adopt concurrently created work',
        ) as { id: string };
        await fileUnderTopics(raced.id, { onlyIfUnclassified: true });
        await creditAuthor(raced.id);
        await backfillSourceUrl(raced.id);
        await rescore(raced.id);
        return { workId: raced.id, existing: true };
      }

      const workId = (data as { id: string }).id;
      await fileUnderTopics(workId);
      await creditAuthor(workId);
      return { workId, existing: false };
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
      /*
       * `template` must be safe to run twice, and it was not.
       *
       * `summaries` is unique on `(work_id, version, author_id)`. If this insert
       * commits and the `attachSummaryToJob` after it fails — a lost response is
       * enough — the worker records the step as failed and retries the whole
       * step. The retry re-inserts the same key, collides, and collides again on
       * every remaining attempt, so the job fails permanently while an
       * unreachable draft is left behind. The same collision happens when two
       * jobs for one requester and one source both miss the reuse check and both
       * synthesise.
       *
       * Adopting on collision fixes both, because in both cases the existing row
       * is exactly the row this step was trying to create. `version` is not sent
       * and defaults to 1, so it is part of the key and is matched explicitly
       * here rather than left implied.
       */
      const insert = await supabase
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
        .single();

      if (insert.error) {
        if ((insert.error as { code?: string }).code !== '23505') {
          throw new Error(`insert summary: ${insert.error.message}`);
        }
        let adopt = supabase
          .from('summaries')
          .select('id')
          .eq('work_id', workId)
          .eq('version', SUMMARY_VERSION);
        // `.eq` on a null author_id would render as `author_id=eq.null` and match
        // nothing; the unique constraint treats nulls as distinct anyway, so a
        // collision here can only be a row that shares this author.
        adopt = authorId === null ? adopt.is('author_id', null) : adopt.eq('author_id', authorId);

        const existing = must(await adopt.single(), 'adopt existing summary') as { id: string };
        return existing.id;
      }

      return (insert.data as { id: string }).id;
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
              example: p.example ?? null,
              explanation: p.explanation ?? null,
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

    async insertQuizQuestions(rows) {
      if (rows.length === 0) return;
      must(
        await supabase
          .from('quiz_questions')
          .upsert(
            rows.map((r) => ({
              pull_id: r.pullId,
              prompt: r.prompt,
              answer: r.answer,
              distractors: r.distractors,
              // The kind the generation actually produced. Hardcoded `'recall'` until
              // 3g, which is why every row written before it is one — and why the
              // upsert target below has only ever had one row per pull to collide on.
              kind: r.kind,
              cloze: r.cloze,
              explanation: r.explanation,
              rationale: r.rationale,
            })),
            // `(pull_id, kind)`, which is what `quiz_questions_pull_kind_key`
            // actually is. `pull_id` alone raises 42P10 — there was no unique
            // constraint on it, and a fake PipelineDb accepts any conflict
            // target because it never reaches Postgres.
            //
            // Matches how `insertPulls` handles a retry: a step that partially
            // wrote and then failed must converge on a second run rather than
            // collide and fail permanently.
            { onConflict: 'pull_id,kind' },
          )
          .select('id'),
        'insert quiz questions',
      );
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

    async claimSourceHash(jobId, contentHash) {
      // 'claimed' or 'held'; the function's own comment says which takeovers are
      // legal. Anything else is a transport failure and is thrown as one.
      const verdict = must(
        await supabase.rpc('claim_source_hash', { p_job_id: jobId, p_hash: contentHash }),
        'claim source hash',
      ) as string;
      if (verdict !== 'claimed' && verdict !== 'held') {
        throw new Error(`claim source hash: unexpected verdict ${JSON.stringify(verdict)}`);
      }
      return verdict;
    },

    async releaseSourceHash(jobId) {
      must(await supabase.rpc('release_source_hash', { p_job_id: jobId }), 'release source hash');
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
