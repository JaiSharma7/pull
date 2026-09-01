-- The fallback provider's Vault path has never been reachable.
--
-- `config.ts` resolves the Claude fallback as:
--
--     env.get('ANTHROPIC_API_KEY') ?? await getSecret('anthropic_api_key')
--
-- and `generation_secret` refuses every name outside `google_ai_api_key` and
-- `worker_dispatch_token`, by RAISING rather than returning null:
--
--     select public.generation_secret('anthropic_api_key');
--     ERROR:  42501: generation_secret: anthropic_api_key is not a worker secret
--
-- The consequence is worse than the fallback being unavailable. The worker's
-- callback is `if (error) throw` — deliberately, because a failure to *ask* is
-- not the same as a secret being unset — so the raise propagates out of
-- `resolveProviders`, out of `providersNow`, and fails the step. A deployment
-- that sets `SUMMARY_FALLBACK_PROVIDER=anthropic` and keeps its key in Vault
-- rather than the environment does not lose its fallback; it stops generating
-- anything at all, on every step, with an error about privileges that names
-- neither the provider nor the setting that caused it.
--
-- `config.test.ts` asserts the Vault IS asked for this name, and passes, because
-- it asserts against a fake `getSecret`. The same shape as the quiz-question
-- conflict target one migration earlier: a fake cannot refuse what Postgres
-- refuses.
--
-- WHY NOW, rather than with the rest of the fallback work. The fallback exists
-- for exactly one situation — the Gemini free tier is metered per model per day,
-- and when it is spent every queued source fails at `synthesize` until the
-- window rolls over. Corpus waves are what spend it. Fixing this after the waves
-- start means discovering it at the moment the queue stalls, which is the moment
-- it is least convenient to redeploy anything.
--
-- The allowlist STAYS AN ENUMERATION. A pattern like `name like '%_api_key'`
-- would fix this and every future provider at once, and that is the argument
-- against it: this function is `security definer` and reads decrypted Vault
-- secrets, so the set of names it will hand out should be a list somebody wrote
-- on purpose, not a shape that a future secret can accidentally match. Three
-- names is not a maintenance burden. Adding the fourth should cost a migration.

create or replace function public.generation_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v text;
begin
  if p_name not in ('google_ai_api_key', 'anthropic_api_key', 'worker_dispatch_token') then
    raise exception 'generation_secret: % is not a worker secret', p_name
      using errcode = 'insufficient_privilege';
  end if;

  select decrypted_secret into v
  from vault.decrypted_secrets
  where name = p_name;

  -- Null when unset. The worker decides whether a missing secret is fatal for the step
  -- it is running: no model key means fall back to the stub provider, not crash.
  return v;
end;
$function$;

comment on function public.generation_secret(text) is
  'Hands the worker one of three named secrets from Vault. An enumeration rather than a pattern: this function is security definer over decrypted secrets, so every name it will disclose is one somebody added deliberately.';
