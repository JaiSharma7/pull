/**
 * A `fetch` that writes down every model-provider request before it sends it.
 *
 * This is the independent inventory the evaluation contract asks for
 * (docs/eval/study-quality.md): the ledger is written by the pipeline's accounting
 * after a call returns, and this is written by the transport underneath it, before the
 * request leaves. The two are then reconciled (`study_provider_call_audit`), so an
 * attempt the accounting forgot -- a retry, a 503, a timeout -- shows up as a journal
 * row with no ledger row instead of disappearing.
 *
 * Fails closed: if the journal row cannot be written, nothing is sent. A request that
 * cannot be accounted for is not one this product can afford to make.
 *
 * It also refuses any host that is not a model provider. The study steps have no
 * reason to fetch anything else, and a transport that journals only provider calls
 * but will happily send others is an SSRF surface with bookkeeping on it.
 */

export type ProviderName = 'gemini' | 'anthropic';

const PROVIDER_HOSTS: Record<string, ProviderName> = {
  'generativelanguage.googleapis.com': 'gemini',
  'api.anthropic.com': 'anthropic',
};

export interface JournalOpen {
  id: string;
  jobId: string;
  step: string;
  provider: ProviderName;
  /** The path only: a model and a method, never a key or a query string. */
  endpoint: string;
}

export type JournalOutcome = 'responded' | 'network_error' | 'aborted';

export interface ProviderJournal {
  open(call: JournalOpen): Promise<void>;
  close(id: string, outcome: JournalOutcome, httpStatus: number | null): Promise<void>;
}

/** The transport refused to send because the journal could not record the attempt. */
export class JournalUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `provider journal unavailable, request not sent: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'JournalUnavailableError';
  }
}

/** A request failed after it was journalled; carries the journal id for the ledger. */
export class JournalledRequestError extends Error {
  readonly callId: string;
  readonly aborted: boolean;

  constructor(callId: string, cause: unknown, aborted: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'JournalledRequestError';
    this.callId = callId;
    this.aborted = aborted;
  }
}

export interface ProviderTransport {
  fetch: typeof fetch;
  /** The journal id of a response this transport returned, if it returned it. */
  callIdOf(response: Response): string | undefined;
}

function isAbort(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError')
  );
}

export function providerFor(url: URL): ProviderName | undefined {
  return url.protocol === 'https:' ? PROVIDER_HOSTS[url.hostname] : undefined;
}

export function createJournalledTransport(
  journal: ProviderJournal,
  scope: { jobId: string; step: string },
  inner: typeof fetch = fetch,
  newId: () => string = () => crypto.randomUUID(),
): ProviderTransport {
  const ids = new WeakMap<Response, string>();

  const journalled = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const provider = providerFor(url);
    if (!provider) {
      throw new Error(
        `provider transport refuses ${url.protocol}//${url.hostname}: not a model provider`,
      );
    }

    const id = newId();
    const endpoint = url.pathname.replace(/^\/v1(beta)?\//, '').slice(0, 200) || '/';
    try {
      await journal.open({ id, jobId: scope.jobId, step: scope.step, provider, endpoint });
    } catch (e) {
      throw new JournalUnavailableError(e);
    }

    let response: Response;
    try {
      // Never followed. A 307/308 would re-send the reader's text and the key header to
      // wherever it pointed, and the hop would go unjournalled. A provider that redirects
      // is a failed request, recorded as one.
      response = await inner(input, { ...init, redirect: 'error' });
    } catch (e) {
      const aborted = isAbort(e);
      // Logged rather than thrown: the request's own failure is the error that matters,
      // and a journal row left `open` is itself what the audit reports.
      await journal.close(id, aborted ? 'aborted' : 'network_error', null).catch((close) => {
        console.error('provider journal: could not close', id, close);
      });
      throw new JournalledRequestError(id, e, aborted);
    }

    await journal.close(id, 'responded', response.status).catch((close) => {
      console.error('provider journal: could not close', id, close);
    });
    ids.set(response, id);
    return response;
  };

  return {
    fetch: journalled as typeof fetch,
    callIdOf: (response) => ids.get(response),
  };
}
