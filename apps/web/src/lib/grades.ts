export const RECALL_GRADES = ['forgot', 'hard', 'good', 'easy'] as const;
export type RecallGrade = (typeof RECALL_GRADES)[number];

export const GRADE_LABELS: Record<RecallGrade, string> = {
  forgot: 'Forgot',
  hard: 'Hard',
  good: 'Got it',
  easy: 'Easy',
};
