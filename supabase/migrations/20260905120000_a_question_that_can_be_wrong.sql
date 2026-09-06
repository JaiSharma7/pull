-- A question that can be wrong
--
-- Every question in the product today is free recall: a prompt, an answer, and a reader
-- deciding for themselves whether they had it. That is the cheapest kind to generate and
-- the weakest kind to learn from, because it cannot be wrong in a way anybody can name.
-- A multiple choice question with plausible distractors CAN be wrong specifically, and a
-- cloze can be wrong in one word — which is what makes an explanation worth writing and a
-- "confidently wrong" repair loop possible at all.
--
-- So this widens the question model in three directions and nothing else:
--
--   what a question IS       `kind`, constrained rather than free text
--   what it says when wrong  `explanation`, and `rationale` per distractor
--   what shape it takes      `cloze` for the sentence a word is removed from
--
-- The generation side (3g) and the screens (3d, 3e) follow in their own changes. This one
-- is the column and the contract.

-- ------------------------------------------------------------------ quiz_questions
--
-- `kind` has been plain `text not null default 'recall'` since round one, and the seed
-- and the pipeline have between them written four values into it. A check constraint is
-- added rather than an enum for the reason `20260901040000` gives about
-- `quiz_questions_pull_kind_key`: `kind` is part of a unique index the pipeline upserts
-- on, and an enum would make every future kind a two-migration dance (law 6 forbids
-- editing the first one) for no gain a check does not already give.
--
-- The six are the ones the product can actually grade. `ordering` and `scenario` are
-- generation-only and have no reader-facing writer, which is why `user_questions` keeps
-- its narrower four.
alter table public.quiz_questions
  add column explanation text,
  add column cloze       text,
  add column rationale   jsonb not null default '[]'::jsonb;

alter table public.quiz_questions
  add constraint quiz_questions_kind_known
    check (kind in ('recall', 'mcq', 'cloze', 'short_answer', 'ordering', 'scenario')),
  -- Bounded like every other authored column here: `explanation` is a paragraph, `cloze`
  -- is one sentence. Unbounded text on a table the pipeline writes is how one bad
  -- generation fills a page.
  add constraint quiz_questions_explanation_length
    check (explanation is null or length(explanation) <= 2000),
  add constraint quiz_questions_cloze_length
    check (cloze is null or length(cloze) <= 1000),
  -- Both jsonb columns are arrays or they are malformed. `distractors` has been
  -- `jsonb not null default '[]'` since round one with nothing asserting its shape, so a
  -- generation that returned an object put one there and `mcqOptions` would have iterated
  -- its keys.
  add constraint quiz_questions_distractors_shape
    check (jsonb_typeof(distractors) = 'array'),
  add constraint quiz_questions_rationale_shape
    check (jsonb_typeof(rationale) = 'array'),
  -- An MCQ with one option is not a choice. Two distractors plus the answer is the
  -- smallest thing worth rendering, and `mcqOptions` in `lib/activities.ts` deduplicates
  -- and drops blanks, so the floor has to be asserted where the row is stored rather than
  -- where it is displayed.
  add constraint quiz_questions_mcq_has_choices
    check (kind <> 'mcq' or jsonb_array_length(distractors) >= 2),
  -- A cloze without its sentence is a prompt with no blank in it.
  add constraint quiz_questions_cloze_has_sentence
    check (kind <> 'cloze' or (cloze is not null and length(btrim(cloze)) > 0));

comment on column public.quiz_questions.explanation is
  'Why the answer is the answer. Shown after answering, not before.';
comment on column public.quiz_questions.cloze is
  'The sentence a cloze removes a word from. Null for every other kind.';
comment on column public.quiz_questions.rationale is
  'Array of {distractor, why} — why each wrong option is wrong. Gemini has no map type.';

-- -------------------------------------------------------------------- user_questions
--
-- The reader's own questions gain the same two authored columns and NOT `rationale` or a
-- widened `kind`. A reader writes a question to be asked it; distractor rationale is a
-- generation artefact, and `ordering`/`scenario` have no screen that composes them. The
-- narrower set is the honest one, and widening it later is one more `add constraint`.
alter table public.user_questions
  add column explanation text,
  add column cloze       text;

alter table public.user_questions
  add constraint user_questions_explanation_length
    check (explanation is null or length(explanation) <= 2000),
  add constraint user_questions_cloze_length
    check (cloze is null or length(cloze) <= 1000),
  add constraint user_questions_cloze_has_sentence
    check (kind <> 'cloze' or cloze is null or length(btrim(cloze)) > 0);

comment on column public.user_questions.explanation is
  'The reader''s own note on why their answer is the answer.';
comment on column public.user_questions.cloze is
  'The sentence a reader''s cloze removes a word from.';

-- ----------------------------------------------------------------- get_due_reviews
--
-- ADDITIVE, deliberately. `question`, `questionId` and `questionSource` stay exactly as
-- they are, because `Review.tsx` reads them today and `scripts/smoke-read-path.sql`
-- asserts the top level is an array. A screen that renders by kind (3d) reads the new
-- `questions` array; nothing has to change on the same day this does.
--
-- And the three legacy fields are now DERIVED FROM the array rather than computed beside
-- it. That is the invariant 20260905110000 established after a review mutant made
-- `questionSource` say `user` while the prompt and id returned were the canonical ones:
-- there is one ordering, `questions[0]` is the head of it, and the legacy fields read off
-- that head. They cannot disagree because there is nothing left to disagree about.
--
-- The reader's own questions come first — all of their unretired ones, newest first, not
-- just one — then the canonical ones. `p_limit` is bounded here for the first time: it
-- was unbounded on `main` too, and a caller asking for twenty thousand due cards is a
-- caller building a page nobody reads.
create or replace function public.get_due_reviews(p_limit int default 20)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  lim   int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  res   jsonb;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(t order by t ->> 'retrievability'), '[]'::jsonb) into res
  from (
    select jsonb_build_object(
      'pullId', p.id,
      'headline', p.headline,
      'body', p.body,
      'whyItMatters', p.why_it_matters,
      -- The two the card already had and the read path never returned, which is why
      -- Review could not show an example after an answer even though one was generated.
      'example', p.example,
      'explanation', p.explanation,
      'workTitle', w.title,
      'workSlug', w.slug,
      -- Which cut of the work this pull belongs to. `summaries` is unique per
      -- (work, version, author), so this is what tells two generations of the same book
      -- apart -- there is no `content_version` column and never was.
      'contentVersion', s.version,
      'retrievability', round(public.retrievability(ks.stability, ks.last_seen_at)::numeric, 3),
      'stability', round(ks.stability::numeric, 2),
      'reps', ks.reps,
      -- How many times this idea has been forgotten. A card with lapses is a card the
      -- screen should treat differently from one that is merely due.
      'lapses', ks.lapses,
      'dueAt', ks.next_due_at,
      'questions', qs.items,
      -- Derived from the array above, never computed beside it. See the header.
      'question', qs.items -> 0 ->> 'prompt',
      'questionId', (qs.items -> 0 ->> 'id')::uuid,
      'questionSource', qs.items -> 0 ->> 'source'
    ) as t
    from public.knowledge_states ks
    join public.pulls p on p.id = ks.pull_id
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    left join lateral (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', q.id,
            'source', q.source,
            'kind', q.kind,
            'prompt', q.prompt,
            'answer', q.answer,
            'distractors', q.distractors,
            'cloze', q.cloze,
            'explanation', q.explanation,
            'rationale', q.rationale
          )
          order by q.rank, q.created_at desc
        ),
        '[]'::jsonb
      ) as items
      from (
        -- The reader's own, newest first. `rank` 0 is what puts them ahead.
        --
        -- `options` is this table's `distractors` -- same idea, named for the side that
        -- writes it -- and it is surfaced under the canonical name so a screen rendering
        -- an MCQ does not have to know which table the question came from. Reading `'[]'`
        -- here instead, as the first draft did, silently dropped every choice a reader
        -- had written and turned their own MCQ into a one-option question.
        select 0 as rank, uq.id, 'user' as source, uq.kind, uq.prompt, uq.answer,
               uq.options as distractors, uq.cloze, uq.explanation,
               -- No per-distractor rationale: a reader writes a question to be asked it,
               -- not to explain each wrong option to themselves.
               '[]'::jsonb as rationale, uq.created_at
          from public.user_questions uq
         where uq.user_id = uid and uq.pull_id = p.id and uq.retired_at is null
        union all
        select 1, qq.id, 'canonical', qq.kind, qq.prompt, qq.answer,
               qq.distractors, qq.cloze, qq.explanation, qq.rationale, qq.created_at
          from public.quiz_questions qq
         where qq.pull_id = p.id
      ) q
    ) qs on true
    where ks.user_id = uid and ks.next_due_at <= now()
    order by public.retrievability(ks.stability, ks.last_seen_at) asc
    limit lim
  ) x;

  return res;
end;
$$;

comment on function public.get_due_reviews is
  'The reader''s due ideas, each with every question available for it — their own first, then the canonical ones.';
