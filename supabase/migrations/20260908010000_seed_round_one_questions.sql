-- Seed questions for the 21 round-one pulls: MCQ, Cloze, and Recall.
--
-- In Package 3b of The Loop (`docs/plans/2026-09-05-the-loop.md`), every idea in the
-- foundation corpus gains active retrieval practice:
--   * An MCQ testing discrimination between confusable concepts with distractor rationales
--   * A Cloze testing precision on the core mechanism or principle
--   * A Recall prompt ensuring generative retrieval
--
-- Original commentary throughout; no quotation (law 4).
-- Idempotent: `on conflict (pull_id, kind) do nothing`.

-- -----------------------------------------------------------------------------
-- 1. Multiple Choice Questions (MCQ) for all 21 round-one pulls
-- -----------------------------------------------------------------------------

insert into public.quiz_questions (pull_id, kind, prompt, answer, distractors, explanation, rationale)
select
  p.id,
  'mcq',
  v.prompt,
  v.answer,
  to_jsonb(v.distractors),
  v.explanation,
  v.rationale::jsonb
from (values
  -- The Enchiridion
  ('Some things are up to you%',
   'In Epictetus''s dichotomy of control, which of the following belongs strictly to what is up to you?',
   'Your deliberate effort and judgements',
   array[
     'The reputation you establish among peers',
     'The final outcome of a challenging project',
     'How other people treat you in negotiations'
   ],
   'Epictetus defines what is up to us strictly as internal acts of mind: our opinions, desires, aversions, and deliberate effort. External outcomes and others'' reactions depend on factors outside our sovereign control.',
   '[
     {"distractor": "The reputation you establish among peers", "why": "Reputation depends on the opinions of external observers, not your direct agency."},
     {"distractor": "The final outcome of a challenging project", "why": "Outcomes are subject to external friction and fortune even when preparation is thorough."},
     {"distractor": "How other people treat you in negotiations", "why": "Other people''s behavior and assent belong to their agency, not yours."}
   ]'),

  ('You are disturbed by your judgement%',
   'Why does Stoic analysis locate distress in your judgement rather than in external events?',
   'Because judgements can be examined and revised, whereas external events cannot be retroactively altered',
   array[
     'Because emotional reactions can be suppressed entirely through sheer willpower',
     'Because events carry objective negative values that must be passively endured',
     'Because external reality conforms to positive expectations over time'
   ],
   'Distress arises not from raw occurrences, but from the interpretive judgements we attach to them. Locating suffering in judgement provides leverage because judgement is within our sphere of revision.',
   '[
     {"distractor": "Because emotional reactions can be suppressed entirely through sheer willpower", "why": "Stoicism advocates examining the underlying belief rather than brute emotional suppression."},
     {"distractor": "Because events carry objective negative values that must be passively endured", "why": "The core claim is that events are morally neutral until judgement evaluates them."},
     {"distractor": "Because external reality conforms to positive expectations over time", "why": "Expecting reality to bend to wishes is the exact contest Stoics warn against."}
   ]'),

  ('Wanting the world to be otherwise%',
   'What makes demanding that reality conform to personal preference a guaranteed loss?',
   'It makes personal composure conditional on circumstances that do not consult your wishes',
   array[
     'It guarantees that future goals will fail to materialize',
     'It proves that personal effort has no influence on outcomes',
     'It forces you to surrender all planning and ambition'
   ],
   'When your equanimity requires external events to match your desires, you surrender control over your state of mind to an indifferent world.',
   '[
     {"distractor": "It guarantees that future goals will fail to materialize", "why": "The loss is psychological distress in the present, not the inevitable failure of future projects."},
     {"distractor": "It proves that personal effort has no influence on outcomes", "why": "Effort has influence, but demanding certainty over the result creates unnecessary vulnerability."},
     {"distractor": "It forces you to surrender all planning and ambition", "why": "Prudent planning remains intact; what is eliminated is emotional entitlement to specific outcomes."}
   ]'),

  ('Rehearse the difficulty%',
   'What is the primary operational benefit of premeditating setbacks before they occur?',
   'It neutralizes the shock of surprise while the stakes are still zero',
   array[
     'It creates pessimistic assumptions that lower expectations permanently',
     'It magically prevents adverse circumstances from happening',
     'It desensitizes you to the point where setbacks no longer matter at all'
   ],
   'Setbacks wound most deeply when they catch us unprepared. Visualizing disruptions in advance allows the mind to formulate actions calmly before emotional pressure strikes.',
   '[
     {"distractor": "It creates pessimistic assumptions that lower expectations permanently", "why": "Rehearsal is proactive preparation, not chronic defeatism or lowered standards."},
     {"distractor": "It magically prevents adverse circumstances from happening", "why": "Mental rehearsal prepares the mind for reality; it does not exert superstitious influence over events."},
     {"distractor": "It desensitizes you to the point where setbacks no longer matter at all", "why": "The goal is rapid recovery and clear action, not emotional apathy or nihilism."}
   ]'),

  -- Meditations
  ('What blocks the way%',
   'What does Marcus Aurelius mean when asserting that the impediment to action advances action?',
   'The obstacle defines the real conditions under which the next action must now be taken',
   array[
     'Every negative event is secretly a beneficial blessing in disguise',
     'Overcoming obstacles guarantees immediate career and material success',
     'One should deliberately manufacture difficulties to test endurance'
   ],
   'An impediment stops one course of action while opening another (such as patience, problem-solving, or detachment). The new reality becomes the immediate task.',
   '[
     {"distractor": "Every negative event is secretly a beneficial blessing in disguise", "why": "Marcus does not indulge in naive optimism; the obstacle is a friction, but it is the actual ground of duty."},
     {"distractor": "Overcoming obstacles guarantees immediate career and material success", "why": "Stoic virtue is about maintaining integrity and reasoned action, not guaranteed external rewards."},
     {"distractor": "One should deliberately manufacture difficulties to test endurance", "why": "Manufactured struggle is theatrical; Marcus is addressing unavoidable facts of life."}
   ]'),

  ('It is your opinion of the thing%',
   'On what basis does Marcus Aurelius argue that the injury caused by perceived insult or misfortune can be dismissed?',
   'The sensation of injury requires your internal agreement to the verdict that you have been harmed',
   array[
     'Physical injury and psychological pain are completely identical',
     'Society eventually punishes those who commit wrongful actions',
     'Ignoring offenses forces adversaries to apologize'
   ],
   'Remove the judgement "I have been hurt," and the feeling of having been hurt vanishes. The verdict is your own creation and remains within your power to retract.',
   '[
     {"distractor": "Physical injury and psychological pain are completely identical", "why": "Physical injury affects the body directly, but the sense of moral or personal degradation is an interpretive verdict."},
     {"distractor": "Society eventually punishes those who commit wrongful actions", "why": "Relying on external justice defers personal equanimity to third parties."},
     {"distractor": "Ignoring offenses forces adversaries to apologize", "why": "Revoking the verdict is internal; it does not aim to manipulate other people''s conduct."}
   ]'),

  ('You could leave life right now%',
   'What is the primary practical function of memento mori in Marcus Aurelius''s notebooks?',
   'Acting as a strict scheduling filter that cuts trivial obligations from finite remaining time',
   array[
     'Inducing existential terror to motivate frantic productivity',
     'Encouraging hedonistic indulgence while life remains',
     'Justifying withdrawal from civic duty and public life'
   ],
   'Keeping mortality present provides clarity: it reveals which activities are genuine priorities and which are mere posturing or distraction.',
   '[
     {"distractor": "Inducing existential terror to motivate frantic productivity", "why": "Marcus uses death to produce serene focus and simplicity, not panic or frantic striving."},
     {"distractor": "Encouraging hedonistic indulgence while life remains", "why": "Stoic ethics tie time to reasoned duty and character, not sensory distraction."},
     {"distractor": "Justifying withdrawal from civic duty and public life", "why": "Marcus ruled an empire while writing this; death reinforced duty rather than excusing retreat."}
   ]'),

  ('Do the work in front of you%',
   'What waste of mental energy does Marcus Aurelius target by rejecting an internal audience?',
   'The exhausting performance of self-presentation and ongoing mental narration',
   array[
     'Collaborating with colleagues on collective assignments',
     'Seeking legitimate feedback from real instructors and peers',
     'Reviewing finished work for technical accuracy'
   ],
   'Doing the work directly without self-conscious narration preserves focus and eliminates the friction of maintaining an imagined persona.',
   '[
     {"distractor": "Collaborating with colleagues on collective assignments", "why": "Working with real people is communal duty; an imagined audience is a private delusion of vanity."},
     {"distractor": "Seeking legitimate feedback from real instructors and peers", "why": "External objective correction is encouraged; it is self-absorbed posturing that is condemned."},
     {"distractor": "Reviewing finished work for technical accuracy", "why": "Craftsmanship requires objective evaluation, not narcissistic mental commentary."}
   ]'),

  -- On Liberty
  ('Silencing an opinion%',
   'According to John Stuart Mill, why is silencing an opinion a loss for society even if the suppressed view is completely false?',
   'It deprives truth of the vigorous contest required to understand its underlying reasons',
   array[
     'It violates the legal property rights of the author who formulated the view',
     'It forces the false view to become legally binding in court',
     'It proves that all opinions are equally valid and subjective'
   ],
   'Mill argues that encountering and refuting error is what prevents true beliefs from degenerating into unexamined prejudices.',
   '[
     {"distractor": "It violates the legal property rights of the author who formulated the view", "why": "Mill bases his defense on intellectual utility for listeners, not intellectual property."},
     {"distractor": "It forces the false view to become legally binding in court", "why": "Suppression suppresses the view, it does not codify it into law."},
     {"distractor": "It proves that all opinions are equally valid and subjective", "why": "Mill rejects epistemological relativism; he believes in objective truth, but argues contest is necessary to understand it."}
   ]'),

  ('Power over another is only legitimate%',
   'Under Mill''s harm principle, when is society justified in using coercive force against an adult citizen?',
   'Only when necessary to prevent non-consensual harm to other people',
   array[
     'Whenever the citizen behaves in a manner contrary to their own moral well-being',
     'Whenever the majority finds the citizen''s lifestyle offensive and unwholesome',
     'Whenever state experts identify a more efficient personal health regimen'
   ],
   'The harm principle restricts state and social coercion strictly to preventing injury to third parties, barring paternalistic interference in self-regarding actions.',
   '[
     {"distractor": "Whenever the citizen behaves in a manner contrary to their own moral well-being", "why": "Mill explicitly rules out paternalism: a person''s own good is grounds for persuasion, not compulsion."},
     {"distractor": "Whenever the majority finds the citizen''s lifestyle offensive and unwholesome", "why": "Mere offense or unconventional habits do not constitute tangible harm to others."},
     {"distractor": "Whenever state experts identify a more efficient personal health regimen", "why": "Compelling personal hygiene or lifestyle choices violates individual bodily sovereignty."}
   ]'),

  ('An unchallenged truth%',
   'What intellectual failure occurs when a true doctrine is protected from all public disagreement?',
   'Believers retain the nominal conclusion while losing the rational arguments that justify it',
   array[
     'The underlying facts automatically reverse and become false',
     'The doctrine is forgotten entirely and erased from historical libraries',
     'Believers become open-minded and welcome opposing perspectives'
   ],
   'When truth is inherited without struggle or defense, its meaning fades into empty phrases that collapse when confronted with real skepticism.',
   '[
     {"distractor": "The underlying facts automatically reverse and become false", "why": "Truth remains factually true, but human comprehension of why it is true dissolves."},
     {"distractor": "The doctrine is forgotten entirely and erased from historical libraries", "why": "The words continue to be repeated by rote, which is the exact symptom of dogmatism."},
     {"distractor": "Believers become open-minded and welcome opposing perspectives", "why": "Protected dogmas produce intellectual fragility and intolerance toward challenge."}
   ]'),

  ('Social pressure can coerce%',
   'Why does Mill argue that the tyranny of the majority expressed through custom is harder to resist than legal penalties?',
   'It penetrates everyday life invisibly, operating through social ostracism without formal appeal or constitutional limits',
   array[
     'Social customs carry harsher financial penalties than criminal courts',
     'Unwritten norms are strictly enforced by state police officers',
     'Informal pressure applies only to political candidates during elections'
   ],
   'The pressure to conform to prevailing opinion reaches into areas laws cannot touch, stifling individuality and original thought before it can even be voiced.',
   '[
     {"distractor": "Social customs carry harsher financial penalties than criminal courts", "why": "Social pressure works through psychological isolation and conformity, not monetary fines."},
     {"distractor": "Unwritten norms are strictly enforced by state police officers", "why": "Social coercion is enforced by neighbors and peers, which is what makes it so pervasive."},
     {"distractor": "Informal pressure applies only to political candidates during elections", "why": "Conformity polices ordinary life, taste, thought, and daily habits."}
   ]'),

  -- Walden
  ('The cost of a thing%',
   'In Thoreau''s real-cost accounting, how should the expense of an item be calculated?',
   'By the quantity of life and labor traded to purchase, maintain, and safeguard it',
   array[
     'By its depreciated resale value on the secondary market',
     'By the prestige and status it confers upon its owner',
     'By the percentage of total net worth it represents at checkout'
   ],
   'Money represents stored life: the hours traded for wages plus the time demanded by maintenance and anxiety represent the true cost of any possession.',
   '[
     {"distractor": "By its depreciated resale value on the secondary market", "why": "Financial depreciation ignores the irreversible expenditure of mortal life required to obtain the item."},
     {"distractor": "By the prestige and status it confers upon its owner", "why": "Status displays are precisely the wasteful traps Thoreau''s metric seeks to expose."},
     {"distractor": "By the percentage of total net worth it represents at checkout", "why": "Net worth obscures the direct equation between working hours and finite lifespan."}
   ]'),

  ('Most luxuries are hindrances%',
   'According to Thoreau, what hidden liability turns most luxuries into positive hindrances?',
   'The upkeep, storage, and emotional worry they demand exceed the comfort they provide',
   array[
     'Luxuries are morally prohibited by traditional religious scripture',
     'High-end craftsmanship inevitably degrades faster than basic goods',
     'Owning fine items makes an individual immediately repulsive to neighbors'
   ],
   'Possessions can easily become burdens that tie their owners down in endless cycles of earning, cleaning, preserving, and worrying.',
   '[
     {"distractor": "Luxuries are morally prohibited by traditional religious scripture", "why": "Thoreau''s critique is practical and phenomenological, not an appeal to dogma."},
     {"distractor": "High-end craftsmanship inevitably degrades faster than basic goods", "why": "The issue is not craftsmanship, but the psychological and temporal burden of maintenance."},
     {"distractor": "Owning fine items makes an individual immediately repulsive to neighbors", "why": "Material goods often attract false social admiration, which is part of the trap."}
   ]'),

  ('Living deliberately is mostly%',
   'What was the fundamental objective of Thoreau''s experiment at Walden?',
   'Removing peripheral distractions to identify which parts of life were deliberately chosen',
   array[
     'Proving that human beings can survive indefinitely without human contact',
     'Founding a permanent utopian agricultural commune',
     'Demonstrating that modern technology causes irreversible biological harm'
   ],
   'Deliberate living requires conscious curation of attention. By simplifying external circumstances, one determines what genuinely matters.',
   '[
     {"distractor": "Proving that human beings can survive indefinitely without human contact", "why": "Thoreau walked into town regularly and welcomed visitors; the experiment was about deliberate attention, not total isolation."},
     {"distractor": "Founding a permanent utopian agricultural commune", "why": "It was a temporary, individual inquiry into living simply, not a communal settlement."},
     {"distractor": "Demonstrating that modern technology causes irreversible biological harm", "why": "Thoreau examined the mental and spiritual costs of commercial hurry, not biological toxicology."}
   ]'),

  -- On the Origin of Species
  ('Three conditions are enough%',
   'What makes the logical mechanism of natural selection so powerful in evolutionary biology?',
   'It requires only variation, heredity, and differential reproductive success to guarantee population change',
   array[
     'It requires an internal teleological drive pushing organisms toward conscious perfection',
     'It relies on spontaneous generation of completely new anatomical organs in a single generation',
     'It demands an external designer actively selecting which traits should survive'
   ],
   'Darwin''s logic is deductively inevitable: if organisms vary, traits are inherited, and some variations confer survival advantages, the population must mathematically evolve.',
   '[
     {"distractor": "It requires an internal teleological drive pushing organisms toward conscious perfection", "why": "Lamarckian or teleological urges are unnecessary; the three mechanical conditions are sufficient."},
     {"distractor": "It relies on spontaneous generation of completely new anatomical organs in a single generation", "why": "Complex organs evolve through cumulative slight modifications over deep time."},
     {"distractor": "It demands an external designer actively selecting which traits should survive", "why": "Selection is natural and automatic, driven by environmental interaction with variation."}
   ]'),

  ('Very small advantages%',
   'What human cognitive blind spot makes complex biological adaptations appear intentionally engineered?',
   'The inability to intuitively visualize how minute fractional advantages compound across geological deep time',
   array[
     'The inability to observe genetic mutations under laboratory microscopes',
     'The mistaken belief that ancient organisms were much larger than modern ones',
     'The lack of mathematical tools to calculate geometric population growth'
   ],
   'Human experience spans decades, while natural selection works over millions of years. Fractional advantages compounded across deep time create intricate adaptations that mimic conscious engineering.',
   '[
     {"distractor": "The inability to observe genetic mutations under laboratory microscopes", "why": "Darwin did not possess molecular genetics; the conceptual hurdle was temporal scale."},
     {"distractor": "The mistaken belief that ancient organisms were much larger than modern ones", "why": "Organism size is irrelevant to the arithmetic of compounding selection."},
     {"distractor": "The lack of mathematical tools to calculate geometric population growth", "why": "Darwin explicitly used Malthus''s geometric calculations to model population pressure."}
   ]'),

  ('Common descent explains%',
   'Why does the nested hierarchy of taxonomy (groups subordinate to groups) support common descent over independent creation?',
   'Branching genealogical descent naturally generates nested patterns, whereas independent creation could combine traits arbitrarily',
   array[
     'Nested hierarchies only exist in animal anatomy and never in plants or microbes',
     'Independent creation would require all organisms to have identical external phenotypes',
     'Linear ladders of progression are mathematically impossible in biological systems'
   ],
   'If species were designed independently, traits could be mixed and matched freely without nested constraints. Nested hierarchies are the unmistakable geometric footprint of an ancestral tree.',
   '[
     {"distractor": "Nested hierarchies only exist in animal anatomy and never in plants or microbes", "why": "Nested classification applies across all biological kingdoms."},
     {"distractor": "Independent creation would require all organisms to have identical external phenotypes", "why": "Creation could create completely isolated, cross-cutting trait combinations (like mammals with bird wings and fish scales)."},
     {"distractor": "Linear ladders of progression are mathematically impossible in biological systems", "why": "The issue is not mathematical possibility, but empirical observation: life branches rather than ascends a single ladder."}
   ]'),

  -- Relativity
  ('If light''s speed is the same%',
   'What radical physical consequence follows from holding the speed of light constant for all inertial observers?',
   'Whether two spatially separated events occur at the same time depends on the motion of the observer',
   array[
     'Light must travel faster when emitted from a rapidly moving vehicle',
     'Time comes to a complete physical standstill across the entire universe',
     'Spatial distance remains absolute while temporal duration fluctuates randomly'
   ],
   'If light travels at the same speed relative to all observers regardless of their relative motion, a common universal "now" is logically impossible. Simultaneity is relative to the observer''s frame of reference.',
   '[
     {"distractor": "Light must travel faster when emitted from a rapidly moving vehicle", "why": "The speed of light is invariant regardless of the emitter''s velocity; that invariance is the starting postulate."},
     {"distractor": "Time comes to a complete physical standstill across the entire universe", "why": "Time flows normally in every observer''s own local rest frame."},
     {"distractor": "Spatial distance remains absolute while temporal duration fluctuates randomly", "why": "Both space and time transform together in Lorentz invariance; neither is absolute."}
   ]'),

  ('Standing on the ground%',
   'What foundational realization is encapsulated in Einstein''s equivalence principle?',
   'The physical effects of a uniform gravitational field are indistinguishable from uniform mechanical acceleration',
   array[
     'Gravity is an electromagnetic wave transmitted through the luminiferous aether',
     'Gravitational pull decreases to zero when an object leaves Earth''s atmosphere',
     'Acceleration in empty space requires infinite energy for even tiny masses'
   ],
   'The equivalence principle asserts that inertial mass and gravitational mass are identical, enabling gravity to be understood geometrically rather than as a mechanical force.',
   '[
     {"distractor": "Gravity is an electromagnetic wave transmitted through the luminiferous aether", "why": "Relativity disproved the aether; gravity is geometric curvature of spacetime."},
     {"distractor": "Gravitational pull decreases to zero when an object leaves Earth''s atmosphere", "why": "Gravity extends throughout space, diminishing with the inverse square of distance."},
     {"distractor": "Acceleration in empty space requires infinite energy for even tiny masses", "why": "Infinite energy is approached only as velocity nears the speed of light."}
   ]'),

  ('The laws should look the same%',
   'What does the principle of relativity demand regarding the fundamental laws of nature?',
   'The laws of physics must hold identical form in all inertial reference frames without any privileged state of rest',
   array[
     'Different observers must experience identical numerical velocities for all objects',
     'Accelerating reference frames violate the conservation of energy',
     'The laws of physics change dynamically depending on an observer''s geographic location'
   ],
   'Nature plays no favorites: there is no master reference frame at rest. The mathematical equations describing physical reality must apply equally to any unaccelerated observer.',
   '[
     {"distractor": "Different observers must experience identical numerical velocities for all objects", "why": "Relative velocities differ between moving frames; it is the physical laws that remain invariant."},
     {"distractor": "Accelerating reference frames violate the conservation of energy", "why": "Energy conservation holds under proper general relativistic formulations."},
     {"distractor": "The laws of physics change dynamically depending on an observer''s geographic location", "why": "Invariance implies universal consistency, not localized arbitrary shifts."}
   ]')
) as v(pattern, prompt, answer, distractors, explanation, rationale)
join public.pulls p on p.headline like v.pattern
on conflict (pull_id, kind) do nothing;


-- -----------------------------------------------------------------------------
-- 2. Cloze Questions for all 21 round-one pulls
-- -----------------------------------------------------------------------------

insert into public.quiz_questions (pull_id, kind, prompt, answer, cloze, explanation)
select
  p.id,
  'cloze',
  v.prompt,
  v.answer,
  v.cloze,
  v.explanation
from (values
  -- The Enchiridion
  ('Some things are up to you%',
   'Complete Epictetus''s principle on the scope of personal agency:',
   'loss',
   'Effort spent trying to control external outcomes is spent at a ____ because those outcomes do not belong to you.',
   'Because external events are not governed by our will, expending emotional stake and effort to control them produces frustration and wasted life.'),

  ('You are disturbed by your judgement%',
   'Complete the Stoic principle on the source of emotional disturbance:',
   'verdict',
   'Events arrive without commentary; the distress comes entirely from the ____ you attach to them.',
   'Raw events carry no moral or emotional evaluation until your own judgement issues a verdict on them.'),

  ('Wanting the world to be otherwise%',
   'Complete the Stoic principle on accepting reality:',
   'composure',
   'Demanding that events conform to your preferences creates a contest you cannot win; accepting them as they occur preserves ____ without resignation.',
   'Composure remains sovereign when it ceases to demand that external events consult personal preference.'),

  ('Rehearse the difficulty%',
   'Complete the Stoic rule on mental rehearsal:',
   'surprise',
   'Rehearsing difficulties in advance removes ____ while the stakes are still zero.',
   'Surprise multiplies the disruption of any adversity; premeditation neutralizes surprise by making the setback familiar.'),

  -- Meditations
  ('What blocks the way%',
   'Complete Marcus Aurelius''s aphorism on obstacles:',
   'material',
   'An obstruction is not merely an interruption; it is the ____ the work is now made of.',
   'The obstacle replaces previous assumptions and supplies the raw substance for your immediate response.'),

  ('It is your opinion of the thing%',
   'Complete the principle on revoking harmful evaluations:',
   'revoked',
   'Pain is attached to your interpretive verdict rather than the event itself, and that verdict can be ____ at will.',
   'Because you generated the interpretation of harm, you retain the authority to rescind it.'),

  ('You could leave life right now%',
   'Complete Marcus Aurelius''s perspective on mortality:',
   'scheduling',
   'In Stoic practice, mortality serves as a practical ____ constraint that settles what is worth doing with remaining time.',
   'Awareness of death filters out non-essential activities and sharpens focus on immediate duties.'),

  ('Do the work in front of you%',
   'Complete Marcus Aurelius''s rule on focused execution:',
   'self-presentation',
   'Performing work for an imagined spectator wastes mental energy on ____ rather than substance.',
   'Removing the internal commentary returns energy directly to the craft and duty at hand.'),

  -- On Liberty
  ('Silencing an opinion%',
   'Complete Mill''s argument against censorship:',
   'understanding',
   'If a silenced opinion is correct, society loses a correction; if it is false, society loses the sharper ____ that comes from refuting it.',
   'Contesting error forces believers to articulate evidence and grasp why the true view holds.'),

  ('Power over another is only legitimate%',
   'Complete Mill''s harm principle:',
   'compulsion',
   'A person''s own physical or moral good is grounds for persuasion, but never a warrant for ____.',
   'Coercion is only legitimate to protect others from harm; personal benefit must be pursued through voluntary choice.'),

  ('An unchallenged truth%',
   'Complete Mill''s warning on uncontested beliefs:',
   'reasons',
   'When an idea is never challenged, its adherents retain the conclusion but forget the ____ that justify it.',
   'Active comprehension requires knowing not just what is claimed, but the arguments that withstand challenge.'),

  ('Social pressure can coerce%',
   'Complete Mill''s insight on informal tyranny:',
   'record',
   'Prevailing opinion and custom can coerce thought more effectively than law because they leave no ____ and provide no formal appeal.',
   'The informal pressure of social conformity operates without the procedural checks or transparency of statute law.'),

  -- Walden
  ('The cost of a thing%',
   'Complete Thoreau''s accounting formula for purchases:',
   'life',
   'The real cost of any possession is the amount of ____ you exchange to acquire and maintain it.',
   'Financial transactions are ultimately trades of finite personal time and energy.'),

  ('Most luxuries are hindrances%',
   'Complete Thoreau''s critique of material comfort:',
   'hindrances',
   'Many comforts add maintenance, obligation, and anxiety that make them net ____ to authentic living.',
   'Possessions turn into hindrances when the work of owning them exceeds the benefit of using them.'),

  ('Living deliberately is mostly%',
   'Complete Thoreau''s definition of intentional living:',
   'attention',
   'Deliberate living is an exercise in managing your ____ to ensure your commitments are chosen rather than habitual.',
   'Attention is the ultimate scarce resource; living deliberately means actively directing where it is spent.'),

  -- On the Origin of Species
  ('Three conditions are enough%',
   'Complete the core formulation of natural selection:',
   'heredity',
   'Natural selection is mathematically inevitable given three conditions: variation, ____, and differential survival.',
   'Without inheritance of adaptive traits, favorable variations would perish with the individual rather than accumulate across generations.'),

  ('Very small advantages%',
   'Complete the insight on evolutionary time:',
   'compounded',
   'Adaptations that appear engineered are produced by minute fractional advantages ____ over vast geological timescales.',
   'Compounding is the engine of evolutionary complexity: slight gains accumulated over deep time yield radical transformations.'),

  ('Common descent explains%',
   'Complete Darwin''s evidential argument on taxonomy:',
   'branching',
   'The classification of living organisms into groups within groups reflects the geometry of ____ descent.',
   'Branching ancestry naturally produces hierarchical clusters of shared derived characteristics.'),

  -- Relativity
  ('If light''s speed is the same%',
   'Complete Einstein''s deduction on the nature of time:',
   'simultaneity',
   'Because light''s speed is invariant for all observers, the concept of absolute ____ must be abandoned.',
   'Two events simultaneous in one reference frame occur at different times in a frame moving relative to it.'),

  ('Standing on the ground%',
   'Complete the core insight of Einstein''s equivalence principle:',
   'acceleration',
   'Inside a sealed frame, resting in a uniform gravitational field produces results identical to uniform ____ in empty space.',
   'Mechanical acceleration and gravitational presence create identical local physical phenomena.'),

  ('The laws should look the same%',
   'Complete the principle of relativity:',
   'rest',
   'The laws of physics must be identical for all unaccelerated observers because nature contains no privileged state of ____.',
   'There is no absolute resting grid in the universe; all inertial motion is relative.')
) as v(pattern, prompt, answer, cloze, explanation)
join public.pulls p on p.headline like v.pattern
on conflict (pull_id, kind) do nothing;


-- -----------------------------------------------------------------------------
-- 3. Recall Questions for the 15 round-one pulls without one
-- -----------------------------------------------------------------------------

insert into public.quiz_questions (pull_id, kind, prompt, answer, explanation)
select
  p.id,
  'recall',
  v.prompt,
  v.answer,
  v.explanation
from (values
  -- The Enchiridion
  ('Wanting the world to be otherwise%',
   'How does Epictetus distinguish wanting events as they happen from mere resignation?',
   'Wanting events as they happen aligns your composure with reality without demanding that circumstances consult your preferences.',
   'Acceptance is not despair or defeat; it is refusing to make your peace of mind conditional on outcomes you do not command.'),

  ('Rehearse the difficulty%',
   'What is the practical mechanism behind the Stoic practice of premeditatio malorum (rehearsing difficulties)?',
   'It removes surprise and emotional shock by confronting potential setbacks in detail while the stakes are zero.',
   'Surprise magnifies the damage of any setback; anticipating difficulties turns an emergency into a prepared procedure.'),

  -- Meditations
  ('What blocks the way%',
   'How does Marcus Aurelius reframe an unexpected obstacle into the work itself?',
   'The obstacle is not secretly desirable, but it constitutes the actual reality you must now navigate and turn into action.',
   'Instead of treating an obstacle as an interruption of ideal plans, Marcus treats the obstacle as the raw material for practicing patience, ingenuity, or resilience.'),

  ('It is your opinion of the thing%',
   'Why does Marcus Aurelius emphasize that the verdict wounding you can be revoked?',
   'Because your evaluation was created by your own mind, meaning you have sovereign authority to withdraw it at any moment.',
   'Pain from perceived slights or setbacks is mediated by interpretation; altering the interpretation dissolves the secondary wound.'),

  ('You could leave life right now%',
   'How does Marcus Aurelius use mortality as an editorial tool for daily living?',
   'As an immediate scheduling constraint that eliminates trivial concerns and clarifies essential actions.',
   'Contemplating immediate death cuts away vanity, petty grudges, and procrastination by subjecting each activity to the test of finite time.'),

  ('Do the work in front of you%',
   'Why does Marcus Aurelius advise eliminating an imagined audience while working?',
   'Because performing for an imaginary spectator wastes energy on self-presentation instead of executing the work itself.',
   'Much mental fatigue comes from narrating and evaluating our own performance rather than simply engaging with the task directly.'),

  -- On Liberty
  ('Power over another is only legitimate%',
   'What is the single condition John Stuart Mill establishes as legitimate for exercising coercive power over an individual?',
   'To prevent harm to others; an individual''s own physical or moral good never justifies coercion.',
   'Mill''s harm principle draws a hard boundary around self-regarding conduct: over his own body and mind, the individual is sovereign.'),

  ('An unchallenged truth%',
   'What happens to a true belief when it is shielded from debate and contradiction?',
   'It degenerates into a dead dogma where believers retain the conclusion but lose the underlying evidence and rationale.',
   'Without opposition, knowledge atrophies into rote recitation, leaving believers incapable of defending their position or recognizing its limits.'),

  ('Social pressure can coerce%',
   'Why does Mill consider the tyranny of prevailing opinion more insidious than state legislation?',
   'Social disapproval and custom penetrate intimate private life and enslave the soul without leaving any legal record or formal appeal.',
   'Legal tyranny has visible boundaries and explicit penalties; social conformity operates invisibly through peer pressure, ostracism, and self-censorship.'),

  -- Walden
  ('Most luxuries are hindrances%',
   'What test does Thoreau apply to determine whether a luxury is actually a burden?',
   'He weighs the comfort it provides against the cumulative maintenance, financial obligation, and anxiety it requires.',
   'Possessions often demand more life in upkeep, cleaning, and protection than the net utility or satisfaction they offer.'),

  ('Living deliberately is mostly%',
   'What was the primary purpose of Thoreau''s retreat to Walden Pond?',
   'To strip away external distraction and discover which commitments in life were deliberately chosen rather than passively inherited.',
   'The cabin was not a permanent rejection of society, but an experiment in attention: eliminating peripheral noise to examine essential experience.'),

  -- On the Origin of Species
  ('Very small advantages%',
   'Why do the results of natural selection frequently look intentionally designed to human observers?',
   'Because humans fail to grasp how slight fractional advantages compound over immense geological timescales.',
   'The failure is arithmetic intuition: slight survival differences repeated across millions of generations accumulate immense anatomical transformation.'),

  ('Common descent explains%',
   'Why does the taxonomic pattern of "groups within groups" provide compelling evidence for evolution?',
   'A nested hierarchical pattern is the natural signature of branching descent with modification, whereas independent creation has no reason to produce it.',
   'Nested hierarchies (kingdom, phylum, class, order, family, genus, species) mirror a family tree; they explain an already-catalogued classification scheme that other theories could only accommodate.'),

  -- Relativity
  ('Standing on the ground%',
   'What does Einstein''s equivalence principle state regarding gravity and acceleration?',
   'No local experiment performed inside a closed frame can distinguish resting in a uniform gravitational field from being accelerated through space.',
   'This equivalence led Einstein to conclude that gravity is not a Newtonian pull across distance, but the manifestation of curved spacetime.'),

  ('The laws should look the same%',
   'What does the principle of relativity state about inertial reference frames?',
   'The laws of physics take identical mathematical form in all inertial frames, meaning no frame is privileged as absolute rest.',
   'There is no cosmic speedometer or stationary background against which absolute velocity can be measured; all motion is relative.')
) as v(pattern, prompt, answer, explanation)
join public.pulls p on p.headline like v.pattern
on conflict (pull_id, kind) do nothing;
