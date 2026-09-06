/**
 * BAML's enum member names are not the database's question kinds.
 *
 * The same trap `topics.ts` exists for, one enum along. `QuestionKind.Mcq` carries
 * the *value* `"Mcq"` in generated TypeScript — the `@alias("mcq")` only shapes the
 * prompt and the parse. Handing that value to `insertQuizQuestions` would look like a
 * successful classification and be refused by `quiz_questions_kind_known`, which
 * fails the whole synthesis step after the model call has already been paid for.
 * That is worse than the topics case, where the row merely landed under nothing.
 *
 * So the crossing is written down once, exhaustively. `Record<QuestionKind, string>`
 * is total by construction: adding a member to the BAML enum without adding its kind
 * here fails `pnpm typecheck`, in the same commit.
 */
// `import type`, deliberately: `baml_sdk/index.ts` calls
// `initializeRuntimeFromBytecode` at module scope, so a value import would boot the
// native addon in every consumer of this package. `src/boundary.test.ts` enforces it.
import type { QuestionKind } from '../baml_sdk/index.js';

/**
 * Every generated kind, and the value `quiz_questions.kind` stores for it.
 *
 * The column allows three more — `short_answer`, `ordering` and `scenario` — which
 * are authored rather than generated and therefore have no member here. That
 * asymmetry is deliberate and runs the safe way: everything a model can return is
 * storable, and not everything storable can be returned by a model.
 */
export const QUESTION_KIND_BY_MEMBER: Record<QuestionKind, string> = {
  Recall: 'recall',
  Mcq: 'mcq',
  Cloze: 'cloze',
};
