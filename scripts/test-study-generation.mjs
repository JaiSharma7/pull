import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/*
 * The study steps against the real database: PostgREST, the RPCs, the triggers.
 *
 * `study-steps.test.ts` proves the steps against an in-memory database, and
 * `supabase/tests/study_generation.sql` proves the SQL against hand-written payloads.
 * Neither proves the two agree -- that the payload `persist_study_course` receives from
 * `study_ground` is one it accepts, that `loadGeneration`'s embed resolves through the
 * composite foreign key, that every journal row the transport writes is one
 * `record_study_stage` will ledger. This runs the real step code (`study-steps.ts`,
 * `study-db.ts`, the journalled transport and the Gemini adapter) against the local
 * stack, with a scripted provider on the wire, and then asks Postgres what happened.
 *
 * Runs as the service role, which is what the worker is. The key is read from
 * `supabase status` at run time and never written anywhere (law 7). Everything it
 * creates is removed at the end, pass or fail.
 */

const require = createRequire(new URL('../supabase/functions/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const { runStudyStep } = await import('../supabase/functions/_shared/study-steps.ts');
const { createStudyDb } = await import('../supabase/functions/_shared/study-db.ts');
const { createGeminiStructuredProvider } =
  await import('../supabase/functions/_shared/structured.ts');
const { STUDY_STEPS, STUDY_NODES } = await import('../supabase/functions/_shared/study-graph.ts');

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function psql(sql) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

function localStack() {
  const raw = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    // The CLI lists stopped services on stderr; the keys are on stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const status = JSON.parse(raw.slice(raw.indexOf('{')));
  const url = status.API_URL;
  const key = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase status did not report an API URL and a service key');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error(
      `refusing to run against ${url}: this test writes, and belongs on the local stack`,
    );
  }
  return { url, key };
}

/** The RPC's answer: the last JSON line, after the `set_config` echoes. */
function lastJson(out) {
  const line = out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`no JSON result in:\n${out}`);
  return line;
}

function assert(condition, message) {
  if (!condition) throw new Error(`study generation e2e: ${message}`);
}

// A self-authored note about a published finding (law 4).
const NOTE = [
  'Roediger and Karpicke (2006) had students read short prose passages.',
  'After reading, one group studied the passage again and another took a recall test on it without feedback.',
  'On a final test five minutes later, the group that restudied remembered more.',
  'On final tests two days and one week later, the group that had taken the recall test remembered more.',
  'These results come from the reported conditions with college students and prose passages.',
].join(' ');

const EXTRACTION = {
  claims: [
    {
      key: 'c1',
      statement: 'At five minutes, restudying produced better recall than the recall test.',
      kind: 'finding',
      qualifications: ['final test five minutes later'],
      evidence: ['On a final test five minutes later, the group that restudied remembered more.'],
      attribution: 'Roediger and Karpicke (2006)',
    },
    {
      key: 'c2',
      statement:
        'At two days and one week, prior retrieval produced better recall than restudying.',
      kind: 'finding',
      qualifications: ['final tests two days and one week later'],
      // Curly quotes and a doubled space: resolved by folding, stored as the source's text.
      evidence: [
        'On final tests two days and  one week later, the group that had taken the recall test remembered more.',
      ],
      attribution: 'Roediger and Karpicke (2006)',
    },
    {
      key: 'c3',
      statement: 'Retrieval practice works better for every learner.',
      kind: 'finding',
      qualifications: [],
      evidence: ['retrieval practice works better for every learner'],
      attribution: null,
    },
  ],
  gaps: ['Whether the result holds for other learners or materials.'],
};

const COURSE = {
  title: 'Immediate versus delayed recall',
  overview: 'Why the better strategy depends on when you are tested.',
  objectives: ['Contrast the five-minute and one-week results.'],
  units: [
    {
      title: 'The timing contrast',
      lessons: [
        {
          key: 'a',
          title: 'Immediate versus delayed',
          objective: 'Explain which strategy won at each delay.',
          claimKeys: ['s1c1', 's1c2'],
          explanation:
            'Restudying won at five minutes; the recall test won at two days and one week.',
          example: null,
          recap: 'Restudy wins immediately; retrieval wins after a delay.',
          minutes: 3,
        },
      ],
    },
  ],
  questions: [
    {
      key: 'p',
      lessonKey: 'a',
      purpose: 'placement',
      kind: 'multiple_choice',
      claimKeys: ['s1c2'],
      prompt: 'Which group remembered more on the one-week test?',
      answer: 'The group that took the recall test',
      acceptedAnswers: [],
      distractors: [
        { distractor: 'The group that restudied', why: 'True only of the five-minute test.' },
        { distractor: 'Neither group differed', why: 'The note reports a difference.' },
      ],
      cloze: null,
      sequence: [],
      pairs: [],
      explanation: 'The delayed tests favoured prior retrieval.',
      difficulty: 1,
    },
    {
      key: 'r',
      lessonKey: null,
      purpose: 'review',
      kind: 'short_recall',
      claimKeys: ['s1c1', 's1c2'],
      prompt: 'Without looking, state how the result depended on the delay.',
      answer:
        'Restudying was better at five minutes; prior retrieval was better at two days and one week.',
      acceptedAnswers: [],
      distractors: [],
      cloze: null,
      sequence: [],
      pairs: [],
      explanation: 'This is the contrast the lesson taught.',
      difficulty: 2,
    },
    {
      key: 'x',
      lessonKey: 'a',
      purpose: 'practice',
      kind: 'multiple_choice',
      claimKeys: ['s1c3'],
      prompt: 'Who benefits from retrieval practice?',
      answer: 'Every learner',
      acceptedAnswers: [],
      distractors: [
        { distractor: 'Only students', why: 'w' },
        { distractor: 'No one', why: 'w' },
      ],
      cloze: null,
      sequence: [],
      pairs: [],
      explanation: 'Invented.',
      difficulty: 1,
    },
  ],
  recap: 'The better strategy depended on the delay, under the reported conditions.',
  disagreements: [],
  withheld: [
    { prompt: 'Does retrieval work better for everyone?', reason: 'The note describes one group.' },
  ],
};

function reply(value) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 },
    }),
    { status: 200 },
  );
}

const { url, key } = localStack();
const supabase = createClient(url, key, { auth: { persistSession: false } });
const db = createStudyDb(supabase);
const provider = createGeminiStructuredProvider({
  apiKey: 'e2e-not-a-key',
  summaryModels: ['gemini-e2e'],
  embeddingModel: 'e',
  inputUsdPerMTok: 0.75,
  outputUsdPerMTok: 3,
  embeddingUsdPerMTok: 0.15,
  maxOutputTokens: 2000,
});

const reader = randomUUID();
const jobs = [];

function enqueue(versionId, goal) {
  const out = psql(`
    begin;
    select set_config('role', 'authenticated', true);
    select set_config('request.jwt.claims', '{"sub":"${reader}","role":"authenticated"}', true);
    select public.enqueue_study_generation(array['${versionId}'::uuid], '${goal}', '${randomUUID()}', true)::text;
    commit;`);
  const job = JSON.parse(lastJson(out));
  jobs.push(job.jobId);
  return job.jobId;
}

/** What the worker does around each step, minus the queue: read, run, record. */
async function walk(jobId, fetchImpl) {
  const { data: job, error } = await supabase
    .from('generation_jobs')
    .select('id, kind, target, work_id, summary_id, visibility, requester_id')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  for (const step of STUDY_STEPS) {
    let result;
    let attempt = 0;
    do {
      attempt += 1;
      const { data: priorOutputs, error: readError } = await supabase.rpc('job_step_outputs', {
        p_job_id: jobId,
        p_steps: [...STUDY_NODES[step].needs],
      });
      if (readError) throw readError;
      result = await runStudyStep(step, {
        job,
        priorOutputs: priorOutputs ?? {},
        provider,
        db,
        fetchImpl,
      });
      assert(attempt < 20, `${step} never stopped continuing`);
      // The worker settles a continuing step's hold itself; `record_study_stage` does not.
      if (result.continue) {
        const { error: settleError } = await supabase.rpc('settle_budget', {
          p_job_id: jobId,
          p_step: step,
        });
        if (settleError) throw settleError;
      }
    } while (result.continue);
    const { error: recordError } = await supabase.rpc('record_job_step', {
      p_job_id: jobId,
      p_step: step,
      p_attempt: 1,
      p_model: result.model ?? null,
      p_prompt_version: null,
      p_input_tokens: 0,
      p_output_tokens: 0,
      p_cost_cents: 0,
      p_duration_ms: 0,
      p_provider: 'none',
      p_billable: false,
      p_output: result.output ?? null,
    });
    if (recordError) throw recordError;
  }
}

try {
  psql(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at, is_anonymous,
                            raw_app_meta_data, raw_user_meta_data)
    values ('${reader}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'study-e2e-${reader}@example.test', '', now(), now(), now(), false, '{}', '{}');
    insert into public.study_generation_access (user_id) values ('${reader}');`);
  const saved = JSON.parse(
    lastJson(
      psql(`
      begin;
      select set_config('role', 'authenticated', true);
      select set_config('request.jwt.claims', '{"sub":"${reader}","role":"authenticated"}', true);
      select public.save_study_source_version('My notes', 'paste', $note$${NOTE}$note$, '${randomUUID()}')::text;
      commit;`),
    ),
  );

  // First course: a 503, then the claim map, then the course.
  const answers = [new Response('busy', { status: 503 }), reply(EXTRACTION), reply(COURSE)];
  let sent = 0;
  const scripted = async () => {
    sent += 1;
    const next = answers.shift();
    if (!next) throw new Error('the scripted provider was asked more times than it has answers');
    return next;
  };
  const first = enqueue(saved.versionId, 'Explain the argument');
  await walk(first, scripted);
  assert(sent === 3, `expected three provider attempts, saw ${sent}`);

  const [claims, rejected, spans, items, rejectedItems, withheld] = psql(`
    select count(*) from public.study_claims c join public.study_generations g on g.id = c.generation_id where g.job_id = '${first}';
    select count(*) from public.study_claims c join public.study_generations g on g.id = c.generation_id
      where g.job_id = '${first}' and c.status = 'rejected' and c.rejection_reasons = array['evidence_missing'];
    select count(*) from public.study_claim_evidence e
      join public.study_claims c on c.id = e.claim_id
      join public.study_generations g on g.id = c.generation_id
      join public.study_source_versions v on v.id = c.source_version_id
      where g.job_id = '${first}' and e.match <> 'unresolved'
        and substr(v.extracted_text, e.start_offset + 1, e.end_offset - e.start_offset) = e.span_text;
    select count(*) from public.study_items i join public.study_generations g on g.id = i.generation_id where g.job_id = '${first}';
    select count(*) from public.study_items i join public.study_generations g on g.id = i.generation_id
      where g.job_id = '${first}' and i.status = 'rejected';
    select jsonb_array_length(withheld) from public.study_generations where job_id = '${first}';`)
    .split('\n')
    .map(Number);
  assert(claims === 3, `expected 3 claims, got ${claims}`);
  assert(
    rejected === 1,
    `expected the invented claim rejected for missing evidence, got ${rejected}`,
  );
  assert(
    spans === 2,
    `expected 2 evidence spans that are the stored text at their offsets, got ${spans}`,
  );
  assert(
    items === 3 && rejectedItems === 1,
    `expected 3 questions with 1 rejected, got ${items}/${rejectedItems}`,
  );
  assert(withheld === 1, 'the unanswerable question was not withheld');

  // `study_validate` decided what a learner may be shown: the two grounded claims, the
  // lesson built on them and both questions resting on them, and nothing else. Every
  // decision is on the status log.
  const [validClaims, validLessons, validItems, logged] = psql(`
    select count(*) from public.study_claims c join public.study_generations g on g.id = c.generation_id
      where g.job_id = '${first}' and c.status = 'validated';
    select count(*) from public.study_lessons l join public.study_generations g on g.id = l.generation_id
      where g.job_id = '${first}' and l.status = 'validated';
    select count(*) from public.study_items i join public.study_generations g on g.id = i.generation_id
      where g.job_id = '${first}' and i.status = 'validated';
    select count(*) from public.study_status_log s
      join public.study_items i on i.id = s.item_id
      join public.study_generations g on g.id = i.generation_id
      where g.job_id = '${first}' and s.to_status = 'validated' and s.reason = 'validation';`)
    .split('\n')
    .map(Number);
  assert(
    validClaims === 2 && validLessons === 1 && validItems === 2 && logged === 2,
    `expected 2 claims, 1 lesson and 2 questions validated (and logged), got ` +
      `${validClaims}/${validLessons}/${validItems} (${logged} logged)`,
  );

  // The job's course now shows it: the current generation, its one lesson in the outline
  // and its two questions, and a bundle of the one source.
  const [current, outlined, listed, bundled] = psql(`
    select count(*) from public.study_course_overview o
      join public.study_generations g on g.course_id = o.course_id
      where g.job_id = '${first}' and o.generation_id = g.id and o.lesson_count = 1 and o.question_count = 2;
    select count(*) from public.study_generations g
      cross join lateral public.study_course_outline(g.course_id) o where g.job_id = '${first}';
    select count(*) from public.study_generations g
      cross join lateral public.study_course_questions(g.course_id) q where g.job_id = '${first}';
    select count(*) from public.study_course_sources s
      join public.study_generations g on g.course_id = s.course_id where g.job_id = '${first}';`)
    .split('\n')
    .map(Number);
  assert(
    current === 1 && outlined === 1 && listed === 2 && bundled === 1,
    `the course read path shows ${current}/${outlined}/${listed}/${bundled}`,
  );

  const [journalled, ledgered, unledgered, open] = psql(`
    select count(*) from public.provider_calls where job_id = '${first}';
    select count(*) from public.cost_ledger where job_id = '${first}' and provider_call_id is not null;
    select count(*) from public.provider_calls pc left join public.cost_ledger cl on cl.provider_call_id = pc.id
      where pc.job_id = '${first}' and cl.id is null;
    select count(*) from public.provider_calls where job_id = '${first}' and outcome = 'open';`)
    .split('\n')
    .map(Number);
  assert(journalled === 3 && ledgered === 3, `journal ${journalled} vs ledger ${ledgered}`);
  assert(unledgered === 0 && open === 0, `${unledgered} unledgered and ${open} open attempts`);

  const [held, jobCost, ledgerCost] = psql(`
    select count(*) from public.budget_reservations where job_id = '${first}' and settled_at is null;
    select cost_cents from public.generation_jobs where id = '${first}';
    select sum(cost_cents) from public.cost_ledger where job_id = '${first}';`)
    .split('\n')
    .map(Number);
  assert(held === 0, 'a study stage left a budget hold open');
  assert(
    jobCost === ledgerCost && jobCost > 0,
    `job cost ${jobCost} disagrees with its ledger ${ledgerCost}`,
  );

  // Second course over the same material and goal: every stage is a cache hit.
  const second = enqueue(saved.versionId, 'Explain the argument');
  sent = 0;
  await walk(second, async () => {
    sent += 1;
    throw new Error('a cached course asked the provider again');
  });
  assert(sent === 0, 'the cached course made a provider call');
  const [secondCalls, secondClaims] = psql(`
    select count(*) from public.provider_calls where job_id = '${second}';
    select count(*) from public.study_claims c join public.study_generations g on g.id = c.generation_id where g.job_id = '${second}';`)
    .split('\n')
    .map(Number);
  assert(
    secondCalls === 0 && secondClaims === 3,
    `second course: ${secondCalls} calls, ${secondClaims} claims`,
  );

  process.stdout.write('study generation e2e: ok\n');
} finally {
  if (jobs.length > 0) {
    const list = jobs.map((j) => `'${j}'`).join(', ');
    psql(`
      delete from public.cost_ledger where job_id in (${list});
      delete from public.provider_calls where job_id in (${list});
      delete from public.generation_jobs where id in (${list});
      select pgmq.delete('generation', msg_id) from pgmq.q_generation where message ->> 'jobId' in (${list});`);
  }
  psql(`delete from auth.users where id = '${reader}';`);
}
