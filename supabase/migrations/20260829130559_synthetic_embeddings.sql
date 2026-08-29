-- Seed-time embeddings without an API key.
--
-- Round 1 ships no model providers, but the Delta, novelty scoring and semantic
-- neighbours are all vector operations — with NULL or random embeddings they
-- would be untestable or actively misleading.
--
-- So the seed builds embeddings from concept axes: each axis is a fixed
-- pseudo-random unit direction, and a pull's embedding is the normalised
-- weighted sum of its axes. Pulls that share concepts really are close in
-- cosine space, so the Delta behaves the way it will with real embeddings.
--
-- These are replaced by a real EmbeddingProvider in round 2. Nothing in the
-- read path knows or cares which kind it is looking at.
create or replace function public.synthetic_embedding(p_axes jsonb)
returns extensions.vector(1536)
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  dims  constant int := 1536;
  acc   double precision[] := array_fill(0.0::double precision, array[dims]);
  axis  record;
  d     int;
  norm  double precision := 0.0;
  parts text[];
begin
  -- p_axes: {"stoicism": 1.0, "habit": 0.4}
  for axis in select key, (value #>> '{}')::double precision as w from jsonb_each(p_axes)
  loop
    for d in 1 .. dims loop
      acc[d] := acc[d]
        + axis.w * (public.seeded_unit(hashtext(axis.key)::bigint, 0, d, 'axis') - 0.5);
    end loop;
  end loop;

  for d in 1 .. dims loop
    norm := norm + acc[d] * acc[d];
  end loop;
  norm := sqrt(greatest(norm, 1e-12));

  parts := array(select ((acc[d] / norm)::real)::text from generate_series(1, dims) d);
  return ('[' || array_to_string(parts, ',') || ']')::extensions.vector(1536);
end;
$$;

comment on function public.synthetic_embedding is
  'Seed-only: concept-axis embeddings so the Delta is demonstrable without an API key.';
