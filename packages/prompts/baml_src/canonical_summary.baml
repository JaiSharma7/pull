// The canonical summary: one generation, read by thousands (law 2).
//
// This is the same contract `_shared/providers.ts` declares as `CanonicalSummary`,
// expressed once and exported. `_shared/gemini.ts` no longer hand-writes it:
// `SUMMARY_SCHEMA` is `toGeminiSchema(PROMPTS.WriteCanonicalSummary.schema)`, and
// `_shared/anthropic.ts` passes the same schema as a tool. This comment said the
// opposite -- that gemini.ts hand-wrote a copy and that none of it was wired into
// the pipeline -- which was true when it was written and stopped being true when
// the export landed. See docs/baml.md for the Deno boundary, which is still real:
// what crosses is text and a schema, at build time.

/// Every `topics.slug` a generated work may be filed under.
///
/// Mirrors `TOPIC_SLUGS` in `supabase/functions/_shared/providers.ts`, which in
/// turn mirrors the taxonomy seeded by `20260831025500_topics_with_something_behind_them`.
/// An enum rather than a string: a slug outside the list is rejected at the
/// boundary instead of being discovered by `upsertWork`, which silently drops
/// what it cannot look up. If the taxonomy migration changes, this changes in
/// the same commit.
enum TopicSlug {
    Philosophy @alias("philosophy"),
    Ethics @alias("ethics"),
    Stoicism @alias("stoicism"),
    Logic @alias("logic"),
    Metaphysics @alias("metaphysics"),
    Aesthetics @alias("aesthetics"),
    Psychology @alias("psychology"),
    Attention @alias("attention"),
    Habits @alias("habits"),
    Learning @alias("learning"),
    Emotion @alias("emotion"),
    Science @alias("science"),
    Evolution @alias("evolution"),
    Physics @alias("physics"),
    Chemistry @alias("chemistry"),
    Astronomy @alias("astronomy"),
    Medicine @alias("medicine"),
    Society @alias("society"),
    Economics @alias("economics"),
    Liberty @alias("liberty"),
    Government @alias("government"),
    Justice @alias("justice"),
    Education @alias("education"),
    ArtsAndLetters @alias("arts-and-letters"),
    Literature @alias("literature"),
    Rhetoric @alias("rhetoric"),
    Criticism @alias("criticism"),
    History @alias("history"),
    Biography @alias("biography"),
    Revolutions @alias("revolutions"),
    Mathematics @alias("mathematics"),
    Computation @alias("computation"),
    Architecture @alias("architecture"),
    WorldPhilosophy @alias("world-philosophy"),
    Strategy @alias("strategy"),
    Ecology @alias("ecology"),
}

/// The kinds a generated question may take.
///
/// Three of the six `quiz_questions.kind` accepts
/// (`20260905120000_a_question_that_can_be_wrong.sql`). `ordering` and `scenario`
/// are in the database because the column should not have to change when they
/// arrive; `short_answer` is what a reader writes rather than what is generated.
/// Asking for a kind nothing renders would spend tokens on a row `Review` cannot
/// use.
///
/// Aliased to the database's own values. `QuestionKind.Mcq` is `"mcq"` at the
/// boundary and `"Mcq"` in generated TypeScript -- never use the generated
/// identifier as a database value.
enum QuestionKind {
    Recall @alias("recall"),
    Mcq @alias("mcq"),
    Cloze @alias("cloze"),
}

/// Why one particular wrong option is wrong.
///
/// An array of pairs rather than a map from distractor to reason, because Gemini's
/// schema dialect has no map type. `whyWrong` in `apps/web/src/lib/activities.ts`
/// reads exactly this shape and matches on `distractor`.
class DistractorRationale {
    /// The wrong option this explains. Must be one of the question's `distractors`
    /// verbatim, or the client cannot match it to what the reader picked.
    distractor: string,
    /// One sentence on the mistake it represents -- not a restatement of the answer.
    why: string,
}

/// One question, produced by the same call that produced the idea.
///
/// Law 2 is why this rides the synthesis call rather than being its own function:
/// questions are generated once per canonical summary and read by thousands, and a
/// second request per summary would be a second bill for something the model has
/// already read the source for. Grading is a comparison the client does, so no
/// model goes near the read path.
class RecallQuestion {
    kind: QuestionKind,
    prompt: string,
    /// The right answer. For `mcq` it is the option that is correct; for `cloze` it
    /// is what fills the blank.
    answer: string,
    /// The WRONG options, never including the answer. Empty for `recall` and
    /// `cloze`; `mcq` needs at least two, or the question cannot be got wrong and
    /// the database refuses it.
    distractors: string[],
    /// The sentence with the answer removed, marked with four underscores. Required
    /// for `cloze` and omitted otherwise.
    cloze: string?,
    /// Why the answer is the answer, shown after grading whatever the reader picked.
    explanation: string?,
    /// One entry per distractor, for `mcq`. Empty for the kinds that have none.
    rationale: DistractorRationale[],
}

/// One atomic idea that stands on its own out of context, structured for progressive depth.
class Pull {
    /// Shortest stop: states the idea rather than teasing it.
    headline: string,
    /// Short stop: the core claim and reasoning in 1-3 sentences.
    body: string,
    /// Medium stop (impact): what changes if the reader believes it -- not a restatement of the body.
    whyItMatters: string,
    /// Medium stop (concrete grounding): a real case study, historical instance, demonstration, or thought experiment.
    example: string?,
    /// Long stop (in full): the deep-dive analytical breakdown, mechanism, counterarguments, or derivation.
    explanation: string?,
    /// Up to three, of different kinds, most useful first. EMPTY rather than
    /// invented when the source is too thin to support a fair question --
    /// `get_due_reviews` copes with a pull that has none, and a question with a
    /// made-up answer is worse than no question at all.
    ///
    /// AT MOST ONE OF EACH KIND. `quiz_questions_pull_kind_key` is unique on
    /// `(pull_id, kind)`, so two questions of the same kind for one idea are not two
    /// rows -- `questionsToWrite` keeps the first and drops the rest, because an
    /// upsert cannot touch the same row twice in one statement.
    questions: RecallQuestion[],
}

class CanonicalSummary {
    title: string,
    elevatorPitch: string,
    whyItMatters: string,
    /// A summary with no ideas in it is not a summary.
    pulls: Pull[],
    /// One to four, most central first.
    ///
    /// Bounded at both ends deliberately. Unbounded below, an empty array
    /// satisfies the shape and the work is filed under nothing -- `topic_affinity`
    /// then returns 0.0, and that term is 28% of the score in `get_feed`, so the
    /// feature fails silently rather than visibly.
    ///
    /// The bound is NOT declared here, and do not put it back with `@assert`.
    /// v1 accepts v0's `@assert(name, {{ ... }})` without a parse error and then
    /// ignores it: `baml describe` does not show it, `baml.json.schema` lowers no
    /// `minItems`/`maxItems`, and `$parse` on `{"topics": []}` returns an empty
    /// list rather than throwing. Verified against 0.17.0. An annotation that
    /// looks like enforcement and is not is worse than none, so the bound lives
    /// in `BOUNDS` in scripts/export.mjs, reaches the model through Gemini's
    /// `responseSchema`, and is pinned by src/schema.test.ts.
    topics: TopicSlug[],
}

/// Analysis, not reproduction (law 4).
///
/// The prompt asks for claims, arguments and consequences a reader can act on --
/// never a condensed retelling that could stand in for the original. See
/// docs/content-policy.md.
function WriteCanonicalSummary(
    workTitle: string,
    kind: string,
    context: string,
) -> CanonicalSummary {
    // One client, never `SummaryChain`. The worker meters every attempt and decides
    // whether a failure is safe to retry elsewhere; a fallback chosen here would make
    // that decision without a ledger. See the note on `SummaryChain` in clients.baml.
    client: GeminiFlash
    prompt: `
        You are writing for What a Pull, a knowledge feed whose unit is one idea worth keeping.

        Source: ${workTitle}
        Medium: ${kind}

        Write an original analysis of the ideas in this work: its claims, the arguments
        behind them, and what follows from them. Do not retell the work section by section,
        and do not produce anything that could substitute for reading it. Quote only where a
        phrase itself is the point, and keep quotations short.

        Each pull must be one atomic idea that stands on its own out of context, in plain
        language, with a headline that states the idea rather than teasing it. Its
        "whyItMatters" should say what changes if the reader believes it -- not restate
        the body. Provide a concrete "example" to ground the claim in a real case or demonstration,
        and an "explanation" unpacking the full depth, underlying causal mechanism, or nuance for readers
        who choose the deep dive stop.

        For each pull write up to three questions, and AT MOST ONE OF EACH KIND. Three
        recall questions about one idea are one question asked three ways, and only the
        first is kept.

        A "recall" question asks the reader to produce the idea from memory; it has no
        distractors. An "mcq" needs at least two wrong options, each a mistake somebody
        could genuinely make about this idea -- a near-miss, a reversed direction, a
        plausible confusion with a neighbouring idea -- and never a filler option nobody
        would pick. Give each wrong option a "rationale" entry naming the mistake it
        represents, in one sentence, without restating the answer. A "cloze" is one
        sentence of your own analysis with the single word or phrase that carries the
        idea removed and marked "____"; its "answer" is exactly the removed text, and it
        has no distractors.

        Every question carries an "explanation" saying why the answer is the answer.
        Write no question at all for a pull the source is too thin to support one for: a
        question with an invented answer teaches the reader something the work does not
        say.

        File this work under one to four topics, most central first. Choose the narrowest
        that genuinely fit. A parent topic is the right answer only when no child of it
        does — filing a work under a topic it merely touches is worse than filing it under
        fewer.

        Context:
        ${context}

        ${ctx.output_format}
    `
}

/// A public-domain source, so the fixture can live in the repository (law 4).
test "meditations" {
    let res = WriteCanonicalSummary(
        workTitle = "Meditations",
        kind = "book",
        context = `
            The private notebooks of Marcus Aurelius, written on campaign and never
            intended for publication. Recurring themes: the dichotomy of control, the
            brevity of life as an argument for acting well now rather than later, and
            the discipline of assent -- that judgement, not event, is what disturbs.
        `,
    );
    assert.is_true(res.topics.includes(TopicSlug.Stoicism));
    assert.is_true(res.pulls.length() >= 1);
    // At most one question of each kind per pull: `quiz_questions_pull_kind_key` is
    // unique on `(pull_id, kind)`, so a second of the same kind is a row that cannot
    // be written. `questionsToWrite` drops it, and this is where the model is told.
    assert.is_true(res.pulls[0].questions.length() <= 3);
}
