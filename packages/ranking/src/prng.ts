import { createHash } from 'node:crypto';

/**
 * Deterministic uniform draw in [0, 1).
 *
 * This must produce bit-identical results to `public.seeded_unit` in SQL, which
 * is the authoritative implementation:
 *
 *   ('x' || substr(md5(seed:page:slot:salt), 1, 13))::bit(52)::bigint / 2^52
 *
 * 13 hex characters is exactly 52 bits, which is also the precision of a JS
 * double's mantissa — so the division is exact on both sides and neither
 * implementation rounds where the other does not.
 */
export function seededUnit(seed: bigint | number, page: number, slot: number, salt = ''): number {
  const digest = createHash('md5').update(`${seed}:${page}:${slot}:${salt}`).digest('hex');
  return Number(BigInt(`0x${digest.slice(0, 13)}`)) / 2 ** 52;
}
