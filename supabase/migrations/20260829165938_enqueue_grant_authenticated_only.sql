-- Postgres grants EXECUTE to PUBLIC by default on a new function, so granting
-- to `authenticated` did not stop `anon` reaching it. The function raises
-- without a session, so an anonymous call failed safely — but an unauthenticated
-- caller could still reach a SECURITY DEFINER endpoint, which the security
-- advisor is right to flag. Revoke first, then grant.
--
-- The remaining advisor note — that `authenticated` can call it — is intentional
-- and cannot be designed away: this IS the endpoint a signed-in reader uses to
-- request a generation, and it must be SECURITY DEFINER because the insert and
-- the pgmq.send have to share a transaction, which the authenticated role has
-- no privilege on pgmq to do itself. It is safe because the function derives
-- the requester from auth.uid() rather than trusting a parameter, and enforces
-- the daily quota internally.
revoke all on function public.enqueue_generation_job(jsonb, int, int)
  from public, anon, authenticated;

grant execute on function public.enqueue_generation_job(jsonb, int, int)
  to authenticated;
