/**
 * Shared shapes. These mirror the database enums exactly; the migration that
 * changes one must change the other in the same commit.
 */
export const WORK_KINDS = [
  'book',
  'film',
  'documentary',
  'podcast',
  'paper',
  'essay',
  'lecture',
  'video',
  'interview',
  'other',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const RIGHTS_STATUSES = [
  'public_domain',
  'licensed',
  'user_owned',
  'public_reference',
  'community',
  'review_required',
] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export const STANCES = ['agree', 'disagree', 'unsure'] as const;
export type Stance = (typeof STANCES)[number];

export const RELATION_KINDS = [
  'related',
  'opposes',
  'elaborates',
  'ancestor',
  'descendant',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const INTERRUPT_KINDS = [
  'recall',
  'say_it_back',
  'conviction',
  'counterpull',
  'delta_probe',
] as const;
export type InterruptKind = (typeof INTERRUPT_KINDS)[number];
