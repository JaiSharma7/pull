import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_PREFIX = 'supabase/migrations/';
const LOCAL_SUPABASE_STATE =
  /^supabase\/(?:\.temp(?:\/|$)|\.branches(?:\/|$)|\.env\.local$|\.env\.[^/]+\.local$)/;

export function parseNameStatus(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status, paths };
    });
}

export function policyViolations({ changes, trackedPaths }) {
  const violations = [];

  for (const change of changes) {
    const migrationPaths = change.paths.filter((file) => file.startsWith(MIGRATIONS_PREFIX));
    if (migrationPaths.length > 0 && change.status !== 'A') {
      violations.push(
        `Supabase migrations are append-only; ${change.status} is not allowed for ${migrationPaths.join(
          ' -> ',
        )}`,
      );
    }
  }

  for (const file of trackedPaths) {
    if (LOCAL_SUPABASE_STATE.test(file)) {
      violations.push(`Tracked local Supabase CLI state is forbidden: ${file}`);
    }
  }

  return violations;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const base = argument('--base');
  const head = argument('--head') ?? 'HEAD';
  const changes = base
    ? parseNameStatus(git(['diff', '--name-status', '--find-renames', base, head]))
    : [];
  const trackedPaths = git(['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean);
  const violations = policyViolations({ changes, trackedPaths });

  if (violations.length === 0) {
    console.log('Repository policy checks passed.');
    return;
  }

  for (const violation of violations) {
    console.error(process.env.GITHUB_ACTIONS ? `::error::${violation}` : `ERROR: ${violation}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
