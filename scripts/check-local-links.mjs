import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function withoutFencedCode(markdown) {
  let fence;
  return markdown
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*([`~]{3,})/);
      if (match) {
        const marker = match[1][0];
        if (!fence) {
          fence = { marker, length: match[1].length };
        } else if (marker === fence.marker && match[1].length >= fence.length) {
          fence = undefined;
        }
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

function isLocalTarget(target) {
  return (
    target !== '' &&
    !target.startsWith('#') &&
    !target.startsWith('/') &&
    !target.startsWith('//') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

export function localLinkTargets(markdown) {
  const source = withoutFencedCode(markdown);
  const targets = [];

  const inline = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  for (const match of source.matchAll(inline)) {
    const target = match[1] ?? match[2];
    if (isLocalTarget(target)) targets.push(target);
  }

  const reference = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const match of source.matchAll(reference)) {
    const target = match[1] ?? match[2];
    if (isLocalTarget(target)) targets.push(target);
  }

  return targets;
}

function decodedPath(target) {
  const pathname = target.split('#', 1)[0].split('?', 1)[0];
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function repositoryDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return directories;
}

export function validateLocalLinks(
  files,
  trackedPaths = new Set(files.keys()),
  directories = repositoryDirectories(trackedPaths),
) {
  const violations = [];

  for (const [sourcePath, markdown] of files) {
    for (const target of localLinkTargets(markdown)) {
      const targetPath = decodedPath(target);
      if (!targetPath) continue;

      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), targetPath),
      );
      if (!trackedPaths.has(resolved) && !directories.has(resolved.replace(/\/$/, ''))) {
        violations.push(`${sourcePath}: local link target does not exist: ${target}`);
      }
    }
  }

  return violations.sort();
}

function main() {
  const trackedPaths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const markdownPaths = trackedPaths.filter((file) => file.endsWith('.md'));
  const files = new Map(markdownPaths.map((file) => [file, readFileSync(file, 'utf8')]));
  const violations = validateLocalLinks(files, new Set(trackedPaths));

  if (violations.length === 0) {
    console.log(`Local Markdown links passed (${files.size} files).`);
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
