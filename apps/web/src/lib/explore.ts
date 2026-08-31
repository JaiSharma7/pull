import { int, isRecord, nonNull, nullableInt, nullableStr, rows, str } from './shape.js';

/**
 * The catalogue, minus the network.
 *
 * Explore is a catalogue rather than a feed, and law 7 is why: a browse surface
 * is the easiest place in a product to grow an unbounded list by accident. The
 * counting below is what makes the page finite in the reader's hands rather than
 * only in the query — the size leads, and the end is a sentence.
 */

export interface CatalogueTopic {
  slug: string;
  label: string;
  sources: number;
  ideas: number;
}

export interface CatalogueParent extends CatalogueTopic {
  children: CatalogueTopic[];
}

export interface Catalogue {
  totals: { sources: number; ideas: number; topics: number };
  parents: CatalogueParent[];
}

export const EMPTY_CATALOGUE: Catalogue = {
  totals: { sources: 0, ideas: 0, topics: 0 },
  parents: [],
};

export interface TopicSource {
  id: string;
  title: string;
  subtitle: string | null;
  slug: string;
  kind: string;
  year: number | null;
  ideas: number;
  /**
   * Ideas from this source the reader still remembers.
   *
   * Directly known — a `knowledge_states` row above the retrievability floor —
   * not the Delta's semantic coverage. The full Delta costs a vector comparison
   * per candidate and belongs on the source page, where it is one work. So the
   * copy says "you know" rather than "new to you", because that is what this
   * number measures.
   */
  known: number;
}

export interface TopicPage {
  topic: { slug: string; label: string; parentSlug: string | null; parentLabel: string | null };
  counts: { sources: number; ideas: number; known: number; shown: number };
  sources: TopicSource[];
}

/* --------------------------------------------------------------------------
 * Shaping
 * -------------------------------------------------------------------------- */

function shapeTopic(r: Record<string, unknown>): CatalogueTopic | null {
  const slug = str(r.slug);
  // A topic without a slug has no URL, so it is a row nobody could open.
  if (!slug) return null;
  return { slug, label: str(r.label), sources: int(r.sources), ideas: int(r.ideas) };
}

export function shapeCatalogue(raw: unknown): Catalogue {
  if (!isRecord(raw)) return EMPTY_CATALOGUE;
  const totals = isRecord(raw.totals) ? raw.totals : {};
  return {
    totals: {
      sources: int(totals.sources),
      ideas: int(totals.ideas),
      topics: int(totals.topics),
    },
    parents: rows(raw.parents)
      .map((p): CatalogueParent | null => {
        const base = shapeTopic(p);
        if (!base) return null;
        return { ...base, children: rows(p.children).map(shapeTopic).filter(nonNull) };
      })
      .filter(nonNull),
  };
}

function shapeSource(r: Record<string, unknown>): TopicSource | null {
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title),
    subtitle: nullableStr(r.subtitle),
    slug: str(r.slug),
    kind: str(r.kind),
    year: nullableInt(r.year),
    ideas: int(r.ideas),
    known: int(r.known),
  };
}

/**
 * Null when the topic does not exist, or exists with nothing readable behind it.
 *
 * `get_topic` returns SQL null for both, deliberately: a topic a reader cannot
 * open is not a topic, and rendering an empty page for it looks exactly like a
 * request that failed. The screen shows "not found" instead.
 */
export function shapeTopicPage(raw: unknown): TopicPage | null {
  if (!isRecord(raw)) return null;
  const topic = isRecord(raw.topic) ? raw.topic : null;
  const slug = topic ? str(topic.slug) : '';
  if (!slug) return null;
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    topic: {
      slug,
      label: str(topic!.label),
      parentSlug: nullableStr(topic!.parentSlug),
      parentLabel: nullableStr(topic!.parentLabel),
    },
    counts: {
      sources: int(counts.sources),
      ideas: int(counts.ideas),
      known: int(counts.known),
      shown: int(counts.shown),
    },
    sources: rows(raw.sources).map(shapeSource).filter(nonNull),
  };
}

/* --------------------------------------------------------------------------
 * Bounding — law 7, made testable
 * -------------------------------------------------------------------------- */

/** What a topic page asks for first. Comfortably more than any topic holds today. */
export const TOPIC_PAGE = 40;

/** And the one expansion it will ever offer. */
export const TOPIC_MAX = 200;

/**
 * The next limit, or null when there is no next one.
 *
 * Returning null rather than a larger number is the whole point: a control that
 * can always be pressed again is an infinite list with an extra step, which is
 * the mechanic law 7 exists to refuse. One expansion, then the page is as big as
 * it gets and says so.
 */
export function expandLimit(current: number): number | null {
  return current < TOPIC_MAX ? TOPIC_MAX : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "42 sources · 156 ideas · 28 topics" — the size of the library, before any of it. */
export function catalogueSummary(catalogue: Catalogue): string {
  const { sources, ideas, topics } = catalogue.totals;
  return [
    plural(sources, 'source', 'sources'),
    plural(ideas, 'idea', 'ideas'),
    plural(topics, 'topic', 'topics'),
  ].join(' · ');
}

/** "23 sources · 190 ideas · 47 you know" — the last part only when there is one. */
export function topicCountLine(page: TopicPage): string {
  const parts = [
    plural(page.counts.sources, 'source', 'sources'),
    plural(page.counts.ideas, 'idea', 'ideas'),
  ];
  if (page.counts.known > 0) parts.push(`${page.counts.known} you know`);
  return parts.join(' · ');
}

/**
 * The sentence that ends the list, and it is two different sentences.
 *
 * A list showing everything there is has ENDED; a truncated one has been CUT.
 * Only the second is something the reader can act on, and telling someone the
 * list is capped when they are already looking at all of it is an instruction
 * with nothing behind it.
 */
export function topicTerminalLine(page: TopicPage): string {
  const { shown, sources } = page.counts;
  if (sources === 0) return '';
  if (shown >= sources) {
    return `That is every source we hold on ${page.topic.label}.`;
  }
  return `Showing ${shown} of ${sources}.`;
}
