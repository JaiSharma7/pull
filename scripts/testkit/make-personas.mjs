#!/usr/bin/env node
/**
 * Build the test accounts on the local stack.
 *
 *   pnpm personas                 rebuild every account
 *   pnpm personas reader lapsed   rebuild only those
 *
 * Rebuild, not top up. Each account is deleted and recreated, because a persona is only
 * useful if it is the same on Tuesday as it was on Monday: two recordings of a screen
 * are comparable only when the state behind them is. `first-run` makes the point on its
 * own — answering onboarding once spends it, and every later run would record a
 * different screen.
 *
 * Deletion is bounded by construction: only addresses this file's persona list produced,
 * only ever `@pull.test`, and only against a stack `stack.mjs` has proved is loopback.
 *
 * ── how the state is built ──────────────────────────────────────────────────────────
 *
 * Through the app's own API, under the persona's own token — `record_read`,
 * `grade_recall`, `set_conviction`, an insert into `saved_items`. Not as `service_role`
 * and not as `postgres`. A fixture written with an admin credential can sit in a state
 * no reader could ever reach, and a bug reproduced from one of those is not a bug.
 *
 * Then one step that is *not* the app's: the backdating. `record_read` stamps `now()`
 * by design, so a hundred RPC calls produce a reader who did everything this second —
 * no decay, no due reviews, an empty Delta, a History with one date on it. Time passing
 * is the one thing the write path cannot fake, so it is faked here, in SQL, and kept
 * deliberately small and visible rather than spread through the seeding above.
 */
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { ACCOUNTS, personaByKey } from './personas.mjs';
import { admin, asReader, localStack, sessionFor } from './stack.mjs';

const GRADES = ['good', 'good', 'easy', 'hard', 'good', 'forgot'];
const STANCES = ['agree', 'disagree', 'unsure'];

/** Deterministic and seeded by key, so two personas do not read the same nine Pulls. */
function rotate(list, key) {
  const offset = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

async function removeIfPresent(stack, email) {
  const page = await admin(stack, `admin/users?per_page=200`, undefined, 'GET');
  const existing = (page.users ?? []).filter((u) => u.email === email);
  for (const user of existing) {
    await admin(stack, `admin/users/${user.id}`, undefined, 'DELETE');
  }
  return existing.length;
}

async function seed(stack, persona) {
  const { seed: plan } = persona;
  const { accessToken, userId } = await sessionFor(stack, persona.email);
  const rest = (path, opts) => asReader(stack, accessToken, path, opts);

  if (!plan.onboarded) return { userId, wrote: 'nothing — onboarding is unanswered' };

  await rest(`preference_profiles?user_id=eq.${userId}`, {
    method: 'PATCH',
    body: {
      onboarded_at: new Date().toISOString(),
      topic_weights: plan.topicWeights ?? {},
      daily_minutes: 15,
    },
  });

  const pulls = rotate(
    await rest('pulls?select=id,summary_id&order=id&limit=200', { method: 'GET' }),
    persona.key,
  );

  const read = pulls.slice(0, plan.reads ?? 0);
  for (const [i, pull] of read.entries()) {
    // A dwell time that varies: `record_read` keeps the larger of two, and a column of
    // identical numbers hides the History screen's own formatting of them.
    await rest('rpc/record_read', {
      body: { p_pull_id: pull.id, p_dwell_ms: 14_000 + ((i * 3617) % 46_000), p_position: i },
    });
  }

  for (const [i, pull] of read.slice(0, plan.grades ?? 0).entries()) {
    await rest('rpc/grade_recall', {
      body: { p_pull_id: pull.id, p_grade: GRADES[i % GRADES.length] },
    });
  }

  for (const [i, pull] of read.slice(0, plan.convictions ?? 0).entries()) {
    await rest('rpc/set_conviction', {
      body: {
        p_pull_id: pull.id,
        p_stance: STANCES[i % STANCES.length],
        p_confidence: 0.55 + i * 0.1,
      },
    });
  }

  const stashIds = [];
  for (const [i, name] of (plan.stashes ?? []).entries()) {
    const [row] = await rest('stashes', {
      body: { user_id: userId, name, position: i },
      headers: { Prefer: 'return=representation' },
    });
    stashIds.push(row.id);
  }

  const saves = read.slice(0, plan.saves ?? 0);
  if (saves.length) {
    await rest('saved_items', {
      body: saves.map((pull, i) => ({
        user_id: userId,
        // `pull_id` alone: `saved_items_one_target` allows exactly one target, and
        // `save()` in lib/api.ts saves a Pull. Mirroring it keeps the fixture honest.
        pull_id: pull.id,
        stash_id: stashIds.length ? stashIds[i % stashIds.length] : null,
        read_later: i % 5 === 0,
      })),
    });
  }

  return {
    userId,
    wrote: `${read.length} reads · ${plan.grades ?? 0} graded · ${plan.convictions ?? 0} convictions · ${saves.length} saved in ${stashIds.length} ${stashIds.length === 1 ? 'stash' : 'stashes'}`,
  };
}

/**
 * Push a persona's whole history into the past.
 *
 * Everything the RPCs stamped `now()` moves back by `ageDays`, spread across that window
 * rather than landing on one date — History groups by day, and a single bucket is not a
 * screen anybody has. `next_due_at` moves with `last_seen_at`, which is what turns the
 * lapsed reader's queue red instead of empty.
 */
function backdate(dbUrl, userId, days) {
  const sql = `
    update public.history_events
       set created_at  = created_at  - (random() * ${days} || ' days')::interval
     where user_id = '${userId}';
    update public.feed_impressions
       set shown_at = shown_at - (random() * ${days} || ' days')::interval
     where user_id = '${userId}';
    update public.knowledge_states k
       set last_seen_at = now() - (random() * ${days} || ' days')::interval
     where user_id = '${userId}';
    update public.knowledge_states
       set next_due_at = last_seen_at + (stability || ' days')::interval
     where user_id = '${userId}';
    update public.saved_items
       set created_at = created_at - (random() * ${days} || ' days')::interval
     where user_id = '${userId}';
    update public.convictions
       set created_at = created_at - (random() * ${days} || ' days')::interval
     where user_id = '${userId}';
  `;
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/**
 * Delete a persona's account and build it again from nothing.
 *
 * Exported because the recorder needs it, not only the command line. `first-run` is the
 * reason: its whole tour is the onboarding screens, and walking them once sets
 * `onboarded_at` — so the second device pass of a run would record a reader who has
 * already been onboarded, and the recorder would sit clicking a "Continue" that is no
 * longer on the screen. That is exactly what the first full run did.
 */
export async function rebuild(stack, persona) {
  const removed = await removeIfPresent(stack, persona.email);
  await admin(stack, 'admin/users', {
    email: persona.email,
    email_confirm: true,
    user_metadata: { full_name: persona.fullName },
  });

  const { userId, wrote } = await seed(stack, persona);
  if (persona.seed.ageDays) backdate(stack.dbUrl, userId, persona.seed.ageDays);
  return { userId, wrote, existed: removed > 0 };
}

async function main() {
  const wanted = argv.slice(2);
  const chosen = wanted.length ? wanted.map(personaByKey).filter((p) => !p.guest) : ACCOUNTS;

  const stack = localStack();
  console.log(`stack ${stack.apiUrl}\n`);

  for (const persona of chosen) {
    const { wrote, existed } = await rebuild(stack, persona);
    console.log(`${persona.key.padEnd(10)} ${persona.email}`);
    console.log(`${''.padEnd(10)} ${existed ? 'rebuilt' : 'created'} · ${wrote}`);
    if (persona.seed.ageDays)
      console.log(`${''.padEnd(10)} aged over ${persona.seed.ageDays} days`);
    console.log();
  }

  console.log('Sign in with `pnpm record`, which mints a fresh single-use link per run.');
  console.log('To sign in by hand, run `pnpm personas:link <key>`.');
}

if (import.meta.url === pathToFileURL(argv[1]).href) await main();
