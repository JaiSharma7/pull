-- -----------------------------------------------------------------------------
-- Package 5b: Seed three curated learning paths that answer a question.
--
-- Paths:
--   1. what-is-actually-up-to-me (Stoicism)
--   2. should-every-opinion-be-heard (Liberty)
--   3. how-small-things-compound (Evolution)
--
-- Each path has five steps progressing from reading the core claim, predicting
-- the underlying mechanism, comparing against a related/opposing dialectic,
-- expressing it in the reader's own words (say_it_back), and applying it.
-- -----------------------------------------------------------------------------

do $$
declare
  t_stoicism  uuid;
  t_liberty   uuid;
  t_evolution uuid;

  p1_id uuid;
  p2_id uuid;
  p3_id uuid;

  -- Stoicism pulls
  ench_1 uuid;
  ench_2 uuid;
  ench_4 uuid;
  med_1  uuid;
  med_2  uuid;

  -- Liberty & Walden pulls
  lib_1  uuid;
  lib_3  uuid;
  lib_4  uuid;
  wald_1 uuid;
  wald_2 uuid;
  wald_3 uuid;

  -- Evolution pulls
  orig_1 uuid;
  orig_2 uuid;

begin
  -- Resolve topics
  select id into t_stoicism from public.topics where slug = 'stoicism';
  select id into t_liberty from public.topics where slug = 'liberty';
  select id into t_evolution from public.topics where slug = 'evolution';

  -- Resolve pulls by headline
  select id into ench_1 from public.pulls where headline like 'Some things are up to you%' limit 1;
  select id into ench_2 from public.pulls where headline like 'You are disturbed by your judgement%' limit 1;
  select id into ench_4 from public.pulls where headline like 'Rehearse the difficulty%' limit 1;
  select id into med_1  from public.pulls where headline like 'What blocks the way%' limit 1;
  select id into med_2  from public.pulls where headline like 'It is your opinion of the thing%' limit 1;

  select id into lib_1  from public.pulls where headline like 'Silencing an opinion robs%' limit 1;
  select id into lib_3  from public.pulls where headline like 'An unchallenged truth decays%' limit 1;
  select id into lib_4  from public.pulls where headline like 'Social pressure can coerce%' limit 1;
  select id into wald_1 from public.pulls where headline like 'The cost of a thing is the amount%' limit 1;
  select id into wald_2 from public.pulls where headline like 'Most luxuries are hindrances%' limit 1;
  select id into wald_3 from public.pulls where headline like 'Living deliberately is mostly deciding%' limit 1;

  select id into orig_1 from public.pulls where headline like 'Three conditions are enough%' limit 1;
  select id into orig_2 from public.pulls where headline like 'Very small advantages, compounded%' limit 1;

  if ench_1 is null or ench_2 is null or ench_4 is null or med_1 is null or med_2 is null or
     lib_1 is null or lib_3 is null or lib_4 is null or wald_1 is null or wald_2 is null or wald_3 is null or
     orig_1 is null or orig_2 is null then
    raise exception 'seed_three_learning_paths: could not resolve all required pull fixtures';
  end if;

  -- ===========================================================================
  -- Path 1: what-is-actually-up-to-me
  -- ===========================================================================
  insert into public.paths (slug, title, question, description, topic_id, status)
  values (
    'what-is-actually-up-to-me',
    'What is actually up to you?',
    'What is actually up to you?',
    'A five-step progression through the Stoic dichotomy of control, from establishing what is yours to turning obstacles into fuel.',
    t_stoicism,
    'published'
  )
  on conflict (slug) do update set
    title = excluded.title,
    question = excluded.question,
    description = excluded.description,
    topic_id = excluded.topic_id,
    status = excluded.status
  returning id into p1_id;

  insert into public.path_steps (path_id, ordinal, pull_id, kind, prompt, compare_pull_id)
  values
    (p1_id, 1, ench_1, 'read', 'Notice the sharp division Epictetus draws before asking yourself what you are holding today that is not yours to command.', null),
    (p1_id, 2, ench_2, 'predict', 'If external outcomes and other people''s actions are outside your command, where does disturbance actually originate?', null),
    (p1_id, 3, med_2,  'compare', 'How does Marcus Aurelius extend Epictetus''s insight from enduring misfortune into actively revoking the injury?', ench_2),
    (p1_id, 4, ench_4, 'say_it_back', 'Explain in your own words why premeditating difficulties in advance prevents panic when friction arrives.', null),
    (p1_id, 5, med_1,  'apply', 'Name one obstruction this week, and what it is now the material for.', null)
  on conflict (path_id, ordinal) do update set
    pull_id = excluded.pull_id,
    kind = excluded.kind,
    prompt = excluded.prompt,
    compare_pull_id = excluded.compare_pull_id;

  -- ===========================================================================
  -- Path 2: should-every-opinion-be-heard
  -- ===========================================================================
  insert into public.paths (slug, title, question, description, topic_id, status)
  values (
    'should-every-opinion-be-heard',
    'Should every opinion be heard?',
    'Should every opinion be heard?',
    'Examine John Stuart Mill''s case against silencing dissent and juxtapose it with Thoreau''s warning on the friction of social conformity.',
    t_liberty,
    'published'
  )
  on conflict (slug) do update set
    title = excluded.title,
    question = excluded.question,
    description = excluded.description,
    topic_id = excluded.topic_id,
    status = excluded.status
  returning id into p2_id;

  insert into public.path_steps (path_id, ordinal, pull_id, kind, prompt, compare_pull_id)
  values
    (p2_id, 1, lib_1,  'read', 'Consider why Mill insists that silencing an opinion robs the community even more than it injures the speaker.', null),
    (p2_id, 2, lib_3,  'predict', 'What happens to even a true and beneficial conviction when it is insulated from challenge and debate?', null),
    (p2_id, 3, wald_3, 'compare', 'Mill demands public openness to every debate, while Thoreau warns that deliberate living requires strict curation of attention. Where do their views collide?', lib_1),
    (p2_id, 4, lib_4,  'say_it_back', 'In your own words, why can informal social disapproval coerce conformity more powerfully than formal law?', null),
    (p2_id, 5, wald_2, 'apply', 'Name one opinion or habit you uphold mainly because peers expect it, and what portion of your life it consumes.', null)
  on conflict (path_id, ordinal) do update set
    pull_id = excluded.pull_id,
    kind = excluded.kind,
    prompt = excluded.prompt,
    compare_pull_id = excluded.compare_pull_id;

  -- ===========================================================================
  -- Path 3: how-small-things-compound
  -- ===========================================================================
  insert into public.paths (slug, title, question, description, topic_id, status)
  values (
    'how-small-things-compound',
    'How small things compound',
    'How do very small things do very large work?',
    'Trace the mathematics of cumulative advantage across deep evolutionary time and deliberate daily living.',
    t_evolution,
    'published'
  )
  on conflict (slug) do update set
    title = excluded.title,
    question = excluded.question,
    description = excluded.description,
    topic_id = excluded.topic_id,
    status = excluded.status
  returning id into p3_id;

  insert into public.path_steps (path_id, ordinal, pull_id, kind, prompt, compare_pull_id)
  values
    (p3_id, 1, orig_1, 'read', 'Observe how three mechanical conditions alone generate adaptive complexity across nature without design.', null),
    (p3_id, 2, orig_2, 'predict', 'How does an advantage too slight for a single generation to notice reshape the architecture of life over deep time?', null),
    (p3_id, 3, orig_2, 'compare', 'Both Darwin and Thoreau reckon with compounding across tiny margins. How does natural selection illuminate Thoreau''s daily trade of life for focus?', wald_1),
    (p3_id, 4, wald_1, 'say_it_back', 'State Thoreau''s economic metric in your own words: why measure value in exchanged life rather than money?', null),
    (p3_id, 5, wald_3, 'apply', 'Name one subtle daily choice you have compounded over the past year, and what large result it has produced.', null)
  on conflict (path_id, ordinal) do update set
    pull_id = excluded.pull_id,
    kind = excluded.kind,
    prompt = excluded.prompt,
    compare_pull_id = excluded.compare_pull_id;

end $$;
