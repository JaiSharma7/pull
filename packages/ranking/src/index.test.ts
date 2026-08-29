import { expect, it } from 'vitest';
import { RANKING_VERSION } from './index.js';
it('exposes a ranking version', () => expect(RANKING_VERSION).toBeGreaterThan(0));
