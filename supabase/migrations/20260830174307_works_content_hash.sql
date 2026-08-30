-- The column the reuse check has been querying against a table that never had it.
--
-- `acquire` fingerprints the source text and asks `findPublishedSummaryByHash` whether
-- this exact source has already been summarised. That question is the whole economic
-- argument of the product: one canonical generation serves every reader at ~$0.056,
-- while regenerating per reader costs ~$56 per thousand. It only saves anything if it
-- is asked *before* the expensive call — which is why it sits in `acquire` rather than
-- after synthesis.
--
-- It was being asked of `works.content_hash`, which did not exist. PostgREST rejects a
-- filter on an unknown column, so every generation job failed at `acquire` and burned
-- all three attempts. That is why the hosted project has zero generation jobs: not
-- because none were tried, but because none could survive their first step.
--
-- Nullable, because the six seeded public-domain works were created by hand from
-- migrations and have no source text to fingerprint. A hash is what an *ingested*
-- source has, not what every work must have.
--
-- The uniqueness is partial for the same reason: `where content_hash is not null` lets
-- the seeded rows coexist while still guaranteeing that two ingests of one source
-- converge on one work. Without the constraint the reuse lookup would be a race —
-- two jobs fingerprinting the same text concurrently would both miss and both generate.

alter table public.works
  add column if not exists content_hash text;

comment on column public.works.content_hash is
  'SHA-256 of the source text this work was ingested from. Null for works seeded by hand. The key the generation pipeline reuses on, so one source is summarised once.';

-- Also the index that makes the lookup a seek rather than a scan. It sits directly in
-- front of the only expensive call in the product, so it runs on every ingest.
create unique index if not exists works_content_hash_key
  on public.works (content_hash)
  where content_hash is not null;
