import { useReducer } from 'react';
import { PreviewDepthDial } from '../components/PreviewDepthDial.js';
import {
  clockForWords,
  depthLabels,
  initialPreviewState,
  previewReducer,
  sittingWordCount,
  visibleWords,
  type PreviewPull,
} from '../lib/design-preview.js';
import '../styles/design-preview.css';

const PREVIEW_PULLS: readonly PreviewPull[] = [
  {
    headline: 'Some books are to be tasted, some swallowed, and a few chewed and digested.',
    source: {
      title: 'Of Studies',
      creator: 'Francis Bacon',
      kind: 'essay',
      year: '1625',
      trail: 'Essays, section 50',
      url: 'https://en.wikisource.org/wiki/The_Works_of_Francis_Bacon/Volume_1/Essays/Of_Studies',
    },
    layers: [
      {
        text: 'Bacon is not ranking books so much as ranking kinds of attention. Some writing gives up its value at a glance; some needs a complete pass; a small remainder changes only after it has been taken apart and rebuilt in the reader’s own terms. The useful distinction is not short against long, but what kind of work the material asks the mind to do.',
      },
      {
        heading: 'The scale behind the sentence',
        text: 'The three verbs form a depth control four centuries before software gave the control a name. Tasting is orientation, swallowing is comprehension, and digesting is integration. A single source can contain passages at all three depths, so the reader should be able to change the treatment without changing the source.',
      },
      {
        heading: 'What the list refuses',
        text: 'It refuses the idea that finishing is the only honest way to read. Bacon allows a reader to stop after the value has been taken, which is exactly what a bounded sitting needs: an end determined by the work and the purpose, not by an endless queue.',
      },
      {
        heading: 'Counterpull',
        text: 'A depth dial can make shallow reading feel rigorous because it names the shallowness precisely. The safeguard is the source stop: the interface must always leave the full work reachable, without presenting the summary as a substitute for it.',
      },
    ],
  },
  {
    headline: 'You cannot look for what you do not already partly know.',
    source: {
      title: 'Meno',
      creator: 'Plato',
      kind: 'book',
      year: 'c. 380 BC',
      trail: '80d–86c',
      url: 'https://classics.mit.edu/Plato/meno.html',
    },
    layers: [
      {
        text: 'The paradox is sharper than it first appears: if you know what you are seeking, you do not need to seek it; if you do not know it, you would not recognise it on finding it. Every account of learning has to explain how a person can search across that gap, and most accounts quietly assume the recognition they are meant to explain.',
      },
      {
        heading: 'The answer, and its cost',
        text: 'Plato answers by treating learning as recollection. The learner is not acquiring something wholly alien but recovering a structure the mind can already meet. That makes inquiry possible, but only by moving the mystery backward into a theory about what the soul knew before this life.',
      },
      {
        heading: 'What survives the metaphysics',
        text: 'Modern learning systems keep the practical part of the answer: a new idea needs an anchor. Examples, analogies, prerequisites, and retrieval cues all give recognition somewhere to begin, even if nobody accepts recollection as the literal mechanism.',
      },
      {
        heading: 'Counterpull',
        text: 'The paradox forces knowledge into a binary—known or unknown—when ordinary learning is graded. You can recognise a question before you can answer it, and recognise an answer before you can produce it. Those middle states are where most teaching actually works.',
      },
    ],
  },
  {
    headline: 'A candle is a laboratory that fits in your hand.',
    source: {
      title: 'The Chemical History of a Candle',
      creator: 'Michael Faraday',
      kind: 'lecture',
      year: '1861',
      trail: 'Lecture I',
      url: 'https://en.wikisource.org/wiki/The_Chemical_History_of_a_Candle/Lecture_I',
    },
    layers: [
      {
        text: 'The wax is fuel, but almost nothing burns while it is still wax. Heat melts a small pool, the wick lifts the liquid by capillary action, more heat turns it to vapour, and the vapour burns. The wick carries the fuel; it does not provide it. A familiar object becomes strange as soon as each transfer is named.',
      },
      {
        heading: 'Why Faraday starts here',
        text: 'He chooses something his audience has seen thousands of times, so every step lands as a correction rather than as an isolated fact. The lecture demonstrates a method for teaching as clearly as it demonstrates combustion: begin with shared evidence, then make the hidden sequence visible.',
      },
      {
        heading: 'The portable lesson',
        text: 'Explanation gains force when it converts one object into a chain of causes the learner can inspect. The same move works in software, economics, and biology: start from the outcome in hand, then expose the transfers that had to occur for it to exist.',
      },
      {
        heading: 'Counterpull',
        text: 'Starting from the familiar can become a performance of clarity that never reaches the difficult abstraction. Faraday can travel from a candle to combustion chemistry; a weaker explanation stays with the candle and mistakes a memorable example for a complete model.',
      },
    ],
  },
];

function sourceLine(pull: PreviewPull): string {
  const { kind, title, creator, year } = pull.source;
  return `${kind} · ${title} · ${creator} · ${year}`;
}

export function DesignPreview() {
  const [state, dispatch] = useReducer(previewReducer, initialPreviewState);
  const deal = PREVIEW_PULLS.slice(0, state.count);
  const visibleTotal = deal.reduce(
    (total, pull, index) => total + visibleWords(pull, state.depths[index] ?? 1),
    0,
  );

  return (
    <main className="design-preview">
      <header className="design-preview__masthead">
        <a className="design-preview__wordmark" href="/">
          What a Pull
        </a>
        <span className="meta">Design strategy preview</span>
      </header>

      {state.phase === 'gate' && (
        <section className="design-preview__gate" aria-labelledby="preview-gate-title">
          <p className="meta">A bounded reading prototype</p>
          <h1 id="preview-gate-title">How long have you got?</h1>
          <p className="design-preview__lede">
            The sitting is cut to fit, and then it is finished. You are never handed a runway.
          </p>

          <div className="design-preview__gate-grid">
            {[2, 3].map((count) => {
              const pulls = PREVIEW_PULLS.slice(0, count);
              const duration = clockForWords(sittingWordCount(pulls));
              return (
                <button
                  type="button"
                  className="design-preview__gate-choice"
                  key={count}
                  aria-label={`Choose ${count} ideas, ${duration}`}
                  onClick={() => dispatch({ type: 'choose', count })}
                >
                  <span className="design-preview__gate-time">{duration}</span>
                  <span className="meta">{count} ideas</span>
                </button>
              );
            })}
          </div>

          <p className="design-preview__note">No account needed. Nothing saved.</p>
        </section>
      )}

      {state.phase === 'contents' && (
        <section className="design-preview__contents" aria-labelledby="preview-contents-title">
          <p className="meta">Today · {clockForWords(sittingWordCount(deal))}</p>
          <h1 id="preview-contents-title">Today’s sitting</h1>
          <p className="design-preview__lede">
            Face up, in the order it will be dealt. You can see the end of it from here, which is
            the whole difference between this and a feed.
          </p>

          <ol className="design-preview__manifest">
            {deal.map((pull, index) => (
              <li key={pull.source.title}>
                <span className="design-preview__ordinal">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>
                  <strong>{pull.headline}</strong>
                  <small>{sourceLine(pull)}</small>
                </span>
                <span className="meta">{depthLabels(pull)[1]}</span>
              </li>
            ))}
            <li className="design-preview__manifest-end">
              <span className="design-preview__ordinal">
                {String(deal.length + 1).padStart(2, '0')}
              </span>
              <span>
                <strong>Enough</strong>
                <small>The end of it</small>
              </span>
            </li>
          </ol>

          <div className="design-preview__contents-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => dispatch({ type: 'begin' })}
            >
              Begin
            </button>
            <button type="button" className="btn" onClick={() => dispatch({ type: 'restart' })}>
              Choose again
            </button>
          </div>
        </section>
      )}

      {state.phase === 'reading' && (
        <div className="design-preview__reading">
          <div className="design-preview__reading-head">
            <span className="meta">Today’s sitting · {deal.length} ideas</span>
            <a href="#preview-enough">See the end</a>
          </div>

          {deal.map((pull, index) => {
            const depth = state.depths[index] ?? 1;
            const visibleLayers = pull.layers.slice(0, depth);
            return (
              <article
                className="design-preview__pull"
                data-medium={pull.source.kind}
                data-depth={depth}
                key={pull.source.title}
              >
                <div className="design-preview__source-band">
                  <span>{sourceLine(pull)}</span>
                  <span>
                    {String(index + 1).padStart(2, '0')} / {String(deal.length).padStart(2, '0')}
                  </span>
                </div>

                <div className="design-preview__pull-grid">
                  <PreviewDepthDial
                    pull={pull}
                    cardIndex={index}
                    depth={depth}
                    onDepth={(nextDepth) => dispatch({ type: 'depth', index, depth: nextDepth })}
                  />

                  <div className="design-preview__prose">
                    <p className="meta" aria-live="polite">
                      {visibleWords(pull, depth)} words
                    </p>
                    <h2>{pull.headline}</h2>
                    {visibleLayers.map((layer) => (
                      <div
                        className="design-preview__layer"
                        key={`${layer.heading ?? 'idea'}-${layer.text}`}
                      >
                        {layer.heading && <h3>{layer.heading}</h3>}
                        <p>{layer.text}</p>
                      </div>
                    ))}

                    {depth === 4 && (
                      <div className="design-preview__source-offer">
                        <p className="meta">The work stays where it lives</p>
                        <p>{pull.source.trail}</p>
                        <a href={pull.source.url} target="_blank" rel="noreferrer">
                          Read {pull.source.title} in full
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}

          <section
            className="design-preview__enough"
            id="preview-enough"
            aria-labelledby="preview-enough-title"
          >
            <p className="meta">The end of it</p>
            <h2 id="preview-enough-title">Enough for today.</h2>
            <dl className="design-preview__tally">
              <div>
                <dd>{deal.length}</dd>
                <dt>ideas dealt</dt>
              </div>
              <div>
                <dd>{clockForWords(visibleTotal)}</dd>
                <dt>visible reading</dt>
              </div>
              <div>
                <dd>0</dd>
                <dt>requests on the dial</dt>
              </div>
            </dl>
            <p className="design-preview__enough-line">Mind fed. Go and use some of it.</p>
            <button type="button" className="btn" onClick={() => dispatch({ type: 'restart' })}>
              Start another sitting
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
