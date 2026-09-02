export interface PreviewLayer {
  heading?: string;
  text: string;
}

export interface PreviewPull {
  headline: string;
  source: {
    title: string;
    creator: string;
    kind: string;
    year: string;
    trail: string;
    url: string;
  };
  layers: readonly PreviewLayer[];
}

export interface PreviewState {
  phase: 'gate' | 'contents' | 'reading';
  count: number;
  depths: readonly number[];
}

export type PreviewAction =
  | { type: 'choose'; count: number }
  | { type: 'begin' }
  | { type: 'depth'; index: number; depth: number }
  | { type: 'restart' };

export const initialPreviewState: PreviewState = { phase: 'gate', count: 0, depths: [] };

export function wordCount(...parts: string[]): number {
  return parts.reduce((total, part) => {
    const clean = part.trim();
    return total + (clean ? clean.split(/\s+/).length : 0);
  }, 0);
}

export function clockForWords(words: number): string {
  if (words <= 0) return '0 sec';
  const seconds = Math.round((words / 210) * 60);
  if (seconds < 60) return `${Math.max(10, Math.round(seconds / 5) * 5)} sec`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function visibleWords(pull: PreviewPull, depth: number): number {
  const bounded = Math.max(0, Math.min(4, Math.trunc(depth)));
  const layers = pull.layers.slice(0, bounded);
  return wordCount(pull.headline, ...layers.flatMap((layer) => [layer.heading ?? '', layer.text]));
}

export function depthLabels(pull: PreviewPull): readonly string[] {
  return [
    clockForWords(visibleWords(pull, 0)),
    clockForWords(visibleWords(pull, 1)),
    clockForWords(visibleWords(pull, 2)),
    clockForWords(visibleWords(pull, 3)),
    'Source',
  ];
}

export function sittingWordCount(pulls: readonly PreviewPull[]): number {
  return pulls.reduce((total, pull) => total + visibleWords(pull, 1), 0);
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case 'choose': {
      const count = Math.max(1, Math.trunc(action.count));
      return { phase: 'contents', count, depths: Array<number>(count).fill(1) };
    }
    case 'begin':
      return state.phase === 'contents' ? { ...state, phase: 'reading' } : state;
    case 'depth': {
      if (state.phase !== 'reading' || action.index < 0 || action.index >= state.depths.length) {
        return state;
      }
      const depths = [...state.depths];
      depths[action.index] = Math.max(0, Math.min(4, Math.trunc(action.depth)));
      return { ...state, depths };
    }
    case 'restart':
      return initialPreviewState;
  }
}
