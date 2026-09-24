/**
 * The official JavaScript client for ToxicFilter.
 *
 * Server side only: your API key is a bearer credential for the whole account, and in a
 * browser bundle it is public.
 */

export declare const VERSION: string

export interface Signal {
  category: string
  score: number
  detector: string
  reason: string
  evidence?: string[]
  /**
   * Byte offsets into the content you sent, in pairs, from detectors that matched the raw
   * text. Present only when there are any: a position pointing at a string you do not hold
   * is worse than none, so a signal found in a transcription or in folded text has none.
   */
  spans?: number[]
}

/** The model was asked for and deliberately not run on this call. */
export interface ModelNotRead {
  asked: boolean
  read: boolean
  /** Why not, e.g. `conversation_sampling`. */
  why: string
}

export interface PolicyRef {
  slug: string
  version: number
  /** True when the call's own `rules` were laid over the policy. */
  overridden: boolean
}

/** What a policy being trialled would have said. Reported, never acted on. */
export interface ShadowRef {
  slug: string | null
  version: number
  decision: 'allow' | 'review' | 'block' | null
}

/** Where a held verdict stands. Only `review` opens an entry. */
export interface ReviewState {
  state?: 'open' | 'approved' | 'rejected'
  resolved_at?: string | null
  resolved_by?: string | null
  note?: string | null
}

/** One answer per verdict: sending a second replaces the first. */
export interface FeedbackRef {
  verdict: 'correct' | 'false_positive' | 'false_negative'
  note?: string | null
  /** When it was sent, as an ISO 8601 string. */
  at?: string | null
}

/** The signal that is not in the message: the same thing arriving again and again. */
export interface VerdictContext {
  /** Your own opaque id for whoever wrote it. */
  actor?: string
  /** Identical copies from this account lately. */
  repeats?: number
  /** Near-duplicates: the same message rewritten, which is what a campaign becomes. */
  similar?: number
  /**
   * Behaviour rather than content, and off unless a policy asks for it. It moves a line by
   * at most a tenth, never becomes a signal, never blocks alone, and is always reported with
   * the `adjustment` it made.
   */
  history?: { seen?: number; blocked?: number; adjustment?: number }
}

/** The rules for one call instead of a stored policy. */
export interface InlineRules {
  thresholds?: Record<string, { review?: number; block?: number }>
  topics?: Record<string, { review?: number; block?: number }>
  leads?: Record<string, { review?: number; block?: number }>
  terms?: { block?: string[]; review?: string[]; allow?: string[] }
  surfaces?: Record<string, Record<string, { review?: number; block?: number }>>
  /** What your business does, for the model to judge `off_topic` against. 500 characters. */
  business?: string
}

/**
 * What every judging endpoint takes, whatever it judges.
 *
 * Each endpoint then adds its own fields below, taken from the server's rules for that
 * kind. The server refuses a field an endpoint has no rule for with a 422 `unknown_field`,
 * so one shared options type let a request compile that could only ever fail.
 */
export interface CommonOptions {
  /** Whether the model may run. Text, images and conversations default to true, signups to false. */
  ai?: boolean
  /** Your own id for the thing being judged. Send it: it is how you find the verdict later. */
  reference?: string
  /** Which of your policies to judge under. Absent means the project's, then your default. */
  policy?: string
  /** Which of your projects the verdict is filed under. Absent means your default project. */
  project?: string
  /**
   * Your own opaque id for whoever wrote it, never a name. With it, an account can be told
   * that a user with eight hundred clean messages deserves more benefit of the doubt than
   * one with three blocks today, and it is the only way we can say that: we do not know who
   * anybody is.
   */
  actor?: string
  /**
   * Hand back the content with the personal data masked out. Usually worth more than
   * refusing the message: throwing a whole comment away because it carried one phone number
   * throws away everything else the person wrote.
   */
  redact?: boolean
  /**
   * The rules for this call instead of a stored policy. ONLY what you send is acted on:
   * a category you do not mention has no line at all. Sent with `policy`, they are laid
   * over it instead: the call wins for what it names, the policy keeps the rest.
   *
   * A name that is not a real category, subject or lead type is refused rather than
   * dropped: a line that acts on nothing looks exactly like a line that works.
   */
  rules?: InlineRules
  /** Supply your own, or one is generated per call. Sent as a header, never in the body. */
  idempotencyKey?: string
}

/** The languages your site is in, up to five. Without it a wall of the wrong language cannot be told from a normal comment. */
export interface WithLocales {
  locales?: string[]
}

/** Where it was posted: `comment`, `review`, `listing`, `bio`. The same sentence does not weigh the same in each. */
export interface WithSurface {
  surface?: string
}

/** No model reads this kind, so `ai: true` is a 422 `ai_unavailable`. */
export interface WithoutModel {
  ai?: false
}

export interface TextOptions extends CommonOptions, WithLocales, WithSurface {}
export interface EmailOptions extends Omit<CommonOptions, 'ai'>, WithSurface, WithoutModel {}
export interface NameOptions extends Omit<CommonOptions, 'ai'>, WithLocales, WithSurface, WithoutModel {}
export interface UrlOptions extends Omit<CommonOptions, 'ai'>, WithSurface, WithoutModel {}
export interface SignupFields extends CommonOptions, WithLocales, WithSurface {
  name?: string
  email?: string
  bio?: string
}
export interface ImageOptions extends CommonOptions, WithSurface {}
/** No `surface`: the endpoint IS the surface, and the server prohibits one of your own. */
export interface PromptOptions extends CommonOptions, WithLocales {}
export interface ConversationOptions extends CommonOptions, WithLocales, WithSurface {}

/**
 * Defaults for every item of a batch. No `reference`: each item names itself, and the
 * envelope has no rule for one.
 */
export interface BatchOptions extends Omit<CommonOptions, 'reference'>, WithLocales, WithSurface {}

/**
 * The options every endpoint used to share, kept so code that named it still compiles.
 *
 * @deprecated Use the endpoint's own type (`TextOptions`, `EmailOptions`, ...): this one
 * admits fields some endpoints refuse.
 */
export interface RequestOptions extends CommonOptions, WithLocales, WithSurface {}

export declare class Verdict {
  raw: Record<string, unknown>
  constructor(raw: Record<string, unknown>)
  /** `allow`, `review` or `block`. */
  readonly decision: 'allow' | 'review' | 'block'
  readonly allowed: boolean
  /** A person should look. Hold it; do not delete it. */
  readonly needsReview: boolean
  readonly blocked: boolean
  readonly id: string | null
  readonly reference: string | null
  /** The project the verdict was filed under: the one you named, or your default. */
  readonly project: string | null
  /**
   * Everything that crossed a line, worst first. Categories by their own name; whatever
   * crossed on the other two axes prefixed `topic:` or `lead:`, since its score lives in
   * `topics` or `leads`.
   */
  readonly flagged: string[]
  readonly scores: Record<string, number>
  score(category: string): number
  readonly signals: Signal[]
  /** Why, in words you can show the person whose content it was. */
  readonly reasons: string[]
  /** The first reason, or null when there is none. */
  readonly reason: string | null
  /** How much this is ABOUT a subject, 0 to 1. A separate axis from the categories. */
  readonly topics: Record<string, number>
  topic(name: string): number
  /** What kind of lead wrote this, 0 to 1 per type. Who is writing, not what is wrong. */
  readonly leads: Record<string, number>
  lead(name: string): number
  /** Noticed, but not a finding: `age_signal`, a detected language, a fingerprint. */
  readonly facts: Record<string, unknown>
  /** Part of the pipeline could not run, usually the model. The verdict was reached with less. */
  readonly degraded: boolean
  readonly usedAi: boolean
  readonly cached: boolean
  readonly charged: number
  /** Credits left after this call. `null` where the answer carries no balance: batch rows and stored records. */
  readonly creditsRemaining: number | null
  /**
   * Present when the model was asked for and deliberately not run, e.g. `why:
   * 'conversation_sampling'`. Not `degraded`, which says nobody could read it. `null` otherwise.
   */
  readonly model: ModelNotRead | null
  readonly policy: PolicyRef
  /** The content with the personal data masked, when you asked for it. */
  readonly redacted: string | null
  /** What was known beyond the content: the repetition counts and the actor's record. */
  readonly context: VerdictContext
  /** What a trialled policy would have said. Never what happened. */
  readonly shadow: ShadowRef | null
  /**
   * Where a held verdict stands. Filled by `record()`, `resolve()` and `feedback()`; the
   * `records()` listing carries the verdicts without it, and without `kind`, `createdAt` or
   * `batchId`.
   */
  readonly review: ReviewState
  readonly reviewState: 'open' | 'approved' | 'rejected' | null
  readonly resolved: boolean
  readonly resolvedBy: string | null
  readonly resolvedAt: string | null
  /** What you have already told us about this verdict. */
  readonly feedback: FeedbackRef | null
  /** The content, when your policy keeps it and it has not expired. Only from `record()`. */
  readonly content: string | null
  readonly contentExpiresAt: string | null
  readonly kind: string | null
  readonly createdAt: string | null
  readonly batchId: string | null
  readonly tookMs: number
}

export interface BatchFailure {
  code: string
  message?: string
  fields?: Record<string, string[]>
}

export declare class BatchResult {
  raw: Record<string, unknown>
  constructor(raw: Record<string, unknown>)
  readonly id: string
  /** The project the batch was filed under. */
  readonly project: string | null
  readonly status: 'queued' | 'running' | 'completed'
  readonly finished: boolean
  /** Keyed by the position each item was sent in. */
  readonly verdicts: Map<number, Verdict>
  /**
   * By the position each item was sent in. A failure that names no item (a whole chunk the
   * workers lost, `chunk_failed`) is keyed -1, -2, ... in the order it arrived: no item has
   * a negative position, so it can never be mistaken for one.
   */
  readonly failures: Map<number, BatchFailure>
  readonly count: number
  readonly processed: number
  readonly failed: number
  readonly creditsCharged: number
  /** The cursor for the next page, or null when that was the last one. Pass it as `after`. */
  readonly nextAfter: number | null
  readonly hasMore: boolean
}

export declare class ToxicFilterError extends Error {
  status: number
  code: string | null
  payload: Record<string, unknown>
  /** Whether asking again could plausibly work. */
  retryable: boolean
}

export declare class AuthenticationError extends ToxicFilterError {}

/** Never retried by this library: 402 means come back with a bigger plan. */
export declare class QuotaExhausted extends ToxicFilterError {
  readonly remaining: number
  readonly required: number
  readonly renewsAt: string | null
}

export declare class RateLimited extends ToxicFilterError {
  readonly retryAfter: number
}

export declare class InvalidRequest extends ToxicFilterError {
  readonly fields: Record<string, string[]>
}

export declare class NotFound extends ToxicFilterError {}
export declare class ServerError extends ToxicFilterError {}

export interface ClientOptions {
  baseUrl?: string
  /** How many times to ask again when it is worth asking again. Default 2. */
  retries?: number
  /** Milliseconds. Default 10000. */
  timeout?: number
  /**
   * The longest this will ever sleep between attempts, in milliseconds. Default 30000.
   * A 429 says exactly how long to wait; without a ceiling, a number on the wire decides
   * how long your own request hangs.
   */
  maxWait?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * One element of a batch: the same fields its own endpoint takes, plus `kind`.
 *
 * No `idempotencyKey` and no `project`: an item is checked field by field and either one in
 * it fails that item. Both belong to the batch call.
 */
type ItemOf<K extends string, T> = { kind: K } & Omit<T, 'idempotencyKey' | 'project'>

export type BatchItem =
  | ItemOf<'text', TextOptions & { content: string }>
  | ItemOf<'email', EmailOptions & { address: string }>
  | ItemOf<'name', NameOptions & { name: string }>
  | ItemOf<'signup', Omit<SignupFields, 'idempotencyKey'>>
  | ItemOf<'url', UrlOptions & { url: string }>
  | ItemOf<'conversation', ConversationOptions & { messages: ConversationMessage[] }>
  /**
   * A picture by address or by value (base64 or a `data:` URI), exactly one. An item is
   * JSON, so the multipart `file` form only exists on `/v1/image`, and nothing in this
   * client sends it.
   */
  | ItemOf<'image', ImageOptions & ({ url: string; data?: never } | { data: string; url?: never })>

export interface ConversationMessage {
  /** Your own opaque id for whoever wrote it. Never a name. */
  author?: string
  content: string
  /** When it was written, as an ISO 8601 string. Optional; nothing is inferred from it. */
  at?: string
}

export declare class ToxicFilter {
  constructor(apiKey: string, options?: ClientOptions)
  text(content: string, options?: TextOptions): Promise<Verdict>
  email(address: string, options?: EmailOptions): Promise<Verdict>
  name(name: string, options?: NameOptions): Promise<Verdict>
  signup(fields: SignupFields): Promise<Verdict>
  /**
   * A picture, by address or by value. An http or https address is fetched by us; anything
   * else is the file itself and goes out as `data`, which is not a guess: `url` accepts
   * those two schemes and nothing else.
   */
  image(
    url: string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob,
    options?: ImageOptions,
  ): Promise<Verdict>
  /** A picture you hold rather than one you have published. Bytes, or an already encoded string. */
  imageData(
    data: Uint8Array | ArrayBuffer | ArrayBufferView | Blob | string,
    options?: ImageOptions,
  ): Promise<Verdict>
  /** Text on its way into your own model: prompt injection, plus everything else. */
  prompt(content: string, options?: PromptOptions): Promise<Verdict>
  /** One link, judged as a link. Never fetched: "looks like what it says", not "safe". */
  url(url: string, options?: UrlOptions): Promise<Verdict>
  /**
   * A message with what came before it. The last one is judged; the rest is context.
   * Pile-ons and approaches to children exist nowhere else.
   */
  conversation(messages: ConversationMessage[], options?: ConversationOptions): Promise<Verdict>
  batch(items: BatchItem[], options?: BatchOptions & { async?: boolean }): Promise<BatchResult>
  batchAsync(items: BatchItem[], options?: BatchOptions): Promise<BatchResult>
  batchStatus(batchId: string, query?: { limit?: number; after?: number }): Promise<BatchResult>
  /** The most recent batches, newest first, without their rows. Read one with `batchStatus()`. */
  batches(query?: { limit?: number; project?: string }): Promise<BatchResult[]>
  /**
   * The review queue. Each verdict carries what it was decided and why; its review state,
   * feedback, `kind` and dates come from `record(id)`.
   */
  records(query?: {
    state?: 'open' | 'approved' | 'rejected' | 'resolved' | 'any'
    decision?: 'allow' | 'review' | 'block'
    feedback?: 'correct' | 'false_positive' | 'false_negative' | 'none'
    reference?: string
    /** One project's queue, by its slug. */
    project?: string
    /** Your own id for whoever wrote it, as sent in `actor`. */
    actor?: string
    kind?: string
    from?: string
    to?: string
    limit?: number
    before?: string
  }): Promise<{ records: Verdict[]; nextBefore: string | null }>
  /** One stored verdict in full, with its review state, feedback and any retained content. */
  record(id: string): Promise<Verdict>
  /**
   * An options object, unlike the PHP and Python clients, which take the moderator
   * positionally. Deliberate: the same names in all three, each language's conventions.
   */
  resolve(id: string, action: 'approved' | 'rejected', options?: { moderator?: string; note?: string }): Promise<Verdict>
  feedback(
    id: string,
    verdict: 'correct' | 'false_positive' | 'false_negative',
    options?: { note?: string },
  ): Promise<Verdict>
  keys(): Promise<Record<string, unknown>>
  revokeKey(id: string | number): Promise<Record<string, unknown>>
  usage(): Promise<Record<string, unknown>>
  ping(): Promise<Record<string, unknown>>
}

/**
 * Whether a delivery is ours. Pass the RAW body: re-encoding a parsed one changes the
 * bytes the signature was over.
 */
export declare function verifyWebhook(
  payload: string | Uint8Array,
  header: string,
  secret: string,
  options?: { tolerance?: number; now?: () => number },
): Promise<boolean>

export declare function webhookEvent(
  payload: string | Uint8Array,
  header: string,
  secret: string,
  options?: { tolerance?: number; now?: () => number },
): Promise<{ id: string; event: string; created_at: string; data: Record<string, unknown> } | null>

export default ToxicFilter
