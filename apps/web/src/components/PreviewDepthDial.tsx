import { depthLabels, type PreviewPull } from '../lib/design-preview.js';

const DEPTH_NAMES = ['Shortest', 'Short', 'Medium', 'Long', 'Source'] as const;

export function PreviewDepthDial({
  pull,
  cardIndex,
  depth,
  onDepth,
}: {
  pull: PreviewPull;
  cardIndex: number;
  depth: number;
  onDepth: (depth: number) => void;
}) {
  const labels = depthLabels(pull);

  return (
    <fieldset className="design-preview__dial">
      <legend className="meta design-preview__dial-title">Depth</legend>
      {labels.map((label, index) => (
        <label
          className="design-preview__depth"
          data-checked={depth === index}
          key={`${cardIndex}-${DEPTH_NAMES[index]}`}
        >
          <input
            type="radio"
            name={`depth-${cardIndex}`}
            checked={depth === index}
            onChange={() => onDepth(index)}
          />
          <span className="design-preview__tick" aria-hidden="true" />
          <span>
            <span className="sr-only">{DEPTH_NAMES[index]}: </span>
            {label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
