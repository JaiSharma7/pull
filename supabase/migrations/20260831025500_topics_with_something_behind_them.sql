-- A taxonomy a reader can actually choose from, and a default that does not hide
-- a fifth of the corpus.
--
-- Two independent defects, fixed together because both are preconditions for the
-- same thing: letting a reader say what they want to learn about.
--
--
-- 1. TWELVE TOPICS IS NOT A PICKER
--
-- `topic_affinity` is 28% of the score in `get_feed` and it reads
-- `preference_profiles.topic_weights` keyed by `topics.slug`. There are twelve
-- topics today and two of them — `psychology` and `habits` — have no works at
-- all, so a picker built on this offers a reader a choice that resolves to an
-- empty feed. That is worse than offering no choice.
--
-- The additions are chosen against the corpus that is actually being generated
-- (public-domain essays, lectures and papers), not against a general-purpose
-- ontology. A topic nothing can ever fill is the defect being fixed, not a
-- template to add more of.
--
-- Rows, not schema: no column changes, so `packages/db/src/database.types.ts`
-- does not move and CI check 4's staleness diff cannot fire on this.
--
-- Existing slugs are never renamed. `work_topics` references them, and
-- `topic_weights` is keyed by slug in every profile already written.
--
--
-- 2. `media_kinds` SILENTLY EXCLUDED EVERY LECTURE
--
-- The default was '{book,film,documentary,podcast,paper,essay}' and `get_feed`
-- filters its pool on `w.kind = any(media)`. The seed manifest is 27 essays,
-- 7 lectures, 3 papers and 1 book — so seven of thirty-eight sources would be
-- fetched, summarised, embedded, paid for, published, and then invisible to
-- every reader holding the default.
--
-- Nothing errors. The rows exist, the cost is real, and the feed simply never
-- mentions them. `video` and `interview` are added for the same reason before
-- the corpus reaches them.
--
-- The update is guarded to rows still holding the exact superseded default, so
-- a reader who has chosen their own media set keeps it. Widening someone's
-- stated preference without asking is the same class of error as narrowing it.

-- ---------------------------------------------------------------------------
-- 1. Topics
-- ---------------------------------------------------------------------------

insert into public.topics (slug, label, parent_id)
values ('arts-and-letters', 'Arts and Letters', null),
       ('history', 'History', null)
on conflict (slug) do nothing;

insert into public.topics (slug, label, parent_id)
select v.slug, v.label, p.id
from (values
        ('logic',       'Logic',        'philosophy'),
        ('metaphysics', 'Metaphysics',  'philosophy'),
        ('aesthetics',  'Aesthetics',   'philosophy'),
        ('learning',    'Learning',     'psychology'),
        ('emotion',     'Emotion',      'psychology'),
        ('chemistry',   'Chemistry',    'science'),
        ('astronomy',   'Astronomy',    'science'),
        ('medicine',    'Medicine',     'science'),
        ('government',  'Government',   'society'),
        ('justice',     'Justice',      'society'),
        ('education',   'Education',    'society'),
        ('literature',  'Literature',   'arts-and-letters'),
        ('rhetoric',    'Rhetoric',     'arts-and-letters'),
        ('criticism',   'Criticism',    'arts-and-letters'),
        ('biography',   'Biography',    'history'),
        ('revolutions', 'Revolutions',  'history')
     ) as v(slug, label, parent_slug)
join public.topics p on p.slug = v.parent_slug
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. media_kinds
-- ---------------------------------------------------------------------------

alter table public.preference_profiles
  alter column media_kinds set default
    '{book,film,documentary,podcast,paper,essay,lecture,video,interview}'::public.work_kind[];

-- Only rows that never chose. An equality test against the superseded literal is
-- the whole guard: a reader who edited their media set does not match it, and a
-- reader who happened to re-select exactly the old set is indistinguishable from
-- one who never chose — and is served better by the wider default either way.
update public.preference_profiles
   set media_kinds = '{book,film,documentary,podcast,paper,essay,lecture,video,interview}'::public.work_kind[]
 where media_kinds = '{book,film,documentary,podcast,paper,essay}'::public.work_kind[];

comment on column public.preference_profiles.media_kinds is
  'Media a reader will be shown. get_feed filters its pool on w.kind = any(this), '
  'so a kind absent here is generated, paid for and never seen. Add a work_kind to '
  'this default in the same migration that makes the pipeline able to produce it.';
