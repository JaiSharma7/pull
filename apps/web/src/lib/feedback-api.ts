import type { FeedbackSubject } from '@wap/schemas';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * Sending feedback, which is an insert and deliberately not an RPC.
 *
 * Every rule this write has to obey is already stated in the schema —
 * `feedback_insert_own` decides whose row it is, three check constraints bound the
 * message, the subject and the path, and `feedback_rate_limit` bounds how many. A
 * `security definer` function wrapping all that would add a second place for those
 * rules to live and a second place for them to drift, which is the failure
 * `preferences-api.ts` names about itself for the same reason.
 *
 * NOT a mailto: link, which is the whole point of the feature. A mail client sends the
 * reader somewhere else, loses them, and produces a message from an address we then
 * have to associate back to an account by hand. This lands a row.
 */

/** The rate limit refuses with SQLSTATE 53400 — `configuration_limit_exceeded`. */
const RATE_LIMITED = '53400';

/** A duplicate `client_mutation_id`: the same send arriving twice. */
const ALREADY_SENT = '23505';

export interface FeedbackDraft {
  subject: FeedbackSubject;
  message: string;
  path: string | null;
  /**
   * Minted before the send, so a retry after a lost response collides with the first
   * attempt on `feedback_mutation_idx` rather than filing the same complaint twice.
   * `remember_pull` takes the same precaution for the same reason.
   */
  mutationId: string;
}

export class FeedbackRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackRateLimited';
  }
}

export async function sendFeedback(userId: string, draft: FeedbackDraft): Promise<void> {
  const { error } = await supabase.from('feedback').insert({
    user_id: userId,
    subject: draft.subject,
    message: draft.message,
    path: draft.path,
    client_mutation_id: draft.mutationId,
  });

  if (!error) return;

  /*
   * A COLLISION IS A SUCCESS, and treating it as one is what makes the retry safe.
   *
   * The first attempt reached the database and the response was lost on the way back,
   * so the row exists and the reader is looking at a failure message. Reporting that
   * as an error would have them send it again, or worse, give up believing it never
   * arrived.
   */
  if (error.code === ALREADY_SENT) return;

  if (error.code === RATE_LIMITED) {
    // The database's own sentence, which says how to proceed. Wrapped in a named
    // error rather than a generic one so the screen can decide to say it differently
    // without parsing a message.
    throw new FeedbackRateLimited(error.message);
  }

  throw rpcError(error);
}
