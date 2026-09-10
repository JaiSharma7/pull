/*
 * Every kind gets asked.
 *
 * 20260905120002 put a `rank` term -- `(qq.kind <> 'recall')::int` -- into the
 * `jsonb_agg` that assembles a due card's `questions` array, so that a recall question
 * always came first. Its header says why: "two of the three kinds have no renderer
 * until 3d lands", and `Review.tsx` at the time rendered `questions -> 0` as a prompt
 * with a Reveal button, so an mcq or a cloze drawn first was a question the screen
 * could not ask. The term was written to be temporary, and the header said as much:
 * "3d reads the array by kind and ignores the order entirely, at which point this
 * clause costs nothing and stops mattering."
 *
 * 3d landed as #94. Both screens now render by kind. And the clause did not stop
 * mattering, because `resolveActiveQuestion` takes `questions[0]` and a card leaves
 * the page once it is graded -- so with recall pinned to element 0, every mcq and
 * cloze seeded for the round-one corpus in 20260908010000 was unreachable. The guard
 * now did exactly the harm it was written to prevent.
 *
 * So the rank term goes. What stays is everything the header of 20260905120002 fought
 * for: BOTH `limit 3` cuts still cut by recency (the reader's own first, then the
 * newest canonical), the `id` term still makes the order total, and the array is
 * still `own desc, written_at desc, qid`. The clause is not moved anywhere else -- it
 * was never a ranking of kinds, and now nothing is. Which of the survivors is asked
 * is the client's decision (`chooseQuestion` in `lib/review-question.ts`), rotated
 * by how often the reader has met the idea, so every kind on the card gets its turn.
 *
 * DO NOT REINSTATE IT. If a future kind arrives before its renderer, the right place
 * to hold it back is the client's `resolveEffectiveKind`, which already degrades an
 * unrenderable question to free recall on screen. Pinning at the source starves every
 * other kind for every reader.
 *
 * AND ONE MORE, found while confirming the above. The outer aggregate was
 * `jsonb_agg(t order by t ->> 'retrievability')`, and `->>` yields TEXT, so the page
 * was sorted lexically. It has been ordering correctly by accident: the value is
 * `round(..., 3)` of a number in [0, 1], and at a fixed width of three decimals the
 * lexical order of '0.050', '0.100' and '0.500' is the numeric one. Change the
 * rounding, or let a value out of that range, and the most forgotten idea stops
 * coming first. The inner `due` subquery insists on numeric ordering for exactly this
 * reason; the outer one now does too, and ties break on `pullId` as the inner one
 * breaks on `pull_id`, so the array is a total order in the same terms as the cut.
 *
 * WHY THE WHOLE FUNCTION IS RESTATED. Migrations are append-only (law 6), so a change
 * to a `create or replace` function is a new file carrying the whole body. Everything
 * below is 20260905120002's function verbatim except the two lines this header
 * describes; diff the two before reviewing it. The ACL is restated for the reason
 * that file gives.
 */

create or replace function public.get_due_reviews(p_limit int default 20)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  lim   int  := greatest(1, least(100, coalesce(p_limit, 20)));
  res   jsonb;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  -- Numeric, not lexical: `->>` is text. See the header.
  select coalesce(
           jsonb_agg(t order by (t ->> 'retrievability')::numeric, t ->> 'pullId'),
           '[]'::jsonb
         ) into res
  from (
    select jsonb_build_object(
      'pullId', due.pull_id,
      'headline', due.headline,
      'body', due.body,
      'whyItMatters', due.why_it_matters,
      'example', due.example,
      'explanation', due.explanation,
      'workTitle', due.work_title,
      'workSlug', due.work_slug,
      'contentVersion', due.content_version,
      'retrievability', round(public.retrievability(due.stability, due.last_seen_at)::numeric, 3),
      'stability', round(due.stability::numeric, 2),
      'difficulty', round(due.difficulty::numeric, 2),
      'lapses', due.lapses,
      'reps', due.reps,
      'dueAt', due.next_due_at,
      'questions', asked.questions,
      -- Derived from the array, never computed beside it. With no kind pinned first,
      -- these name the newest question on the card -- the reader's own if they wrote
      -- one, else the newest canonical. The screens choose among the array; these
      -- three exist for anything that still reads one question.
      'question', asked.questions -> 0 ->> 'prompt',
      'questionId', (asked.questions -> 0 ->> 'id')::uuid,
      'questionSource', asked.questions -> 0 ->> 'source'
    ) as t
    -- The due set is chosen and trimmed first, with the visibility joins inside the
    -- limit. The account of why is in 20260905120002 and is unchanged here.
    from (
      select ks.stability, ks.difficulty, ks.reps, ks.lapses, ks.last_seen_at,
             ks.next_due_at,
             p.id as pull_id, p.headline, p.body, p.why_it_matters, p.example,
             p.explanation,
             w.title as work_title, w.slug as work_slug,
             s.version as content_version
        from public.knowledge_states ks
        join public.pulls p on p.id = ks.pull_id
        join public.summaries s on s.id = p.summary_id
        join public.works w on w.id = s.work_id
       where ks.user_id = uid and ks.next_due_at <= now()
       order by public.retrievability(ks.stability, ks.last_seen_at) asc, ks.pull_id
       limit lim
    ) due
    -- The reader's own first, then the canonical ones, each branch bounded, the
    -- union bounded, the order total. Unchanged from 20260905120002 except that the
    -- `rank` column is gone from the aggregate's ORDER BY -- and from the branches,
    -- since nothing reads it now.
    left join lateral (
      select coalesce(jsonb_agg(q.j order by q.own desc, q.written_at desc, q.qid),
                      '[]'::jsonb) as questions
        from (
          (
            select 0 as own, uq.created_at as written_at, uq.id as qid,
                   jsonb_build_object(
                     'id', uq.id,
                     'source', 'user',
                     'kind', uq.kind,
                     'prompt', uq.prompt,
                     'answer', uq.answer,
                     'distractors', uq.options,
                     'cloze', uq.cloze,
                     'explanation', uq.explanation,
                     'rationale', '[]'::jsonb
                   ) as j
              from public.user_questions uq
             where uq.user_id = uid and uq.pull_id = due.pull_id
               and uq.retired_at is null
             order by uq.created_at desc, uq.id
             limit 3
          )
          union all
          (
            select -1, qq.created_at, qq.id,
                   jsonb_build_object(
                     'id', qq.id,
                     'source', 'canonical',
                     'kind', qq.kind,
                     'prompt', qq.prompt,
                     'answer', qq.answer,
                     'distractors', qq.distractors,
                     'cloze', qq.cloze,
                     'explanation', qq.explanation,
                     'rationale', qq.rationale
                   )
              from public.quiz_questions qq
             where qq.pull_id = due.pull_id
             order by qq.created_at desc, qq.id
             limit 3
          )
          order by 1 desc, 2 desc, 3
          limit 3
        ) q
    ) asked on true
  ) x;

  return res;
end;
$$;

revoke all on function public.get_due_reviews(int) from public, anon;
grant execute on function public.get_due_reviews(int) to authenticated;

comment on function public.get_due_reviews is
  'The reader''s due ideas, most forgotten first, each with up to three questions -- their own first, then the newest canonical ones, no kind pinned ahead of another.';
