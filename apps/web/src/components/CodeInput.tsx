import { useRef } from 'react';

/**
 * A sign-in code as six boxes rather than one field.
 *
 *   ┌───┐┌───┐┌───┐┌───┐┌───┐┌───┐
 *   │ 4 ││ 4 ││ 5 ││ 6 ││ 7 ││   │   ← the empty box is the instruction
 *   └───┘└───┘└───┘└───┘└───┘└───┘
 *
 * Structure ported from the one-time-password pattern in 21st.dev's sign-in collection;
 * none of its styling was. It is the one genuinely good idea in that catalogue, and it
 * is ergonomics rather than decoration: a six-digit code in a single text input gives a
 * reader no sense of how many digits are left, and no way to see a typo except by
 * counting characters.
 *
 * The three behaviours that make it feel precise rather than fussy:
 *
 *   paste      one paste fills all six. Every reader copies the code out of an email,
 *              and a paste that fills one box and silently drops five digits is the
 *              most likely single failure on this screen.
 *   advance    typing moves forward, backspace on an empty box steps back. Correcting
 *              a typo must never require aiming a cursor.
 *   submit     a complete code submits the form, because at that point there is exactly
 *              one thing the reader wants and asking them to reach for a button is
 *              friction with no purpose.
 *
 * Deliberately not fixed-length in the value it reports: the number of boxes is a
 * display decision, while the length a code actually has is the server's. `LENGTH` here
 * governs how many boxes are drawn and nothing else.
 */
const LENGTH = 6;

export function CodeInput({
  value,
  onChange,
  disabled,
  onComplete,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(LENGTH, ' ').slice(0, LENGTH).split('');

  const focus = (i: number) => boxes.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();

  /** Writing at a position, without letting the string grow past the boxes. */
  const write = (index: number, char: string) => {
    const next = value.padEnd(LENGTH, ' ').split('');
    next[index] = char;
    return next.join('').trimEnd().slice(0, LENGTH);
  };

  return (
    <div
      className="code"
      // One label for the group rather than six unlabelled boxes, which is what a
      // screen reader would otherwise announce.
      role="group"
      aria-label={`Sign-in code, ${LENGTH} digits`}
    >
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className="code__box"
          value={digit.trim()}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          // iOS reads a code out of the notification and offers it on the first box.
          // Only the first: repeating it makes the suggestion appear six times.
          aria-label={`Digit ${i + 1}`}
          maxLength={1}
          onChange={(e) => {
            const char = e.target.value.replace(/\D/g, '').slice(-1);
            if (!char) return;
            const next = write(i, char);
            onChange(next);
            if (next.length >= LENGTH) onComplete?.();
            else focus(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              // Clearing a filled box leaves the caret there; clearing an empty one
              // steps back. Both are what the reader means by pressing backspace.
              if (digit.trim()) onChange(write(i, ' '));
              else {
                onChange(write(i - 1, ' '));
                focus(i - 1);
              }
            } else if (e.key === 'ArrowLeft') focus(i - 1);
            else if (e.key === 'ArrowRight') focus(i + 1);
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH);
            if (!pasted) return;
            onChange(pasted);
            focus(pasted.length);
            if (pasted.length >= LENGTH) onComplete?.();
          }}
        />
      ))}
    </div>
  );
}
