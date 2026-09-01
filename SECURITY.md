# Security

## Reporting a vulnerability

**security@whatapull.com**, or GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Either is fine; neither needs an account with the service.

Please do not open a public issue for something exploitable. `docs/terms.md` invites
security research and until now gave no channel for it, which is the gap this file
closes.

**What to expect:** an acknowledgement within 3 working days, an assessment within 10,
and credit in the fix commit if you want it. This is a small project — those are honest
targets from one maintainer, not an SLA.

If you have not heard back in a week, assume the mail went astray and chase it.

## What is in scope

The hosted service at whatapull.com, and this repository.

Most valuable, because they are where this design concentrates its risk:

- **RLS.** Every table is protected by a policy rather than by the client, and the
  publishable key is public by construction (law 7 in `CLAUDE.md`). Anything a reader
  can see, write or infer about another reader is the highest-severity finding here,
  and it is worth attacking directly with nothing but the key from
  `apps/web/.env.production`.
- **The `SECURITY DEFINER` functions.** Roughly twenty, each deriving its caller from
  `auth.uid()`. One that can be made to act on a different user is the same class of
  bug as an RLS hole.
- **`enqueue_generation_job` and the worker.** The one definer function reachable by
  any signed-in reader, in front of a worker that holds a service-role key and makes
  outbound requests. `SOURCE_HOST_ALLOWLIST` bounds where it can be sent; a way past
  that is a real finding.
- **The account functions** — deletion, session revocation, recovery codes. Anything
  that lets one account act on another's, or a recovery code spend more than once.

## What is not

- Reports from a scanner with no reproduction. A tool's opinion about a header is not
  a vulnerability; show what an attacker gets.
- Missing hardening headers, absent rate limits on unauthenticated reads, or the
  contents of the client bundle. The bundle is meant to be readable — the code is
  AGPL-3.0 and the publishable key is designed to ship in it.
- Denial of service by volume against the hosted instance. Please do not.
- Social engineering, physical access, or anything involving a third party's account.

## Things we already know

Named here so you do not spend time rediscovering them, and because a repository that
publishes its own open issues is easier to trust than one that does not. All of these
are in `docs/roadmap.md` with more detail.

- `public.enqueue_generation_job` is `SECURITY DEFINER` and callable by signed-in
  readers. Supabase's advisor flags it; it is intentional, and the reasoning is in the
  migration that grants it.
- Leaked-password protection is a dashboard toggle that may not be on yet.
- `packages/ranking`'s parity test runs against a committed fixture rather than
  against the database, so a SQL-side change can pass CI without it.

## Please do not

Test against the hosted service in a way that touches another person's data, degrades
it for other readers, or persists anything you cannot remove. `pnpm db:start` gives you
the whole stack locally, seeded, with the same policies — which is a better place to
attack it from anyway, because you can read the schema while you do.
