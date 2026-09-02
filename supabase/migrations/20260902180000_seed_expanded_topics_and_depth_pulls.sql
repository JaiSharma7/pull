-- Expanded corpus across diverse disciplines with multi-depth pulls.
--
-- Rights law (CLAUDE.md §4): original commentary and analysis of public-domain works.
-- No copyrighted text or translations reproduced.
--
-- Every pull seeded below populates all four text depth stops:
--   1. headline       (Shortest: atomic claim)
--   2. body           (Short: core argument in 1-3 sentences)
--   3. why_it_matters + example (Medium: consequence + concrete grounding)
--   4. explanation    (Long: in full, causal mechanism and analytical depth)
--   5. source link    (Terminus: direct link to public-domain original)

-- -----------------------------------------------------------------------------
-- 1. Topics
-- -----------------------------------------------------------------------------

insert into public.topics (slug, label, parent_id) values
  ('mathematics', 'Mathematics', null)
on conflict (slug) do nothing;

insert into public.topics (slug, label, parent_id)
select v.slug, v.label, t.id
from (values
  ('computation', 'Computation', 'mathematics'),
  ('architecture', 'Architecture', 'arts-and-letters'),
  ('world-philosophy', 'World Philosophy', 'philosophy'),
  ('strategy', 'Strategy', 'society'),
  ('ecology', 'Ecology', 'science')
) as v(slug, label, parent)
join public.topics t on t.slug = v.parent
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Contributors
-- -----------------------------------------------------------------------------

insert into public.contributors (name, slug) values
  ('Ada Lovelace', 'ada-lovelace'),
  ('Lewis Carroll', 'lewis-carroll'),
  ('Sun Tzu', 'sun-tzu'),
  ('Laozi', 'laozi'),
  ('Vitruvius', 'vitruvius'),
  ('Mary Wollstonecraft', 'mary-wollstonecraft'),
  ('William Kingdon Clifford', 'william-kingdon-clifford'),
  ('Bertrand Russell', 'bertrand-russell'),
  ('Edgar Allan Poe', 'edgar-allan-poe'),
  ('Adam Smith', 'adam-smith')
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Works
-- -----------------------------------------------------------------------------

insert into public.works (kind, title, slug, year, description, rights_status,
                          quality_score, trust_score, source_url) values
  ('paper', 'Sketch of the Analytical Engine', 'sketch-of-the-analytical-engine', 1843,
   'Lovelace''s foundational notes conceiving general-purpose algorithmic computation beyond mere arithmetic calculation.',
   'public_domain', 0.96, 0.95,
   'https://en.wikisource.org/wiki/Scientific_Memoirs/3/Sketch_of_the_Analytical_Engine_invented_by_Charles_Babbage,_Esq./Notes_by_the_Translator'),

  ('essay', 'What the Tortoise Said to Achilles', 'what-the-tortoise-said-to-achilles', 1895,
   'A dialogue demonstrating that rules of inference cannot themselves be inserted as premises without infinite regress.',
   'public_domain', 0.93, 0.92,
   'https://en.wikisource.org/wiki/What_the_Tortoise_Said_to_Achilles'),

  ('book', 'The Art of War', 'the-art-of-war', -500,
   'An ancient treatise on strategic leverage, information asymmetry, and winning without destruction.',
   'public_domain', 0.95, 0.94,
   'https://en.wikisource.org/wiki/The_Art_of_War_(Sun)'),

  ('book', 'Tao Te Ching', 'tao-te-ching', -400,
   'A philosophical text on wu wei (effortless action), flexibility over rigidity, and governing by restraint.',
   'public_domain', 0.94, 0.93,
   'https://en.wikisource.org/wiki/Tao_Te_Ching_(James_Legge)'),

  ('book', 'Ten Books on Architecture', 'ten-books-on-architecture', -15,
   'The classical treatise establishing firmitas, utilitas, and venustas (durability, utility, beauty) as design criteria.',
   'public_domain', 0.91, 0.90,
   'https://en.wikisource.org/wiki/Ten_Books_on_Architecture/Book_I'),

  ('essay', 'A Vindication of the Rights of Woman', 'a-vindication-of-the-rights-of-woman', 1792,
   'The foundational argument that virtue and rationality require intellectual independence and equal education.',
   'public_domain', 0.93, 0.91,
   'https://en.wikisource.org/wiki/A_Vindication_of_the_Rights_of_Woman/Chapter_II'),

  ('essay', 'The Ethics of Belief', 'the-ethics-of-belief', 1877,
   'The moral argument that believing anything upon insufficient evidence is an offense against society.',
   'public_domain', 0.92, 0.92,
   'https://en.wikisource.org/wiki/The_Ethics_of_Belief'),

  ('essay', 'The Problems of Philosophy: On Induction', 'problems-of-philosophy-induction', 1912,
   'Russell''s analysis of whether past uniformities provide any logical guarantee of future continuity.',
   'public_domain', 0.92, 0.93,
   'https://en.wikisource.org/wiki/The_Problems_of_Philosophy/Chapter_6'),

  ('essay', 'The Philosophy of Composition', 'the-philosophy-of-composition', 1846,
   'Poe''s declaration of reverse-engineering artistic effect, rejecting pure intuition in favor of deliberate craftsmanship.',
   'public_domain', 0.90, 0.89,
   'https://en.wikisource.org/wiki/The_Philosophy_of_Composition'),

  ('essay', 'The Wealth of Nations: Of the Division of Labour', 'wealth-of-nations-division-of-labour', 1776,
   'Smith''s classic demonstration of specialization, coordination, and productive compounding.',
   'public_domain', 0.94, 0.94,
   'https://en.wikisource.org/wiki/The_Wealth_of_Nations/Book_I/Chapter_1')
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------
-- 4. Editions & Contributors
-- -----------------------------------------------------------------------------

insert into public.editions (work_id, label, language, is_primary, year)
select w.id, 'Public-domain source', 'en', true, w.year
from public.works w
where w.slug in (
  'sketch-of-the-analytical-engine',
  'what-the-tortoise-said-to-achilles',
  'the-art-of-war',
  'tao-te-ching',
  'ten-books-on-architecture',
  'a-vindication-of-the-rights-of-woman',
  'the-ethics-of-belief',
  'problems-of-philosophy-induction',
  'the-philosophy-of-composition',
  'wealth-of-nations-division-of-labour'
)
on conflict do nothing;

insert into public.work_contributors (work_id, contributor_id, role)
select w.id, c.id, 'author'
from (values
  ('sketch-of-the-analytical-engine', 'ada-lovelace'),
  ('what-the-tortoise-said-to-achilles', 'lewis-carroll'),
  ('the-art-of-war', 'sun-tzu'),
  ('tao-te-ching', 'laozi'),
  ('ten-books-on-architecture', 'vitruvius'),
  ('a-vindication-of-the-rights-of-woman', 'mary-wollstonecraft'),
  ('the-ethics-of-belief', 'william-kingdon-clifford'),
  ('problems-of-philosophy-induction', 'bertrand-russell'),
  ('the-philosophy-of-composition', 'edgar-allan-poe'),
  ('wealth-of-nations-division-of-labour', 'adam-smith')
) as v(work, author)
join public.works w on w.slug = v.work
join public.contributors c on c.slug = v.author
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 5. Work Topics
-- -----------------------------------------------------------------------------

insert into public.work_topics (work_id, topic_id, weight)
select w.id, t.id, v.weight
from (values
  ('sketch-of-the-analytical-engine', 'computation', 1.0),
  ('sketch-of-the-analytical-engine', 'mathematics', 0.8),
  ('sketch-of-the-analytical-engine', 'logic', 0.6),

  ('what-the-tortoise-said-to-achilles', 'logic', 1.0),
  ('what-the-tortoise-said-to-achilles', 'mathematics', 0.8),
  ('what-the-tortoise-said-to-achilles', 'philosophy', 0.6),

  ('the-art-of-war', 'strategy', 1.0),
  ('the-art-of-war', 'society', 0.8),
  ('the-art-of-war', 'world-philosophy', 0.7),

  ('tao-te-ching', 'world-philosophy', 1.0),
  ('tao-te-ching', 'philosophy', 0.9),
  ('tao-te-ching', 'ethics', 0.6),

  ('ten-books-on-architecture', 'architecture', 1.0),
  ('ten-books-on-architecture', 'arts-and-letters', 0.8),
  ('ten-books-on-architecture', 'aesthetics', 0.7),

  ('a-vindication-of-the-rights-of-woman', 'justice', 1.0),
  ('a-vindication-of-the-rights-of-woman', 'liberty', 0.9),
  ('a-vindication-of-the-rights-of-woman', 'education', 0.8),

  ('the-ethics-of-belief', 'ethics', 1.0),
  ('the-ethics-of-belief', 'philosophy', 0.8),
  ('the-ethics-of-belief', 'society', 0.6),

  ('problems-of-philosophy-induction', 'logic', 1.0),
  ('problems-of-philosophy-induction', 'philosophy', 0.9),
  ('problems-of-philosophy-induction', 'learning', 0.7),

  ('the-philosophy-of-composition', 'criticism', 1.0),
  ('the-philosophy-of-composition', 'aesthetics', 0.8),
  ('the-philosophy-of-composition', 'literature', 0.8),

  ('wealth-of-nations-division-of-labour', 'economics', 1.0),
  ('wealth-of-nations-division-of-labour', 'society', 0.8),
  ('wealth-of-nations-division-of-labour', 'habits', 0.5)
) as v(work, topic, weight)
join public.works w on w.slug = v.work
join public.topics t on t.slug = v.topic
on conflict (work_id, topic_id) do nothing;

-- -----------------------------------------------------------------------------
-- 6. Canonical Summaries
-- -----------------------------------------------------------------------------

insert into public.summaries (work_id, edition_id, version, status, visibility, title,
                              elevator_pitch, why_it_matters, difficulty,
                              reading_minutes, published_at)
select w.id, e.id, 1, 'published', 'public', v.title, v.pitch, v.why,
       v.difficulty, v.minutes, now()
from (values
  ('sketch-of-the-analytical-engine',
   'The Analytical Engine — the machine that manipulates symbols',
   'The leap from calculating numbers to processing general symbolic operations according to rules.',
   'It is the conceptual founding document of modern software and general-purpose computation.',
   0.65, 5),

  ('what-the-tortoise-said-to-achilles',
   'What the Tortoise Said to Achilles — the regress of inference',
   'Why logic cannot justify its own rules by turning inference steps into additional premises.',
   'It exposes that action requires accepting a rule of practice that cannot be reduced to data.',
   0.60, 4),

  ('the-art-of-war',
   'The Art of War — victory through positioning and information',
   'Winning before battle begins by manipulating terrain, information, and friction.',
   'It transforms conflict from a contest of force into an exercise in leverage and restraint.',
   0.40, 5),

  ('tao-te-ching',
   'Tao Te Ching — the power of yielding and non-forcing',
   'Why yielding overcomes rigidity and why forcing an outcome generates its own resistance.',
   'It provides the definitive framework for indirect action and sustainable governance.',
   0.45, 5),

  ('ten-books-on-architecture',
   'Ten Books on Architecture — the triad of good design',
   'A structure must satisfy durability (firmitas), utility (utilitas), and delight (venustas) simultaneously.',
   'It remains the foundational rubric across physical architecture, software engineering, and toolmaking.',
   0.35, 4),

  ('a-vindication-of-the-rights-of-woman',
   'A Vindication of the Rights of Woman — reason as a universal birthright',
   'Virtue is empty without understanding, and denying education degrades both individual and society.',
   'It grounds human equality in moral and cognitive agency rather than custom or benevolence.',
   0.50, 5),

  ('the-ethics-of-belief',
   'The Ethics of Belief — the duty to doubt',
   'Belief without sufficient evidence is not a private luxury but a public risk.',
   'It is the foundational manifesto for epistemic responsibility and intellectual rigor.',
   0.45, 4),

  ('problems-of-philosophy-induction',
   'The Problem of Induction — why the past does not guarantee the future',
   'The belief that natural laws will continue to hold is an assumption of practice, not a logical proof.',
   'It outlines the ultimate boundary of empirical knowledge and scientific certainty.',
   0.55, 5),

  ('the-philosophy-of-composition',
   'The Philosophy of Composition — working backward from effect',
   'Begin with the exact emotional and intellectual effect desired, then engineer every detail toward it.',
   'It demystifies creative inspiration into deliberate, systematic architecture.',
   0.40, 4),

  ('wealth-of-nations-division-of-labour',
   'The Division of Labour — compounding productivity through specialization',
   'Breaking a task into discrete operations multiplies output through dexterity, time saved, and tooling.',
   'It is the bedrock explanation of modern economic abundance and organizational scale.',
   0.35, 4)
) as v(work, title, pitch, why, difficulty, minutes)
join public.works w on w.slug = v.work
join public.editions e on e.work_id = w.id and e.is_primary
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 7. Multi-Depth Pulls
-- -----------------------------------------------------------------------------

insert into public.pulls (summary_id, ordinal, headline, body, why_it_matters,
                          example, explanation, estimated_read_seconds, embedding)
select s.id, v.ordinal, v.headline, v.body, v.why, v.example, v.explanation,
       v.secs, public.synthetic_embedding(v.axes::jsonb)
from (values
  -- Sketch of the Analytical Engine (Ada Lovelace)
  ('sketch-of-the-analytical-engine', 0,
   'A machine can manipulate any symbol whose relationships follow rules, not just numbers.',
   'The Analytical Engine does not merely calculate arithmetic; it can act on any information whose fundamental relationships can be expressed abstractly.',
   'This distinction is what separates a calculator from a general-purpose computer.',
   'If the relations of pitch and harmony could be expressed by symbolic rules, the engine could compose elaborate scientific pieces of music.',
   'Babbage envisioned an engine that would automate astronomical tables. Lovelace saw that when numbers represent abstract quantities, the engine becomes an algebra machine capable of executing any algorithm.',
   34, '{"computation":1.0,"logic":0.8}'),

  ('sketch-of-the-analytical-engine', 1,
   'An algorithm is a weave of operations and variables.',
   'Computation is the deliberate choreography between changing data (variables) and the sequence of rules transforming them (operations).',
   'Separating data state from execution logic is the foundational architecture of modern programming.',
   'We may say most aptly that the Analytical Engine weaves algebraical patterns just as the Jacquard-loom weaves flowers and leaves.',
   'By using punched cards to separate instruction sequences from memory registers, the machine could execute loops, conditional branches, and subroutines without mechanical reconfiguration.',
   36, '{"computation":1.0,"mathematics":0.6}'),

  -- What the Tortoise Said to Achilles (Lewis Carroll)
  ('what-the-tortoise-said-to-achilles', 0,
   'Inference rules cannot be treated as premises without creating an infinite regress.',
   'Accepting that premises A and B are true does not compel accepting conclusion Z unless you follow a rule of inference. But if that rule is added as another premise, it requires yet another rule to apply it.',
   'Logic cannot prove that you must act logically; reasoning requires a commitment to practice that sits outside the premises.',
   'The Tortoise accepts "All men are mortal" (A) and "Socrates is a man" (B), but refuses "Socrates is mortal" (Z) until Achilles writes down "If A and B are true, Z must be true" (C) — which then requires premise D, ad infinitum.',
   'This paradox demonstrates that logical inference is an act of doing rather than a proposition of knowing. A rule of inference is a licence to move from one thought to another, not a factual claim to be listed in the inventory.',
   38, '{"logic":1.0,"philosophy":0.8}'),

  -- The Art of War (Sun Tzu)
  ('the-art-of-war', 0,
   'Supreme excellence consists in breaking the enemy''s resistance without fighting.',
   'Direct conflict is inherently wasteful and unpredictable. The highest strategy alters conditions so that the outcome is determined before engagement.',
   'True leverage dissolves opposition by rendering resistance futile or irrelevant rather than crushing it through attrition.',
   'Surrounding a competitor''s distribution network so thoroughly that their expansion collapses without a price war.',
   'Sun Tzu treats battle as a failure of statecraft. When force must be used, victory should already be decided by superior intelligence, strategic positioning, and understanding of the adversary''s internal fractures.',
   35, '{"strategy":1.0,"society":0.7}'),

  ('the-art-of-war', 1,
   'Strategy must be like water: shaping its course according to the ground.',
   'Fixed plans shatter against unexpected reality. Effective action has no constant form, adapting instantaneously to the frictions and openings of the terrain.',
   'Rigidity in execution is the most common cause of strategic failure under pressure.',
   'Water avoids heights and rushes downward; an adaptable force avoids fortified resistance and strikes empty vulnerabilities.',
   'Adaptability does not mean aimlessness. The overarching objective remains constant while tactics flex dynamically with the adversary''s shifts.',
   32, '{"strategy":0.9,"habits":0.5}'),

  -- Tao Te Ching (Laozi)
  ('tao-te-ching', 0,
   'Yielding is the way the Tao moves; softness overcomes hardness.',
   'Rigidity and brittleness lead to fracture, whereas flexibility and pliability absorb shock and outlast violent opposition.',
   'Forcing an outcome creates an equal and opposite counter-reaction that undermines long-term stability.',
   'A living tree is tender and pliant, but in death it is dry and brittle. The stiff and unbending is the disciple of death; the soft and yielding is the disciple of life.',
   'Wu wei (effortless action) is not paralysis or apathy. It is aligning action with existing gradients of reality rather than swimming upstream against unyielding constraints.',
   34, '{"world-philosophy":1.0,"ethics":0.6}'),

  ('tao-te-ching', 1,
   'Governing a large enterprise is like cooking a delicate small fish: ruin comes from poking too much.',
   'Constant intervention, over-regulation, and nervous micromanagement destabilize complex self-organizing systems.',
   'Restraint at the top permits distributed intelligence to maintain equilibrium and solve local problems.',
   'A manager who continually reorganizes workflows before the previous changes have settled creates friction that degrades performance.',
   'Interference creates the very disorder it claims to cure. Clear boundaries combined with operational non-interference allow organic order to emerge.',
   33, '{"world-philosophy":0.9,"government":0.7}'),

  -- Ten Books on Architecture (Vitruvius)
  ('ten-books-on-architecture', 0,
   'Enduring design requires the simultaneous balance of strength, utility, and delight.',
   'A structure must satisfy three distinct demands: firmitas (durability and physical integrity), utilitas (functional service to its purpose), and venustas (aesthetic harmony).',
   'Optimizing for any single virtue at the expense of the other two produces work that fails over time.',
   'A bridge that is structurally indestructible but located where no one travels, or a beautiful building whose roof leaks under ordinary rain.',
   'Vitruvius insists that aesthetics is not decoration applied after engineering, nor is engineering an afterthought to form. True design emerges from their unified synthesis.',
   33, '{"architecture":1.0,"aesthetics":0.7}'),

  -- A Vindication of the Rights of Woman (Mary Wollstonecraft)
  ('a-vindication-of-the-rights-of-woman', 0,
   'Moral virtue cannot exist without intellectual independence.',
   'A person denied the development of reason cannot be genuinely moral, because their conduct is driven by obedience, fear, or vanity rather than considered principle.',
   'Demanding goodness while withholding the tools of critical thought creates fragile compliance rather than resilient character.',
   'Training children or citizens to seek only approval renders them helpless when confronted with seductive or tyrannical authority.',
   'Wollstonecraft attacks the cultural expectation that women should cultivate charm instead of intellect. She argues that virtue is uniform across all human minds: it requires the capacity to judge causes and foresee consequences.',
   35, '{"justice":1.0,"liberty":0.8}'),

  -- The Ethics of Belief (William Kingdon Clifford)
  ('the-ethics-of-belief', 0,
   'It is wrong always, everywhere, and for anyone, to believe anything upon insufficient evidence.',
   'Belief is not an isolated private feeling; it prepares future actions and contaminates the shared epistemic commons.',
   'Credulity weakens the critical faculties of society, leaving it vulnerable to demagogues and false certainties.',
   'A shipowner who sends an unseaworthy vessel to sea, persuading himself through sincere optimism that it will survive, is morally guilty when it sinks.',
   'Clifford argues that sincerity does not excuse reckless belief. The sin is not in the outcome but in the illicit acquisition of certainty without rigorous cross-examination.',
   34, '{"ethics":1.0,"philosophy":0.8}'),

  -- The Problems of Philosophy: On Induction (Bertrand Russell)
  ('problems-of-philosophy-induction', 0,
   'Past repetition provides no logical certainty that the future will resemble the past.',
   'Inductive expectation is an instinctive biological habit, not a rationally provable law of reality.',
   'Recognizing the limits of induction protects against catastrophic blind spots when environmental conditions shift.',
   'The domestic turkey that is fed every morning at 9:00 AM concludes with increasing certainty each day that morning visits mean breakfast — until Thanksgiving morning.',
   'Russell highlights that all empirical science relies on the principle of induction. While induction cannot be proven by experience without circularity, it remains the indispensable working hypothesis of living.',
   36, '{"logic":1.0,"learning":0.8}'),

  -- The Philosophy of Composition (Edgar Allan Poe)
  ('the-philosophy-of-composition', 0,
   'Begin at the climax: deliberate construction works backward from the intended effect.',
   'Original work does not emerge from spontaneous frenzy or mystical inspiration, but from rigorous, methodical reverse-engineering of the desired reader experience.',
   'Treating creative work as deliberate craft allows every sentence and component to pull in the exact same direction.',
   'Poe designed "The Raven" by first fixing the length, choosing melancholy as the primary tone, selecting the phonetics of the refrain ("Nevermore"), and drafting the final stanza first.',
   'By dispelling the myth of effortless genius, Poe elevates the creator into an architect who deliberately coordinates pacing, tonal contrast, and emotional resonance.',
   36, '{"criticism":1.0,"aesthetics":0.8}'),

  -- The Wealth of Nations (Adam Smith)
  ('wealth-of-nations-division-of-labour', 0,
   'Specialization multiplies productivity by reducing transition loss and focusing skill.',
   'When complex tasks are decomposed into distinct, repetitive operations, total output increases exponentially due to dexterity, eliminated switching costs, and the invention of tailored machinery.',
   'Cooperation across specialized roles is the fundamental mechanism that generates societal wealth.',
   'A single untrained artisan might struggle to craft twenty pins in a day; ten specialized workers dividing the eighteen steps produce forty-eight thousand pins daily.',
   'Smith observes that the division of labour is bounded only by the extent of the market. Larger markets enable deeper specialization, creating compounding efficiencies that raise living standards.',
   35, '{"economics":1.0,"society":0.8}')
) as v(work, ordinal, headline, body, why, example, explanation, secs, axes)
join public.works w on w.slug = v.work
join public.summaries s on s.work_id = w.id
on conflict (summary_id, ordinal) do nothing;

-- -----------------------------------------------------------------------------
-- 8. Interleaved Recall Quiz Questions
-- -----------------------------------------------------------------------------

insert into public.quiz_questions (pull_id, prompt, answer, distractors)
select p.id, v.prompt, v.answer, to_jsonb(v.distractors)
from (values
  ('sketch-of-the-analytical-engine', 0,
   'What key distinction did Ada Lovelace make about the Analytical Engine compared to standard calculating machines?',
   'It could manipulate any abstract symbols following rules, not just perform arithmetic on numbers.',
   array[
     'It operated using electronic vacuum tubes instead of mechanical gears.',
     'It was limited exclusively to compiling navigational astronomical tables.',
     'It stored data on magnetic tape rather than punched cards.'
   ]),

  ('what-the-tortoise-said-to-achilles', 0,
   'Why does Achilles fail to convince the Tortoise to accept the conclusion of the syllogism?',
   'Because treating rules of inference as additional premises triggers an infinite regress.',
   array[
     'Because the initial premises of the syllogism were factually false.',
     'Because the Tortoise did not understand the meaning of the word "mortal".',
     'Because deductive logic cannot be applied to geometric proofs.'
   ]),

  ('the-art-of-war', 0,
   'According to Sun Tzu, what represents the highest form of military excellence?',
   'Breaking the adversary''s resistance without direct armed combat.',
   array[
     'Annihilating the enemy''s army in a decisive pitch battle.',
     'Building impenetrable fortifications along the border.',
     'Conducting swift scorched-earth campaigns across foreign territory.'
   ]),

  ('tao-te-ching', 0,
   'What core principle of the Tao Te Ching is illustrated by the analogy of cooking a delicate fish?',
   'Over-intervention and constant tinkering destabilize natural systems.',
   array[
     'Strict legal codes must be enforced rigorously without mercy.',
     'A leader should conquer neighboring states through decisive force.',
     'Material luxury is the primary indicator of a flourishing society.'
   ]),

  ('ten-books-on-architecture', 0,
   'What three criteria did Vitruvius identify as the essential requirements of good architecture?',
   'Durability, utility, and beauty (firmitas, utilitas, venustas).',
   array[
     'Symmetry, monumental height, and decorative opulence.',
     'Low financial cost, rapid construction, and minimal material usage.',
     'Strict adherence to religious geometry, secrecy, and stone masonry.'
   ]),

  ('the-ethics-of-belief', 0,
   'Why does W. K. Clifford argue that holding beliefs without sufficient evidence is morally wrong?',
   'Because private beliefs guide public actions and shape the collective epistemic trust of society.',
   array[
     'Because only professional scientists are permitted to form opinions.',
     'Because erroneous beliefs inevitably lead to legal prosecution.',
     'Because doubts are sinful and weaken personal spiritual resolve.'
   ]),

  ('problems-of-philosophy-induction', 0,
   'What is the fundamental limitation of inductive reasoning identified by Bertrand Russell?',
   'Past repetition provides no logical guarantee that future conditions will behave the same way.',
   array[
     'Mathematical deduction cannot be applied to physical reality.',
     'Human sensory perception is biologically incapable of observing causality.',
     'Empirical facts can only be discovered through pure introspective intuition.'
   ]),

  ('wealth-of-nations-division-of-labour', 0,
   'In Adam Smith''s analysis of the pin factory, what drives the massive increase in productivity?',
   'Task decomposition into specialized steps that enhance dexterity and eliminate switching time.',
   array[
     'Employing steam-powered automation to replace all human labor.',
     'Mandating longer working hours and strict industrial quotas.',
     'Restricting production exclusively to domestic markets to avoid tariffs.'
   ])
) as v(work_slug, ordinal, prompt, answer, distractors)
join public.works w on w.slug = v.work_slug
join public.summaries s on s.work_id = w.id
join public.pulls p on p.summary_id = s.id and p.ordinal = v.ordinal
on conflict do nothing;
