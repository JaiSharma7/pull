-- A single human can approve a Delta relation after recording evidence.
-- A one-reviewer equivalence also needs an explicit review note because it
-- can hide a candidate. Assistant critique is not a second reviewer.
alter table public.delta_relations drop constraint delta_relations_approval;
alter table public.delta_relations add constraint delta_relations_approval check (
  status <> 'approved' or (
    kind in ('equivalent', 'opposes', 'related')
    and reviewed_at is not null
    and nullif(btrim(coalesce(evidence, '')), '') is not null
    and nullif(btrim(provenance), '') is not null
    and cardinality(reviewer_refs) between 1 and 2
    and nullif(btrim(reviewer_refs[1]), '') is not null
    and (cardinality(reviewer_refs) = 1 or (
      nullif(btrim(reviewer_refs[2]), '') is not null
      and reviewer_refs[1] <> reviewer_refs[2]
    ))
    and (kind <> 'equivalent' or cardinality(reviewer_refs) = 2
      or nullif(btrim(coalesce(review_note, '')), '') is not null)
  )
);
comment on constraint delta_relations_approval on public.delta_relations is
  'One documented human review is allowed. A single-reviewer equivalence also requires an explicit review note; assistant critique is not a second reviewer.';
