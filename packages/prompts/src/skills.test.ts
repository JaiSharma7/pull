/**
 * The two generated `baml-core` skills stay identical.
 *
 * `baml agent install` writes the BAML language reference twice — `.claude/` for Claude
 * Code, `.agents/` for Codex / OpenCode — and both are committed, like `baml_sdk`.
 * `docs/baml.md` asserts they are byte-identical, and until this test nothing checked
 * it: they are in `.prettierignore` (so prettier no longer rewrites them, which is the
 * point), they have no CI staleness gate, and a hand-edit to one copy — or an edit to
 * the copy an agent happens to read — was undetectable.
 *
 * Deliberately NOT a staleness gate against upstream. `baml_sdk` and
 * `generated/prompts.ts` are regenerated from sources in this repository, so "stale"
 * means someone forgot a command. These come from `BoundaryML/baml-skill`, which moves
 * on its own schedule, so a diff against upstream would mean Boundary shipped an edit
 * and would turn CI red on every unrelated PR until someone refreshed it. Divergence
 * between the two copies is a defect; lagging upstream is not.
 *
 * Read as bytes rather than parsed: the failure this catches is an edit, anywhere in the
 * file, including in the frontmatter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../', import.meta.url);
const COPIES = ['.claude/skills/baml-core/SKILL.md', '.agents/skills/baml-core/SKILL.md'];

describe('the generated baml-core skill', () => {
  it('is byte-identical in both agent directories', () => {
    const [claude, agents] = COPIES.map((p) => readFileSync(fileURLToPath(new URL(p, REPO))));
    // Compared as bytes, then reported as text: a Buffer mismatch prints two hex dumps
    // and names no line, which is useless when the difference is one word of prose.
    if (!claude!.equals(agents!)) {
      expect(claude!.toString('utf8')).toBe(agents!.toString('utf8'));
    }
    expect(claude!.equals(agents!)).toBe(true);
  });

  it('is the generator output, not a hand-written file', () => {
    // Cheap proof the copies are what `baml agent install` writes: it prefixes the
    // installed name to avoid registry collisions, so upstream `core` becomes
    // `baml-core`. A hand-rolled replacement would not carry that.
    const claude = readFileSync(fileURLToPath(new URL(COPIES[0]!, REPO)), 'utf8');
    expect(claude).toMatch(/^---\nname: baml-core\n/);
  });
});
