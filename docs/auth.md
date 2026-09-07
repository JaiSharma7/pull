# Signing in

Four ways into this product, and only one of them needs a mailbox.

| Route                   | What it costs us                    | Where it is configured                    |
| ----------------------- | ----------------------------------- | ----------------------------------------- |
| **Google**              | Nothing per sign-in                 | Supabase dashboard + Google Cloud console |
| **Microsoft** (`azure`) | Nothing per sign-in                 | Supabase dashboard + Entra app            |
| **Email code**          | One email, from a rate-limited pool | `supabase/config.toml`, hosted templates  |
| **Guest**               | A row the sweep deletes in a day    | `enable_anonymous_sign_ins`               |

The order is deliberate and is the order the sign-in screen shows them in.

## Why the providers lead

Supabase's built-in SMTP is **rate-limited per hour and counts requests rather than
deliveries**. A handful of sign-ups, or one script pointed at the form, spends the budget,
and the next real reader is told to wait for a window that each retry pushes further out.
That is not a hypothetical: it locked the owner of this product out of it for two hours on
2026-08-31, and `Auth.tsx` carries the escape hatch built that afternoon.

Fixing it properly means a paid transactional sender. A provider avoids the problem rather
than paying to survive it: the credential is one the reader already holds, delivery is
somebody else's problem, and a bot with a throwaway address has to get past Google or
Microsoft before it reaches us. It also answers a question the email route could not —
`handle_new_user` gets a display name from the provider's metadata, so the username screen
can offer a name instead of an empty field.

The email route stays, collapsed behind a disclosure. It is the only route that works with
no third party at all, and a reader who does not want Google to know they have an account
here is making a reasonable choice.

## What this repository can and cannot set

`supabase/config.toml` configures **the local stack and nothing else**. Both providers are
`enabled = false` there on purpose: a contributor should not have to register an OAuth
application to run `pnpm dev`, and the local stack's Inbucket catches the email code
anyway.

A client secret is server-side configuration by definition (law 7), so there is nowhere in
this tree it could live. Everything below is done by hand, once, per hosted project.

### 1. Google

1. Google Cloud console → **APIs & Services → Credentials → Create credentials → OAuth
   client ID**, type **Web application**.
2. Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. This is
   Supabase's callback, not the app's — GoTrue receives the provider's response and then
   redirects to whatever `redirectTo` the browser asked for.
3. Configure the OAuth consent screen. While it is in **Testing**, only the accounts listed
   there can sign in, and everybody else gets "access blocked" — which reads exactly like a
   bug in this app.
4. Supabase dashboard → **Authentication → Sign In / Providers → Google**: paste the client
   id and secret, enable.

### 2. Microsoft

1. Entra admin centre → **App registrations → New registration**. Supported account types:
   **accounts in any organizational directory and personal Microsoft accounts**, which is
   what "sign in with Microsoft" means to a reader. A single-tenant registration silently
   refuses everybody outside that one organisation.
2. Redirect URI (platform **Web**):
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Certificates & secrets → New client secret**. Copy the _value_, not the id, and note
   the expiry — a secret that expires takes the route down with no warning anywhere.
4. Supabase dashboard → **Authentication → Sign In / Providers → Azure**: client id,
   secret, and leave the URL as the default (`https://login.microsoftonline.com/common`)
   unless this deployment is deliberately single-tenant.

The app asks Microsoft for the `email` scope explicitly (`lib/oauth.ts`). An Entra
registration returns an id token with no email claim by default, and GoTrue then has no
address to key the account by.

### 3. Redirect allow-list, for both

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL** — the production origin. When this is wrong, sign-in _succeeds_ and then
  303s the session to an address that does not serve this app; the auth log records
  `action: login` and the reader gets a dead page. `parseSignInLink` exists because of it.
- **Redirect URLs** — every origin a reader may complete a sign-in on, including preview
  deployments. The app sends one shape (`<origin>/?next=…`, see `signInRedirectTo`), so
  one line per origin is enough.

## What arrives with a provider sign-in, and what is done with it

GoTrue stores the provider's profile in `auth.users.raw_user_meta_data`: the email address,
the name on the account, usually a picture URL. `handle_new_user` (20260906090000) reads
**only** the name, from `full_name` or `name`, and puts it in `profiles.display_name`.

Two rules hold there, and both are enforced in SQL rather than trusted to a caller:

- **A handle is never derived from an address** (20260901120000). Sign-up still generates
  `reader_` plus sixteen hex characters, whichever route the reader came in by.
- **A display name that contains an `@` is dropped.** Some Entra tenants set the `name`
  claim to the user principal name, which is an email address; storing it would undo the
  rule above through a different column.

The name is then _offered_ — pre-filled into the username screen, where the reader can edit
it, clear it, or walk past. `docs/privacy.md` says all of this to the reader.

## Usernames

`profiles.handle` is `citext`, unique, `^[a-z0-9_]{3,30}$`. `claim_handle(text)` is the only
route the app offers: it normalises case and whitespace, refuses reserved names and anything
wearing the generated `reader_` shape, and reports a name somebody else holds as `23505`
with a sentence rather than an index name. `handle_set_at` is null until the reader chooses,
which is how the onboarding gate knows whether to ask.

Guests are refused a username outright. The namespace is global and a guest session costs
nothing to mint, so a pool of addresses could sit on every good name for a day at a time —
and a guest has nothing to gain, since that session can never be reopened.

There is **no directory**: `profiles_read_own` means a reader can read their own row and
nobody else's, so a username cannot be looked up. A public profile is a decision somebody
makes, not the absence of a policy (law 5). Today the username's only job is to travel with
a Pull the reader hands to somebody.

## When a route is shut

Each failure is reported twice, to two audiences, which is the pattern `auth-errors.ts`
already followed for guest sessions and CAPTCHA:

| Symptom                                            | What it means                              |
| -------------------------------------------------- | ------------------------------------------ |
| `Unsupported provider: provider is not enabled`    | No credentials in the dashboard for it yet |
| `access_denied` back on the query string           | The reader pressed Cancel. Not an error    |
| Sign-in succeeds, reader lands on a page that 404s | Site URL, or the redirect allow-list       |
| `captcha protection: request disallowed`           | CAPTCHA is on and this app sends no token  |

The console gets the name of the switch, because only an operator can act on it. The reader
gets the sentence that names which door is still open.
