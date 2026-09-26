/**
 * The study course API's own decisions, on the requests it actually sends: an address that
 * names no course, a list that says when it was cut, and a restore that settles every open
 * report on what it restores.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { table: string; method: string; args: unknown[] }[] = [];
const rpcs: { name: string; args: unknown }[] = [];
let rows: unknown[] = [];
let total: number | null = null;
let rpcError: { code: string; message: string } | null = null;

vi.mock('./supabase.js', () => {
  const builder = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit', 'abortSignal']) {
      self[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return self;
      };
    }
    self.then = (resolve: (r: { data: unknown[]; error: null; count: number | null }) => unknown) =>
      resolve({ data: rows, error: null, count: total });
    return self;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: unknown) => {
        rpcs.push({ name, args });
        const error = rpcError;
        return Promise.resolve({ data: null, error });
      },
    },
  };
});

const { COURSE_LIST_LIMIT, fetchCourse, fetchCourses, restoreReported } =
  await import('./study-course-api.js');

beforeEach(() => {
  calls.length = 0;
  rpcs.length = 0;
  rows = [];
  total = null;
  rpcError = null;
});

describe('fetchCourse', () => {
  it('reads an address that is not a course id as no course, without asking', async () => {
    expect(await fetchCourse('not-a-uuid')).toBeNull();
    expect(calls).toHaveLength(0);
    await fetchCourse('1774F07A-45DC-44B5-B60B-4EB317ED3C8C');
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'course_id')).toBe(true);
  });
});

describe('fetchCourses', () => {
  it('counts the courses, and says when there are more than the list shows', async () => {
    rows = Array.from({ length: COURSE_LIST_LIMIT }, (_, i) => ({
      course_id: `c${i}`,
      goal: 'Explain it',
    }));
    total = COURSE_LIST_LIMIT + 50;
    const list = await fetchCourses();
    expect(calls).toContainEqual({
      table: 'study_course_overview',
      method: 'select',
      args: ['*', { count: 'exact' }],
    });
    expect(calls).toContainEqual({
      table: 'study_course_overview',
      method: 'limit',
      args: [COURSE_LIST_LIMIT],
    });
    expect(list.courses).toHaveLength(COURSE_LIST_LIMIT);
    expect(list.more).toBe(true);
    rows = rows.slice(0, 3);
    total = 3;
    expect((await fetchCourses()).more).toBe(false);
  });
});

describe('restoreReported', () => {
  it('dismisses every open report on its target, settled ones counting as done', async () => {
    rows = [{ id: 'r1' }, { id: 'r2' }];
    await restoreReported({ kind: 'claim', id: 'c1' });
    expect(calls).toContainEqual({
      table: 'study_reports',
      method: 'eq',
      args: ['claim_id', 'c1'],
    });
    expect(calls).toContainEqual({
      table: 'study_reports',
      method: 'eq',
      args: ['status', 'open'],
    });
    expect(rpcs.map((r) => r.args)).toEqual([{ p_report_id: 'r1' }, { p_report_id: 'r2' }]);

    rpcs.length = 0;
    rpcError = { code: '55000', message: 'that report is already resolved' };
    await expect(restoreReported({ kind: 'lesson', id: 'l1' })).resolves.toBeUndefined();
    expect(rpcs).toHaveLength(2);

    rpcError = { code: '55P03', message: 'another change is being saved' };
    await expect(restoreReported({ kind: 'lesson', id: 'l1' })).rejects.toThrow();
  });
});
