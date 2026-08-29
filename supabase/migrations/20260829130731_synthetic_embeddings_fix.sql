-- Fix: the generate_series alias `d` shadowed the plpgsql loop variable `d`,
-- so the final projection could not resolve the column reference.
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
  ix    int;
  norm  double precision := 0.0;
  parts text[];
begin
  for axis in select key, (value #>> '{}')::double precision as w from jsonb_each(p_axes)
  loop
    for ix in 1 .. dims loop
      acc[ix] := acc[ix]
        + axis.w * (public.seeded_unit(hashtext(axis.key)::bigint, 0, ix, 'axis') - 0.5);
    end loop;
  end loop;

  for ix in 1 .. dims loop
    norm := norm + acc[ix] * acc[ix];
  end loop;
  norm := sqrt(greatest(norm, 1e-12));

  parts := array(
    select ((acc[gs.n] / norm)::real)::text
    from generate_series(1, dims) as gs(n)
  );
  return ('[' || array_to_string(parts, ',') || ']')::extensions.vector(1536);
end;
$$;

comment on function public.synthetic_embedding is
  'Seed-only: concept-axis embeddings so the Delta is demonstrable without an API key.';
