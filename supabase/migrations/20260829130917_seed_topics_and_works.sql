-- Public-domain launch corpus.
--
-- Rights law (CLAUDE.md §4): every word below is original commentary about
-- public-domain works. No source text is reproduced. This is what lets the seed
-- live in an open repository at all.

insert into public.topics (slug, label) values
  ('philosophy', 'Philosophy'), ('psychology', 'Psychology'),
  ('science', 'Science'), ('society', 'Society')
on conflict (slug) do nothing;

insert into public.topics (slug, label, parent_id)
select v.slug, v.label, t.id
from (values
  ('stoicism', 'Stoicism', 'philosophy'),
  ('ethics', 'Ethics', 'philosophy'),
  ('habits', 'Habits', 'psychology'),
  ('attention', 'Attention', 'psychology'),
  ('physics', 'Physics', 'science'),
  ('evolution', 'Evolution', 'science'),
  ('liberty', 'Liberty', 'society'),
  ('economics', 'Economics', 'society')
) as v(slug, label, parent)
join public.topics t on t.slug = v.parent
on conflict (slug) do nothing;

insert into public.contributors (name, slug) values
  ('Epictetus', 'epictetus'),
  ('Marcus Aurelius', 'marcus-aurelius'),
  ('John Stuart Mill', 'john-stuart-mill'),
  ('Henry David Thoreau', 'henry-david-thoreau'),
  ('Charles Darwin', 'charles-darwin'),
  ('Albert Einstein', 'albert-einstein')
on conflict (slug) do nothing;

insert into public.works (kind, title, slug, year, description, rights_status,
                          quality_score, trust_score, external_ids) values
  ('book', 'The Enchiridion', 'the-enchiridion', 125,
   'A short handbook of Stoic practice, compiled from the teaching of Epictetus.',
   'public_domain', 0.88, 0.9, '{"gutenberg": 45109}'),
  ('book', 'Meditations', 'meditations', 180,
   'Private notes written by a Roman emperor to steady himself, never intended for publication.',
   'public_domain', 0.92, 0.9, '{"gutenberg": 2680}'),
  ('book', 'On Liberty', 'on-liberty', 1859,
   'An argument for individual freedom of thought and action, and for the limits of social power over the individual.',
   'public_domain', 0.9, 0.88, '{"gutenberg": 34901}'),
  ('book', 'Walden', 'walden', 1854,
   'A record of two years living simply at Walden Pond, and an argument about the true cost of things.',
   'public_domain', 0.84, 0.82, '{"gutenberg": 205}'),
  ('book', 'On the Origin of Species', 'on-the-origin-of-species', 1859,
   'The case for descent with modification through natural selection.',
   'public_domain', 0.94, 0.95, '{"gutenberg": 1228}'),
  ('book', 'Relativity: The Special and General Theory', 'relativity', 1916,
   'Einstein''s own attempt to explain relativity to readers without the mathematics.',
   'public_domain', 0.89, 0.93, '{"gutenberg": 30155}')
on conflict (slug) do nothing;

insert into public.editions (work_id, label, language, is_primary, year)
select w.id, 'Public-domain translation', 'en', true, w.year
from public.works w
where w.slug in ('the-enchiridion','meditations','on-liberty','walden',
                 'on-the-origin-of-species','relativity');

insert into public.work_contributors (work_id, contributor_id, role)
select w.id, c.id, 'author'
from (values
  ('the-enchiridion','epictetus'), ('meditations','marcus-aurelius'),
  ('on-liberty','john-stuart-mill'), ('walden','henry-david-thoreau'),
  ('on-the-origin-of-species','charles-darwin'), ('relativity','albert-einstein')
) as v(work, author)
join public.works w on w.slug = v.work
join public.contributors c on c.slug = v.author
on conflict do nothing;

insert into public.work_topics (work_id, topic_id, weight)
select w.id, t.id, v.weight
from (values
  ('the-enchiridion','stoicism',1.0), ('the-enchiridion','philosophy',0.8),
  ('meditations','stoicism',1.0), ('meditations','philosophy',0.8),
  ('meditations','ethics',0.5),
  ('on-liberty','liberty',1.0), ('on-liberty','society',0.8), ('on-liberty','ethics',0.6),
  ('walden','attention',0.7), ('walden','economics',0.5), ('walden','philosophy',0.6),
  ('on-the-origin-of-species','evolution',1.0), ('on-the-origin-of-species','science',0.9),
  ('relativity','physics',1.0), ('relativity','science',0.9)
) as v(work, topic, weight)
join public.works w on w.slug = v.work
join public.topics t on t.slug = v.topic
on conflict (work_id, topic_id) do nothing;

insert into public.summaries (work_id, edition_id, version, status, visibility, title,
                              elevator_pitch, why_it_matters, difficulty,
                              reading_minutes, published_at)
select w.id, e.id, 1, 'published', 'public', v.title, v.pitch, v.why,
       v.difficulty, v.minutes, now()
from (values
  ('the-enchiridion', 'The Enchiridion — the discipline of what is yours',
   'A handbook for separating what you control from what you do not, and acting only on the first.',
   'Almost every modern framework for anxiety and focus is a restatement of this one distinction.',
   0.3, 4),
  ('meditations', 'Meditations — notes to a mind under pressure',
   'A working ruler practising, in private, the habit of not being ruled by his own reactions.',
   'It shows philosophy as maintenance rather than doctrine — something done daily, badly, and repeatedly.',
   0.35, 5),
  ('on-liberty', 'On Liberty — why dissent is load-bearing',
   'The case that silencing an opinion damages the silencer more than the silenced.',
   'It is the sharpest argument for why a society that cannot be contradicted stops being able to think.',
   0.5, 5),
  ('walden', 'Walden — the true cost of things',
   'An accounting exercise: measure every purchase in the hours of life it took to earn.',
   'It reframes economy as a question about attention and time rather than money.',
   0.4, 4),
  ('on-the-origin-of-species', 'On the Origin of Species — the mechanism',
   'Variation, heredity, and differential survival are enough. Nothing else is required.',
   'One of the few ideas whose logical core can be stated in a sentence and still restructure a field.',
   0.55, 5),
  ('relativity', 'Relativity — what the observer brings',
   'If the speed of light is the same for everyone, simultaneity cannot be.',
   'It is the clearest case of a conclusion that feels impossible until you accept the premise.',
   0.7, 6)
) as v(work, title, pitch, why, difficulty, minutes)
join public.works w on w.slug = v.work
join public.editions e on e.work_id = w.id and e.is_primary;
