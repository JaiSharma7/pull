/*
 * `renew_source_claim` is dropped, one migration after it was added.
 *
 * It existed for one caller: `embed`, renewing its claim on the source hash when the
 * day's budget refused the embedding step, so that a second job would not pay to
 * synthesise text this job had already synthesised and paid for.
 *
 * The renewal is worse than what it prevented. That wait is re-sent every 900 seconds
 * for up to 24 hours, so renewing on each pass could hold a 30-minute lease until
 * midnight -- and a second job on the same text gets `held` from `claim_source_hash`,
 * waits its own bounded thirty minutes, and is then marked FAILED for doing nothing
 * wrong. Paying twice costs money once; starving every other job on a source is the
 * failure `synthesize`'s own comment gives as the reason it RELEASES its claim on the
 * same refusal. `embed` now does the same, and this function has no callers.
 *
 * A `security definer` function that nobody calls is surface with no owner, which is
 * the argument that dropped `settle_job_budget` in 20260914050000.
 */
drop function if exists public.renew_source_claim(uuid, interval);
