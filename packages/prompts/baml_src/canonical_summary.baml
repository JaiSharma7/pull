// The canonical summary: one generation, read by thousands (law 2).
//
// This is the same contract `_shared/providers.ts` declares as `CanonicalSummary`
// and `_shared/gemini.ts` hand-writes as `SUMMARY_SCHEMA`, expressed once. It is
// not yet wired into the Edge Function pipeline — see docs/baml.md for why that
// crossing is HTTP-shaped and what it is waiting on.

/// Every `topics.slug` a generated work may be filed under.
///
/// Mirrors `TOPIC_SLUGS` in `supabase/functions/_shared/providers.ts`, which in
/// turn mirrors the taxonomy seeded by `20260831025500_topics_with_something_behind_them`.
/// An enum rather than a string: a slug outside the list is rejected at the
/// boundary instead of being discovered by `upsertWork`, which silently drops
/// what it cannot look up. If the taxonomy migration changes, this changes in
/// the same commit.
enum TopicSlug {
  Philosophy @alias("philosophy")
  Ethics @alias("ethics")
  Stoicism @alias("stoicism")
  Logic @alias("logic")
  Metaphysics @alias("metaphysics")
  Aesthetics @alias("aesthetics")
  Psychology @alias("psychology")
  Attention @alias("attention")
  Habits @alias("habits")
  Learning @alias("learning")
  Emotion @alias("emotion")
  Science @alias("science")
  Evolution @alias("evolution")
  Physics @alias("physics")
  Chemistry @alias("chemistry")
  Astronomy @alias("astronomy")
  Medicine @alias("medicine")
  Society @alias("society")
  Economics @alias("economics")
  Liberty @alias("liberty")
  Government @alias("government")
  Justice @alias("justice")
  Education @alias("education")
  ArtsAndLetters @alias("arts-and-letters")
  Literature @alias("literature")
  Rhetoric @alias("rhetoric")
  Criticism @alias("criticism")
  History @alias("history")
  Biography @alias("biography")
  Revolutions @alias("revolutions")
  Mathematics @alias("mathematics")
  Computation @alias("computation")
  Architecture @alias("architecture")
  WorldPhilosophy @alias("world-philosophy")
  Strategy @alias("strategy")
  Ecology @alias("ecology")
}

/// One recall question, produced by the same call that produced the idea.
///
/// `distractors` are what turn the recall interrupt from a self-graded reveal
/// into something that can be wrong — and grading three wrong answers against
/// one right one is a comparison the client does, so no model goes near the
/// read path.
class RecallQuestion {
  prompt: string
  answer: string
  distractors: string[]
}

/// One atomic idea that stands on its own out of context, structured for progressive depth.
class Pull {
  /// Shortest stop: states the idea rather than teasing it.
  headline: string
  /// Short stop: the core claim and reasoning in 1-3 sentences.
  body: string
  /// Medium stop (impact): what changes if the reader believes it -- not a restatement of the body.
  whyItMatters: string
  /// Medium stop (concrete grounding): a real case study, historical instance, demonstration, or thought experiment.
  example: string?
  /// Long stop (in full): the deep-dive analytical breakdown, mechanism, counterarguments, or derivation.
  explanation: string?
  /// Omitted rather than invented when the source is too thin to support a fair
  /// question. `get_due_reviews` already copes with a pull that has none.
  question: RecallQuestion?
}

class CanonicalSummary {
  title: string
  elevatorPitch: string
  whyItMatters: string
  /// A summary with no ideas in it is not a summary.
  pulls: Pull[]
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
  topics: TopicSlug[]
}

/// Analysis, not reproduction (law 4).
///
/// The prompt asks for claims, arguments and consequences a reader can act on --
/// never a condensed retelling that could stand in for the original. See
/// docs/content-policy.md.
function WriteCanonicalSummary(workTitle: string, kind: string, context: string) -> CanonicalSummary {
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
    `
  );
  assert.is_true(res.topics.includes(TopicSlug.Stoicism));
  assert.is_true(res.pulls.length() >= 1);
}