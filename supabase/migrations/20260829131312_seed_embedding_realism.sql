-- The two "judgement" pulls were given identical concept axes, so their vectors
-- came out identical (cosine distance exactly 0). That makes the Delta look
-- better than it is: real embeddings of two differently-worded statements are
-- close, never identical. Perturb the later one so the near-duplicate test is
-- honest.
update public.pulls
set embedding = public.synthetic_embedding(
  '{"judgement":1.0,"stoicism":0.5,"agency":0.3,"power":0.2}'::jsonb
)
where headline like 'It is your opinion%';

-- Give the other same-axis families a little separation too, for the same reason.
update public.pulls
set embedding = public.synthetic_embedding(
  '{"simplicity":1.0,"economics":0.4,"time":0.35}'::jsonb
)
where headline like 'The cost of a thing%';
