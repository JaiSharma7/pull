-- Idea Lineage and Counterpull edges, plus recall questions and today's picks.

-- Lineage. Marcus Aurelius had read Epictetus, so this is real intellectual
-- descent rather than a coincidence of phrasing — which is the point of the
-- mechanic: an idea has a history, not two independent inventors.
insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
select a.id, b.id, 'descendant', 0.9,
       'Marcus was a reader of Epictetus; this is the same claim, restated by a later Stoic.'
from public.pulls a
join public.summaries sa on sa.id = a.summary_id
join public.works wa on wa.id = sa.work_id and wa.slug = 'the-enchiridion'
join public.pulls b on b.headline like 'It is your opinion%'
where a.headline like 'You are disturbed by your judgement%'
on conflict do nothing;

insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
select b.id, a.id, 'ancestor', 0.9,
       'Traces back to the Enchiridion''s distinction between event and judgement.'
from public.pulls a
join public.summaries sa on sa.id = a.summary_id
join public.works wa on wa.id = sa.work_id and wa.slug = 'the-enchiridion'
join public.pulls b on b.headline like 'It is your opinion%'
where a.headline like 'You are disturbed by your judgement%'
on conflict do nothing;

-- Counterpull. A real tension, not a manufactured one: Mill wants you to engage
-- with every opinion including the ones you find worthless; Thoreau wants you to
-- ruthlessly curate what gets your attention at all. Both are defensible.
insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
select m.id, t.id, 'opposes', 0.75,
       'Mill argues for engaging with opinions you reject; Thoreau argues that attention is scarce and must be spent selectively. Both cannot be maximised.'
from public.pulls m
join public.summaries sm on sm.id = m.summary_id
join public.works wm on wm.id = sm.work_id and wm.slug = 'on-liberty'
join public.pulls t on t.headline like 'Living deliberately%'
where m.headline like 'Silencing an opinion%'
on conflict do nothing;

insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
select t.id, m.id, 'opposes', 0.75,
       'Thoreau treats attention as the scarce resource; Mill treats exposure to opposing views as an obligation.'
from public.pulls m
join public.summaries sm on sm.id = m.summary_id
join public.works wm on wm.id = sm.work_id and wm.slug = 'on-liberty'
join public.pulls t on t.headline like 'Living deliberately%'
where m.headline like 'Silencing an opinion%'
on conflict do nothing;

-- Compounding shows up in two fields; that connection is worth surfacing.
insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
select d.id, w.id, 'related', 0.6,
       'Both turn on the same failure of intuition about small quantities accumulating over long intervals.'
from public.pulls d
join public.pulls w on w.headline like 'The cost of a thing%'
where d.headline like 'Very small advantages%'
on conflict do nothing;

insert into public.quiz_questions (pull_id, prompt, answer, kind)
select p.id, v.prompt, v.answer, 'recall'
from (values
  ('Some things are up to you%',
   'What is the practical purpose of separating what you control from what you do not?',
   'It is a filter for where to spend effort: effort spent on what you do not control is spent at a loss.'),
  ('You are disturbed by your judgement%',
   'Why does locating distress in the judgement rather than the event give you leverage?',
   'Because the judgement is nearer to hand than the event — it is the part you can actually reach and revise.'),
  ('Silencing an opinion%',
   'Why does Mill say suppression harms the suppressor even when the suppressed opinion is false?',
   'Because defeating a false view is what turns a true belief into an understood one; without the challenge you keep the conclusion and lose the reasons.'),
  ('The cost of a thing%',
   'How does Thoreau propose you measure the cost of a purchase?',
   'In the hours of life required to earn it, plus the hours spent maintaining and worrying about it.'),
  ('Three conditions are enough%',
   'What three conditions make natural selection inevitable?',
   'Variation between individuals, heredity of some of that variation, and its effect on survival or reproduction.'),
  ('If light''s speed is the same%',
   'Why does a fixed speed of light force simultaneity to be observer-dependent?',
   'Because holding light''s speed constant for all observers means a shared "now" is the thing that has to give way.')
) as v(pattern, prompt, answer)
join public.pulls p on p.headline like v.pattern;

-- Today's curated picks. Deepstash charges for "handpicked ideas"; this is one
-- editorial query shared by every reader, so giving it away costs nothing.
insert into public.daily_pulls (day, ordinal, pull_id, curator, blurb)
select current_date, v.ordinal, p.id, 'editorial', v.blurb
from (values
  (1, 'What blocks the way%', 'On turning an interruption into the next action.'),
  (2, 'An unchallenged truth%', 'Why agreeing with you for bad reasons is not much help.'),
  (3, 'Very small advantages%', 'The arithmetic intuition that fails almost everyone.'),
  (4, 'Most luxuries are hindrances%', 'An accounting test most purchases fail.'),
  (5, 'Standing on the ground%', 'A thought experiment with no apparatus that produced a theory.')
) as v(ordinal, pattern, blurb)
join public.pulls p on p.headline like v.pattern
on conflict (day, ordinal) do nothing;
