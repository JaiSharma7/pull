import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { policyViolations } from './repository-policy.mjs';

describe('repository policy', () => {
  it('allows new append-only migrations', () => {
    assert.deepEqual(
      policyViolations({
        changes: [{ status: 'A', paths: ['supabase/migrations/202609220001_add_table.sql'] }],
        trackedPaths: [],
      }),
      [],
    );
  });

  it('rejects edits, deletions, and renames of landed migrations', () => {
    const violations = policyViolations({
      changes: [
        { status: 'M', paths: ['supabase/migrations/202609010001_existing.sql'] },
        { status: 'D', paths: ['supabase/migrations/202609010002_deleted.sql'] },
        {
          status: 'R100',
          paths: [
            'supabase/migrations/202609010003_old.sql',
            'supabase/migrations/202609010003_new.sql',
          ],
        },
      ],
      trackedPaths: [],
    });

    assert.equal(violations.length, 3);
    assert.match(violations[0], /append-only/);
  });

  it('rejects tracked local Supabase CLI state', () => {
    const violations = policyViolations({
      changes: [],
      trackedPaths: [
        'supabase/.temp/project-ref',
        'supabase/.branches/current',
        'supabase/.env.local',
      ],
    });

    assert.equal(violations.length, 3);
    assert.ok(violations.every((violation) => violation.includes('local Supabase CLI state')));
  });

  it('does not freeze ordinary repository files', () => {
    assert.deepEqual(
      policyViolations({
        changes: [
          { status: 'M', paths: ['README.md'] },
          { status: 'M', paths: ['packages/db/src/database.types.ts'] },
        ],
        trackedPaths: ['apps/web/.env.production', 'supabase/.env.example'],
      }),
      [],
    );
  });
});
