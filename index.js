/**
 * The ToxicFilter API, from JavaScript.
 *
 * Runs anywhere there is a `fetch` and a `crypto.subtle`: Node 20+, Deno, Bun, Cloudflare
 * Workers, Vercel Edge.
 * No dependencies: a client for one small API is not worth a dependency tree.
 *
 * **Server side only.** Your API key is a bearer credential for your whole account; in a
 * browser bundle it is public, and anybody who reads it can spend your allowance. Moderate
 * from your backend and send the verdict to the page.
 */

export const VERSION = '1.1.3'

/** Anything the API refused. Carries the status, the code and the whole body. */
export class ToxicFilterError extends Error {
  constructor(message, status = 0, code = null, payload = {}) {
    super(message)
    this.name = 'ToxicFilterError'
    this.status = status
    this.code = code
    this.payload = payload
    /** Whether asking again could plausibly work. */
    this.retryable = false
  }
}

/** The key was missing, unrecognised or revoked. A wrong key stays wrong. */
export class AuthenticationError extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'AuthenticationError'
  }
}

/**
 * The account cannot pay for this call.
 *
 * **Never retried by anything in this library.** 402 means come back with a bigger plan,
 * and a client that retries it hammers forever and never succeeds. Catch it, stop calling,
 * and tell somebody.
 */
export class QuotaExhausted extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'QuotaExhausted'
  }

  /** @returns {number} Credits left on the account. */
  get remaining() {
    return this.payload?.credits?.remaining ?? 0
  }

  /** What this call would have cost. A 402 can arrive with credits still in the account. */
  get required() {
    return this.payload?.credits?.required ?? 0
  }

  /** @returns {?string} When the monthly allowance comes back, ISO 8601. */
  get renewsAt() {
    return this.payload?.credits?.renews_at ?? null
  }
}

/** Too many requests. Retried automatically; if you see it, the retries ran out. */
export class RateLimited extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'RateLimited'
    this.retryable = true
  }

  /** @returns {number} Seconds the service asked us to wait, or 1. */
  get retryAfter() {
    return Math.max(1, this.payload?.retry_after ?? 1)
  }
}

/** The request was malformed and nothing was judged. */
export class InvalidRequest extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'InvalidRequest'
  }

  /** @returns {Object<string, string[]>} The fields it refused, each with its messages. */
  get fields() {
    return this.payload?.errors ?? this.payload?.error?.fields ?? {}
  }
}

/** No such verdict, batch or endpoint on this account. */
export class NotFound extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'NotFound'
  }
}

/** Our fault, or the network's. Retried automatically. */
export class ServerError extends ToxicFilterError {
  constructor(...args) {
    super(...args)
    this.name = 'ServerError'
    this.retryable = true
  }
}

function errorFor(status, payload) {
  const message = payload?.error?.message ?? payload?.message ?? 'The request failed.'
  const code = payload?.error?.code ?? null
  const args = [message, status, code, payload]

  if (status === 401) return new AuthenticationError(...args)
  if (status === 402) return new QuotaExhausted(...args)
  if (status === 404) return new NotFound(...args)
  if (status === 422) return new InvalidRequest(...args)
  if (status === 429) return new RateLimited(...args)
  // 409 is `idempotency_in_flight`: the earlier attempt at this very call is still
  // running, so waiting and asking again is exactly right.
  if (status === 409 || status >= 500) return new ServerError(...args)

  return new ToxicFilterError(...args)
}

const DECISIONS = ['allow', 'review', 'block']

/**
 * One answer.
 *
 * There is deliberately no `isToxic`. The API returns fifteen categories and three
 * decisions precisely because collapsing them into one boolean bakes somebody else's
 * policy into every caller.
 */
export class Verdict {
  constructor(raw) {
    this.raw = raw ?? {}
  }

  /**
   * `allow`, `review` or `block`.
   *
   * Throws when the answer carries none, rather than assuming one. It used to default to
   * `allow`, so anything that was not a verdict (an empty body, a proxy's page) read as
   * "publish it". A moderation client that fails open publishes exactly what it was asked
   * about on the day something between it and the API goes wrong.
   */
  get decision() {
    const decision = this.raw.decision

    if (!DECISIONS.includes(decision)) {
      throw new ToxicFilterError(`This answer carries no decision (got ${JSON.stringify(decision)}).`, 0, 'no_decision', this.raw)
    }

    return decision
  }

  /** @returns {boolean} Nothing crossed a line. Publish it. */
  get allowed() {
    return this.decision === 'allow'
  }

  /** A person should look. Hold it; do not delete it. */
  get needsReview() {
    return this.decision === 'review'
  }

  /** @returns {boolean} Refuse it. */
  get blocked() {
    return this.decision === 'block'
  }

  /** The verdict's own name: what a support ticket or a webhook refers to. */
  get id() {
    return this.raw.id ?? null
  }

  /** Your own id for the thing, handed back. */
  get reference() {
    return this.raw.reference ?? null
  }

  /** The project the verdict was filed under: the one you named, or your default. */
  get project() {
    return typeof this.raw.project === 'string' ? this.raw.project : null
  }

  /**
   * Everything that crossed a line, worst first.
   *
   * Categories come back by their own name and have a score in `scores`. Whatever crossed
   * on the other two axes is prefixed `topic:` or `lead:`, because its score lives in
   * `topics` or `leads` and a bare `gambling` here would send you looking for one that does
   * not exist.
   */
  get flagged() {
    return this.raw.flagged ?? []
  }

  /** @returns {Object<string, number>} The highest score per category, 0 to 1. */
  get scores() {
    return this.raw.scores ?? {}
  }

  /** @param {string} category @returns {number} 0 when it did not score at all. */
  score(category) {
    return this.scores[category] ?? 0
  }

  /** @returns {Object[]} Every finding, with its evidence. */
  get signals() {
    return this.raw.signals ?? []
  }

  /** Why, in words you can show the person whose content it was. */
  get reasons() {
    return this.signals.map((signal) => signal.reason ?? '')
  }

  /** The first reason, or null when there is none. */
  get reason() {
    return this.reasons.find((reason) => reason !== '') ?? null
  }

  /**
   * How much this is ABOUT a subject, 0 to 1, for every topic your account measures.
   *
   * A separate axis from the categories on purpose: gambling is not harm, it is a subject,
   * and whether a casino advert belongs on your site is your decision rather than ours.
   */
  get topics() {
    return this.raw.topics ?? {}
  }

  /** @param {string} name @returns {number} 0 when the subject is not there at all. */
  topic(name) {
    return this.topics[name] ?? 0
  }

  /**
   * What kind of LEAD wrote this, 0 to 1 per type: `free_work_for_equity`, `no_budget`,
   * `free_consulting`, `scope_creep`, `no_show`, `sales_pitch` and the rest.
   *
   * A third axis, and a different question from the other two: not what is wrong with the
   * content, not what it is about, but who is writing and what they want. One person is often
   * several at once, so each type keeps its own score, and none of them decides anything
   * until your rules give a type a line.
   */
  get leads() {
    return this.raw.leads ?? {}
  }

  /** @param {string} name @returns {number} 0 when nothing suggested that lead type. */
  lead(name) {
    return this.leads[name] ?? 0
  }

  /**
   * What was noticed but is not a finding: `age_signal`, a detected language, a
   * near-duplicate's fingerprint. Deliberately not signals: a thirteen-year-old saying so
   * is a child using a website, not a thing they did wrong.
   */
  get facts() {
    return this.raw.facts ?? {}
  }

  /**
   * Part of the pipeline could not run, usually the model. The verdict is still real; it
   * was reached with less. Its own field rather than a quiet `used_ai: false`, so a caller
   * who asked for a model can tell "it read this and found nothing" from "it never ran".
   */
  get degraded() {
    return Boolean(this.raw.degraded)
  }

  /** @returns {boolean} Whether a model read it, or the cheap detectors settled it. */
  get usedAi() {
    return Boolean(this.raw.used_ai)
  }

  /** @returns {boolean} Whether this content had been judged before. */
  get cached() {
    return Boolean(this.raw.cached)
  }

  /** @returns {number} What this call cost, in credits. */
  get charged() {
    return this.raw.credits?.charged ?? this.raw.charged ?? 0
  }

  /**
   * @returns {?number} Credits left after this call, or null when the answer does not say.
   *
   * Batch rows and stored records carry no balance, and reporting 0 for them read as an
   * account with nothing left.
   */
  get creditsRemaining() {
    return this.raw.credits?.remaining ?? null
  }

  /**
   * `{ asked, read, why }` when the model was asked for and deliberately not run on this
   * call (`why: 'conversation_sampling'`), or null.
   *
   * Not the same as `degraded`, which says nobody COULD read it. Without this, a message
   * the model chose to skip looked exactly like one the cheap detectors had settled.
   */
  get model() {
    return this.raw.model ?? null
  }

  /**
   * Which rules produced this, by name and version. Worth logging. `overridden` is true
   * when the call's own `rules` were laid over the policy.
   */
  get policy() {
    return {
      slug: this.raw.policy?.slug ?? 'default',
      version: this.raw.policy?.version ?? 0,
      overridden: this.raw.policy?.overridden === true,
    }
  }

  /**
   * The content with the personal data masked out, when you asked with `redact: true` and
   * there was any.
   *
   * Usually worth more than refusing the message: throwing a whole comment away because it
   * carried one phone number throws away everything else the person wrote. `null` when you
   * did not ask, or when there was nothing to mask.
   */
  get redacted() {
    return typeof this.raw.redacted === 'string' ? this.raw.redacted : null
  }

  /**
   * What was known beyond the content itself: `repeats`, `similar`, and the actor's
   * `history` with the `adjustment` it earned.
   *
   * Present only when it was not empty, and present whenever it was, including when it moved
   * the line by nothing: a decision changed by somebody's record with no way to see that is
   * the kind of moderation this API exists not to be.
   */
  get context() {
    return this.raw.context ?? {}
  }

  /**
   * What the policy being TRIALLED would have said, with its own slug and version.
   *
   * Reported and never acted on: seeing the disagreement over your own traffic is the entire
   * point of running one. `null` when no shadow policy is set.
   */
  get shadow() {
    if (this.raw.shadow) {
      return {
        slug: this.raw.shadow.slug ?? null,
        version: this.raw.shadow.version ?? 0,
        decision: this.raw.shadow.decision ?? null,
      }
    }

    // A stored verdict spells the same two facts flat, the way its columns are named.
    if (this.raw.shadow_slug || this.raw.shadow_decision) {
      return {
        slug: this.raw.shadow_slug ?? null,
        version: this.raw.shadow_version ?? 0,
        decision: this.raw.shadow_decision ?? null,
      }
    }

    return null
  }

  /**
   * Where this verdict stands in the queue: the state, who decided and when.
   *
   * Only `review` opens an entry, so a verdict that was allowed outright has nothing here.
   * Filled by `record()`, `resolve()` and `feedback()`. Not by `records()`: the listing
   * carries each verdict without its review state, `kind`, `createdAt` or `batchId`, so
   * read one with `record(id)` when you need them.
   */
  get review() {
    return this.raw.review ?? {}
  }

  /** `open`, `approved` or `rejected`. */
  get reviewState() {
    return this.review.state ?? null
  }

  /** Whether a person has already dealt with it. */
  get resolved() {
    return this.reviewState === 'approved' || this.reviewState === 'rejected'
  }

  /** Your own name for whoever decided. We never invent one. */
  get resolvedBy() {
    return this.review.resolved_by ?? null
  }

  /** @returns {?string} When a person decided, ISO 8601. */
  get resolvedAt() {
    return this.review.resolved_at ?? null
  }

  /**
   * What you have already told us about this verdict: `correct`, `false_positive` or
   * `false_negative`, with its note and the time it was sent.
   *
   * One answer per verdict, so sending a second replaces the first. `null` when nobody has
   * said.
   */
  get feedback() {
    return this.raw.feedback ?? null
  }

  /**
   * The content, when your policy asked us to keep it and it has not expired yet.
   *
   * Empty almost everywhere on purpose: `retain_hours` is 0 by default and a verdict stores
   * a hash of the content and never the content. Only `record()` ever fills this; a listing
   * deliberately does not, because a queue screen wants fifty headlines rather than fifty
   * comments.
   */
  get content() {
    return typeof this.raw.content === 'string' ? this.raw.content : null
  }

  /** @returns {?string} When the retained content is dropped, ISO 8601. */
  get contentExpiresAt() {
    return this.raw.content_expires_at ?? null
  }

  /** What was judged: `text`, `email`, `name`, `image`, ... */
  get kind() {
    return this.raw.kind ?? null
  }

  /** @returns {?string} When the verdict was reached, ISO 8601. */
  get createdAt() {
    return this.raw.created_at ?? null
  }

  /** The batch it arrived in, when it arrived in one. */
  get batchId() {
    return this.raw.batch_id ?? null
  }

  /** How long it took us, in milliseconds. */
  get tookMs() {
    return this.raw.took_ms ?? 0
  }
}

/**
 * A verdict per item, or an error in its place.
 *
 * One bad item is an item, not a batch: the API answers 200 with the failure filed where
 * that item was, so nothing here throws for a single bad element.
 */
export class BatchResult {
  constructor(raw) {
    this.raw = raw ?? {}
  }

  /** @returns {string} The batch's own id, `bat_...`. */
  get id() {
    return this.raw.batch_id ?? ''
  }

  /** @returns {string|null} The project the batch was filed under. */
  get project() {
    return typeof this.raw.project === 'string' ? this.raw.project : null
  }

  /** @returns {string} `queued`, `running` or `completed`. */
  get status() {
    return this.raw.status ?? 'queued'
  }

  /** @returns {boolean} Whether there is nothing left to wait for. */
  get finished() {
    return this.status === 'completed'
  }

  /** Keyed by the position each item was sent in. */
  get verdicts() {
    const out = new Map()

    ;(this.raw.results ?? []).forEach((row, i) => {
      if (!row.error) out.set(row.index ?? i, new Verdict(row))
    })

    return out
  }

  /**
   * The items that could not be judged, keyed by the position each was sent in.
   *
   * Read from BOTH lists: a sync answer files item errors in `results` and `errors`, and a
   * batch read back keeps `results` for the rows that were judged and the errors only in
   * `errors`. Reading one or the other lost every failure of a batch that also had
   * verdicts. An error present in both is listed once.
   *
   * A failure that names no item (a chunk the workers lost, `chunk_failed`) is keyed -1,
   * -2, ... in the order it arrived. No item has a negative position, so it can never be
   * mistaken for, or overwrite, the failure of a real item.
   *
   * @returns {Map<number, Object>}
   */
  get failures() {
    const out = new Map()
    let unplaced = 0

    for (const row of [...(this.raw.results ?? []), ...(this.raw.errors ?? [])]) {
      if (!row?.error) continue

      if (Number.isInteger(row.index)) {
        if (!out.has(row.index)) out.set(row.index, row.error)
      } else {
        out.set(-(++unplaced), row.error)
      }
    }

    return out
  }

  /** @returns {number} How many items were submitted. */
  get count() {
    return this.raw.count ?? 0
  }

  /** @returns {number} How many have a verdict. */
  get processed() {
    return this.raw.processed ?? 0
  }

  /** @returns {number} How many could not be judged. */
  get failed() {
    return this.raw.failed ?? 0
  }

  /** @returns {number} What the batch has cost so far, in credits. */
  get creditsCharged() {
    return this.raw.credits_charged ?? 0
  }

  /**
   * The cursor for the next page of results, or null when that was the last one.
   *
   * A cursor rather than a page number, and this is the field that makes paging work at all:
   * rows appear as workers finish them, so an offset into a growing list skips whatever was
   * inserted behind it. Pass it back as `after`.
   */
  get nextAfter() {
    return this.raw.next_after ?? null
  }

  /** Whether there is another page to ask for. */
  get hasMore() {
    return this.nextAfter !== null
  }
}

/**
 * The client.
 *
 * Two things it does that a hand-rolled wrapper usually does not:
 *
 * **It retries the right failures and never the wrong one.** A 429 and a 5xx are asked
 * again with a growing wait; a 402 is not, ever.
 *
 * **Every retry is the same request.** Each call carries an `Idempotency-Key`, generated
 * here when you do not supply one, so a call that timed out and is asked again is judged
 * once and billed once.
 */
/**
 * Bytes as the API wants them.
 *
 * `btoa` is the only encoder present in every runtime this package supports, and it takes a
 * string of char codes rather than bytes. The chunking is not decoration: spreading a whole
 * image into `String.fromCharCode(...)` blows the argument limit and throws a range error
 * on exactly the large files this path exists for.
 *
 * A string is assumed to be encoded already, because a JavaScript string holds UTF-16 code
 * units and is not where binary lives here.
 */
async function toBase64(data) {
  if (typeof data === 'string') return data

  let bytes

  if (data instanceof Uint8Array) {
    bytes = data
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data)
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    bytes = new Uint8Array(await data.arrayBuffer())
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } else {
    throw new TypeError('imageData takes bytes or a base64 string.')
  }

  let binary = ''
  const chunk = 0x8000

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }

  return btoa(binary)
}

export class ToxicFilter {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? 'https://toxicfilter.com').replace(/\/+$/, '')
    this.retries = options.retries ?? 2
    this.timeout = options.timeout ?? 10_000
    // The longest this will ever sleep between attempts, whatever the service asks for. A
    // 429 says exactly how long to wait and honouring it is the point; honouring it without
    // a ceiling lets a number on the wire decide how long your own request hangs.
    this.maxWait = options.maxWait ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

    if (!this.fetch) {
      throw new Error('No fetch available. Pass one as options.fetch, or use Node 20 or newer.')
    }
  }

  /** A comment, a review, a message, a description. */
  async text(content, options = {}) {
    return this.#verdict('/api/v1/text', { content, ...options })
  }

  /** Judge an address, including a malformed one, which is the point. */
  async email(address, options = {}) {
    return this.#verdict('/api/v1/email', { address, ...options })
  }

  /**
     * Judge a display name or a username.
     *
     * @param {string} name
     * @param {Object} [options]
     * @returns {Promise<Verdict>}
     */
  async name(name, options = {}) {
    return this.#verdict('/api/v1/name', { name, ...options })
  }

  /** Name, email and bio judged together, because the combination is the signal. */
  async signup(fields) {
    return this.#verdict('/api/v1/signup', fields)
  }

  /**
   * A picture, by address or by value.
   *
   * An http or https address is fetched by us. Anything else is the file itself and goes
   * out as bytes: not a guess, since `url` accepts those two schemes and nothing else.
   */
  async image(url, options = {}) {
    if (typeof url !== 'string' || !(url.startsWith('http://') || url.startsWith('https://'))) {
      return this.imageData(url, options)
    }

    return this.#verdict('/api/v1/image', { url, ...options })
  }

  /**
   * A picture you have, rather than one you have published.
   *
   * The reason to check an image is to decide whether to publish it, so requiring a public
   * URL first is the wrong way round: the upload that has not gone live yet, the attachment
   * on a ticket, the avatar somebody just chose. It is also the faster path, since nothing
   * is downloaded and no address has to be resolved.
   *
   * Takes a Uint8Array, an ArrayBuffer, a Blob, a Node Buffer, or a string that is already
   * base64 or a `data:` URI. Inline pictures are never retained by the service, whatever
   * the policy says about held content: you already have the file.
   */
  async imageData(data, options = {}) {
    return this.#verdict('/api/v1/image', { data: await toBase64(data), ...options })
  }

  /**
   * Text on its way into YOUR model, rather than to a reader. Prompt injection, plus
   * everything a comment is checked for.
   */
  async prompt(content, options = {}) {
    return this.#verdict('/api/v1/prompt', { content, ...options })
  }

  /**
   * One link, judged as a link. Never fetches it, so a clean answer means "looks like what
   * it says", not "safe".
   */
  async url(url, options = {}) {
    return this.#verdict('/api/v1/url', { url, ...options })
  }

  /**
   * A message with what came before it.
   *
   * Some of the worst things a moderation system has to catch do not exist in a single
   * message and are built that way: a pile-on is thirty people each writing one rude but
   * ordinary sentence, an approach to a child is an innocuous conversation that becomes
   * something else over a week. The last message is the one judged; the rest is context.
   * Up to fifty, oldest first.
   */
  async conversation(messages, options = {}) {
    return this.#verdict('/api/v1/conversation', { messages, ...options })
  }

  /**
   * Many things in one call, answered now.
   *
   * An idempotency key inside an item is removed before sending: the server checks each
   * item field by field and would fail that item for it. The key is the call's, passed in
   * `options`.
   */
  async batch(items, options = {}) {
    const clean = items.map((item) => {
      const { idempotencyKey, idempotency_key, ...rest } = item ?? {}

      return rest
    })

    return new BatchResult(await this.#post('/api/v1/batch', { items: clean, ...options }))
  }

  /** The same, queued. Answers immediately; the work happens on our side. */
  async batchAsync(items, options = {}) {
    return this.batch(items, { ...options, async: true })
  }

  /**
     * Read an async batch back, with its results paged by cursor.
     *
     * @param {string} batchId
     * @param {Object} [query] `after` and `limit`.
     * @returns {Promise<BatchResult>}
     */
  async batchStatus(batchId, query = {}) {
    return new BatchResult(await this.#get(`/api/v1/batches/${encodeURIComponent(batchId)}`, query))
  }

  /**
   * The most recent batches, newest first, each summarised without its rows.
   *
   * For the caller who lost a batch id: a crashed worker, a restarted deploy. Read one in
   * full with `batchStatus()`.
   *
   * @param {Object} [query] `limit` (1 to 100) and `project`.
   * @returns {Promise<BatchResult[]>}
   */
  async batches(query = {}) {
    const body = await this.#get('/api/v1/batches', query)

    return (Array.isArray(body.batches) ? body.batches : []).map((row) => new BatchResult(row))
  }

  /**
   * What is waiting for a person.
   *
   * Each row is the verdict as it was reached; its review state, feedback, `kind` and dates
   * are not in the listing. `record(id)` has them.
   */
  async records(query = {}) {
    const body = await this.#get('/api/v1/records', query)

    return {
      records: (body.records ?? []).map((row) => new Verdict(row)),
      nextBefore: body.next_before ?? null,
    }
  }

  /**
     * One stored verdict, in full, with the content if any was kept.
     *
     * @param {string} id
     * @returns {Promise<Verdict>}
     */
  async record(id) {
    return new Verdict(await this.#get(`/api/v1/records/${encodeURIComponent(id)}`))
  }

  /** A person decided. `action` is `approved` or `rejected`. */
  async resolve(id, action, { moderator, note } = {}) {
    const payload = { action }
    if (moderator !== undefined) payload.moderator = moderator
    if (note !== undefined) payload.note = note

    return new Verdict(await this.#post(`/api/v1/records/${encodeURIComponent(id)}/resolve`, payload))
  }

  /**
   * Tell us the verdict was wrong. It costs nothing, and it is the only honest measure of
   * whether the thresholds are set well.
   */
  async feedback(id, verdict, { note } = {}) {
    const payload = { verdict }
    if (note !== undefined) payload.note = note

    return new Verdict(await this.#post(`/api/v1/records/${encodeURIComponent(id)}/feedback`, payload))
  }

  /**
   * Credits, the monthly window, prices. Free, and it answers even when the allowance is
   * gone. A check costs 1 credit; a model reading adds the tokens it used, rounded up.
   */
  async usage() {
    return this.#get('/api/v1/usage')
  }

  /** Your keys: prefixes, modes, last use. Never a secret. */
  async keys() {
    return this.#get('/api/v1/keys')
  }

  /** Revokes one, including the one you are calling with. There is no create. */
  async revokeKey(id) {
    return this.#post(`/api/v1/keys/${encodeURIComponent(id)}/revoke`, {})
  }

  /** Is the key good, is the service up. Costs nothing. */
  async ping() {
    return this.#get('/api/v1/ping')
  }

  /**
   * A judging call, refused unless the answer is a verdict.
   *
   * A 2xx JSON object with no decision in it is not an allow; it is something that is not
   * this API answering. Retryable, like any other answer that should not have happened.
   */
  async #verdict(path, payload) {
    const body = await this.#post(path, payload)

    if (!DECISIONS.includes(body.decision)) {
      throw new ServerError('ToxicFilter answered without a decision. Nothing was judged as far as this client can tell.', 200, 'no_decision', body)
    }

    return new Verdict(body)
  }

  async #post(path, payload) {
    const body = { ...payload }

    // One key per call, reused by every retry of that call. That is what makes the
    // retrying safe: the same key means the same request, and the API answers it once
    // however many times the network makes us ask.
    const key = body.idempotencyKey ?? body.idempotency_key ?? `js-${randomId()}`
    delete body.idempotencyKey
    delete body.idempotency_key

    return this.#send('POST', path, {}, body, key)
  }

  async #get(path, query = {}) {
    return this.#send('GET', path, query, null, null)
  }

  async #send(method, path, query, payload, idempotencyKey) {
    const params = new URLSearchParams()

    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) params.set(name, String(value))
    }

    const url = this.baseUrl + path + (params.size ? `?${params}` : '')

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `toxicfilter-js/${VERSION}`,
    }

    if (payload !== null) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    const body = payload === null ? undefined : JSON.stringify(payload)

    for (let attempt = 0; ; attempt++) {
      let error

      try {
        const { status, text, location } = await this.#once(method, url, headers, body)

        // Only a 2xx carrying a JSON object is an answer. Anything else between 200 and 399
        // used to be read as one, and with `{}` as the body: a redirect (an `http://`
        // baseUrl), a proxy's HTML page or a body cut off halfway all came back as an
        // `allow`. The refusals keep their status, so a 502 page is still a server error.
        if (status >= 200 && status < 300) {
          const decoded = parseObject(text)

          if (decoded) return decoded

          throw new ServerError(
            `ToxicFilter answered ${status} with a body that is not a JSON object${text === '' ? ' (it was empty)' : ''}.`,
            status,
            'malformed_response',
          )
        }

        if (status < 400) {
          throw new ServerError(
            `ToxicFilter answered with a redirect (${status})${location ? ` to ${location}` : ''}, which is never an answer. ` +
              'Check the baseUrl: it should be https://toxicfilter.com.',
            status,
            'redirected',
          )
        }

        error = errorFor(status, parseObject(text) ?? {})
      } catch (e) {
        if (e instanceof ToxicFilterError) {
          error = e
        } else {
          // A connection that never arrived is reported as a server error, because the
          // caller does the same thing about either: ask again.
          error = new ServerError(`Could not reach ToxicFilter: ${e.message}`)
        }
      }

      if (!error.retryable || attempt >= this.retries) throw error

      // A rate limit says how long, and that beats guessing: the service knows when its own
      // window turns over. Bounded all the same, so a wrong or hostile number cannot hold a
      // request open for as long as it likes.
      const seconds = error instanceof RateLimited ? error.retryAfter : 2 ** (attempt + 1)
      await this.sleep(Math.min(this.maxWait, seconds * 1000))
    }
  }

  /**
   * One attempt: the request AND its body, under one timeout.
   *
   * The body is read inside the timed section. The timer used to stop when the headers
   * arrived, so a server that sent them and then stalled held the call open for ever. The
   * read is also raced against the abort itself, because not every `fetch` a caller may
   * pass in rejects a body read when its signal fires.
   *
   * A body that fails halfway (a connection reset on a 200) is a ServerError: it is not
   * an answer, and asking again with the same idempotency key is safe.
   */
  async #once(method, url, headers, body) {
    // A request with no timeout is a request that can hang a worker for as long as
    // somebody else's network feels like it.
    const controller = new AbortController()
    let timer

    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new ServerError(`ToxicFilter did not answer within ${this.timeout} ms.`, 0, 'timeout')
        controller.abort(error)
        reject(error)
      }, this.timeout)
    })

    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' })
          const location = response.headers?.get?.('location') ?? null

          let text

          try {
            text = await response.text()
          } catch (e) {
            if (e instanceof ToxicFilterError) throw e
            // A refusal whose body could not be read is still a refusal, typed by its status.
            if (response.status >= 400) return { status: response.status, text: '', location }

            throw new ServerError(`ToxicFilter's answer was cut off: ${e?.message ?? e}`, response.status, 'body_unreadable')
          }

          return { status: response.status, text, location }
        })(),
        expired,
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The body as a JSON object, or null when it is not one.
 *
 * Null rather than `{}`, so that "not an answer" can never be mistaken for an empty one.
 */
function parseObject(text) {
  try {
    const value = JSON.parse(text)

    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/**
 * Checking that a delivery is ours.
 *
 * Your webhook URL is public: anybody who learns it can POST to it, and a handler that
 * acts on whatever arrives is a way to write into your moderation queue from outside.
 *
 * Async because it uses WebCrypto, which is the only HMAC that exists in every runtime
 * this package supports. Pass the RAW body: re-encoding what a framework parsed can
 * reorder a key or escape a slash differently, and then the signature over "the body" is a
 * signature over a different string.
 */
export async function verifyWebhook(payload, header, secret, { tolerance = 300, now = Date.now } = {}) {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((piece) => {
        const [name, ...rest] = piece.trim().split('=')
        return [name, rest.join('=')]
      }),
  )

  const timestamp = Number.parseInt(parts.t ?? '0', 10)
  const signature = parts.v1 ?? ''

  // Exactly a SHA-256 in hex, checked before decoding. `parseInt` reads `+a` or ` a` as a
  // hex byte and a Uint8Array stores NaN as 0, so without this a string that is not hex at
  // all could decode to the right bytes, and the NaN check below it could never fire.
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !/^[0-9a-f]{64}$/i.test(signature)) return false

  // The timestamp is signed WITH the body, so a delivery captured today cannot be
  // replayed tomorrow.
  if (Math.abs(Math.floor(now() / 1000) - timestamp) > tolerance) return false

  const encoder = new TextEncoder()
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signed = new Uint8Array(32)

  for (let i = 0; i < signed.length; i++) {
    signed[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16)
  }

  const data = new Uint8Array([...encoder.encode(`${timestamp}.`), ...bytes])

  // `subtle.verify` compares in constant time, which is the other half of getting this
  // right: a comparison that returns early tells an attacker how much of their guess was
  // correct.
  return globalThis.crypto.subtle.verify('HMAC', key, signed, data)
}

/** The verified event, or null. */
export async function webhookEvent(payload, header, secret, options = {}) {
  if (!(await verifyWebhook(payload, header, secret, options))) return null

  try {
    return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload))
  } catch {
    return null
  }
}

export default ToxicFilter
