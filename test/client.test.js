/**
 * The JavaScript client, against a fetch that answers like the API does.
 *
 * The behaviours worth testing are the ones a caller cannot see and would otherwise find
 * out from an invoice: what gets retried, what never does, and whether a retry is the same
 * request or a second one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'

import ToxicFilter, {
  InvalidRequest,
  QuotaExhausted,
  RateLimited,
  ServerError,
  verifyWebhook,
  webhookEvent,
} from '../index.js'

const VERDICT = {
  id: 'mod_01',
  reference: 'c_1',
  decision: 'review',
  flagged: ['toxicity'],
  scores: { toxicity: 0.55 },
  signals: [{ category: 'toxicity', score: 0.55, detector: 'term', reason: 'Contains 1 profanity.' }],
  used_ai: false,
  took_ms: 2,
  cached: false,
  policy: { slug: 'house', version: 4 },
  credits: { remaining: 940, charged: 1, renews_at: '2026-09-30T00:00:00+00:00' },
}

function client(responses, options = {}) {
  const calls = []

  const fetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
      key: init.headers['Idempotency-Key'] ?? null,
    })

    const [status, payload] = responses.shift()

    return { status, text: async () => JSON.stringify(payload) }
  }

  const tf = new ToxicFilter('tf_test_key', {
    baseUrl: 'https://example.test',
    fetch,
    sleep: async () => {},
    ...options,
  })

  return { tf, calls }
}

test('it reads the answer', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  const verdict = await tf.text('you fucking legend', { locales: ['en'], reference: 'c_1' })

  assert.equal(verdict.needsReview, true)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.id, 'mod_01')
  assert.deepEqual(verdict.flagged, ['toxicity'])
  assert.equal(verdict.score('toxicity'), 0.55)
  assert.equal(verdict.score('hate'), 0)
  assert.deepEqual(verdict.reasons, ['Contains 1 profanity.'])
  assert.deepEqual(verdict.policy, { slug: 'house', version: 4 })
  assert.equal(verdict.charged, 1)

  assert.equal(calls[0].url, 'https://example.test/api/v1/text')
  assert.deepEqual(calls[0].body, { content: 'you fucking legend', locales: ['en'], reference: 'c_1' })
})

test('a conversation goes up as a conversation', async () => {
  // The last message is judged; the rest is what makes a pile-on visible at all.
  const { tf, calls } = client([[200, VERDICT]])

  const messages = [
    { author: 'u1', content: 'menudo idiota eres' },
    { author: 'u5', content: 'no tienes ni idea' },
  ]

  await tf.conversation(messages, { locales: ['es'], ai: false })

  assert.equal(calls[0].url, 'https://example.test/api/v1/conversation')
  assert.deepEqual(calls[0].body, { messages, locales: ['es'], ai: false })
})

test('it reads the second axis', async () => {
  // Topics are not categories: how much a post is ABOUT something, measured always.
  const { tf } = client([[200, { ...VERDICT, topics: { gambling: 0.82 }, facts: { age_signal: 13 }, degraded: true }]])

  const verdict = await tf.text('x')

  assert.equal(verdict.topic('gambling'), 0.82)
  assert.equal(verdict.topic('crypto'), 0)
  assert.equal(verdict.facts.age_signal, 13)
  assert.equal(verdict.degraded, true)
})

test('it reads the lead types', async () => {
  // Who is writing and what they want: neither a harm nor a subject, and several at once.
  const { tf } = client([[200, { ...VERDICT, leads: { free_work_for_equity: 0.9, no_budget: 0.7 } }]])

  const verdict = await tf.text('x')

  assert.equal(verdict.lead('free_work_for_equity'), 0.9)
  assert.equal(verdict.lead('no_budget'), 0.7)
  assert.equal(verdict.lead('no_show'), 0)
})

test('there is no toxic boolean', async () => {
  // Collapsing fifteen categories into one flag is what this API exists not to do.
  const { tf } = client([[200, VERDICT]])
  const verdict = await tf.text('x')

  assert.equal(verdict.isToxic, undefined)
})

test('it retries a rate limit and a server error', async () => {
  const { tf, calls } = client([
    [429, { error: { code: 'rate_limited' } }],
    [500, {}],
    [200, VERDICT],
  ])

  const verdict = await tf.text('hello')

  assert.equal(verdict.needsReview, true)
  assert.equal(calls.length, 3)
})

test('a retry is the same request', async () => {
  // The pairing that makes automatic retries safe: same key, so one charge.
  const { tf, calls } = client([
    [500, {}],
    [200, VERDICT],
  ])

  await tf.text('hello')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].key, calls[1].key)
  assert.ok(calls[0].key.startsWith('js-'))
})

test('two calls are two keys', async () => {
  const { tf, calls } = client([
    [200, VERDICT],
    [200, VERDICT],
  ])

  await tf.text('one')
  await tf.text('two')

  assert.notEqual(calls[0].key, calls[1].key)
})

test('it never retries a quota', async () => {
  // 402 means come back with a bigger plan. Retrying it hammers forever.
  const { tf, calls } = client([
    [402, { error: { code: 'quota_exhausted' }, credits: { remaining: 20, required: 40 } }],
    [200, VERDICT],
  ])

  await assert.rejects(
    () => tf.image('https://example.test/a.jpg'),
    (error) => {
      assert.ok(error instanceof QuotaExhausted)
      assert.equal(error.remaining, 20)
      assert.equal(error.required, 40)
      assert.equal(error.retryable, false)
      return true
    },
  )

  assert.equal(calls.length, 1)
})

test('it gives up eventually', async () => {
  const { tf, calls } = client([[500, {}], [500, {}], [500, {}]], { retries: 2 })

  await assert.rejects(() => tf.text('hello'), ServerError)
  assert.equal(calls.length, 3)
})

test('a rate limit that never clears is still raised', async () => {
  const { tf } = client([[429, {}], [429, {}]], { retries: 1 })

  await assert.rejects(() => tf.text('hello'), RateLimited)
})

test('a bad request is typed', async () => {
  const { tf } = client([[422, { message: 'required', errors: { content: ['required'] } }]])

  await assert.rejects(
    () => tf.text(''),
    (error) => {
      assert.ok(error instanceof InvalidRequest)
      assert.deepEqual(error.fields, { content: ['required'] })
      return true
    },
  )
})

test('a batch separates verdicts from failures', async () => {
  const { tf, calls } = client([
    [
      200,
      {
        batch_id: 'bat_01',
        status: 'completed',
        count: 2,
        processed: 1,
        failed: 1,
        results: [
          { index: 0, ...VERDICT },
          { index: 1, error: { code: 'validation_failed' } },
        ],
      },
    ],
  ])

  const result = await tf.batch([{ kind: 'text', content: 'one' }, { kind: 'text' }], { ai: false })

  assert.equal(result.finished, true)
  assert.equal(result.verdicts.get(0).reference, 'c_1')
  assert.equal(result.failures.get(1).code, 'validation_failed')
  assert.deepEqual(calls[0].body.items[0], { kind: 'text', content: 'one' })
})

test('async sets the flag', async () => {
  const { tf, calls } = client([[202, { batch_id: 'bat_01', status: 'queued', count: 1 }]])

  const result = await tf.batchAsync([{ kind: 'text', content: 'one' }])

  assert.equal(result.status, 'queued')
  assert.equal(calls[0].body.async, true)
})

test('it reads and resolves the queue', async () => {
  const { tf, calls } = client([
    [200, { records: [VERDICT], next_before: null }],
    [200, VERDICT],
    [200, VERDICT],
  ])

  const queue = await tf.records({ state: 'open', limit: 10 })

  assert.equal(queue.records[0].reference, 'c_1')
  assert.equal(calls[0].url, 'https://example.test/api/v1/records?state=open&limit=10')

  await tf.resolve('mod_01', 'approved', { moderator: 'ana@example.com' })
  await tf.feedback('mod_01', 'false_positive')

  assert.deepEqual(calls[1].body, { action: 'approved', moderator: 'ana@example.com' })
  assert.deepEqual(calls[2].body, { verdict: 'false_positive' })
})

test('reads carry no idempotency key', async () => {
  const { tf, calls } = client([[200, { ok: true }]])

  await tf.ping()

  assert.equal(calls[0].key, null)
})

const BODY = '{"id":"whd_1","event":"moderation.review","data":{}}'
const SECRET = `whsec_${'a'.repeat(40)}`

function signature(at = Math.floor(Date.now() / 1000), body = BODY) {
  const digest = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex')

  return `t=${at},v1=${digest}`
}

test('it accepts a delivery of ours', async () => {
  assert.equal(await verifyWebhook(BODY, signature(), SECRET), true)

  const event = await webhookEvent(BODY, signature(), SECRET)
  assert.equal(event.event, 'moderation.review')
})

test('it refuses everything else', async () => {
  assert.equal(await verifyWebhook(BODY, signature(), 'whsec_other'), false)
  assert.equal(await verifyWebhook(`${BODY} `, signature(), SECRET), false)
  assert.equal(await verifyWebhook(BODY, signature(Math.floor(Date.now() / 1000) - 3600), SECRET), false)
  assert.equal(await verifyWebhook(BODY, 'nonsense', SECRET), false)
  assert.equal(await webhookEvent(BODY, 'nonsense', SECRET), null)
})

/**
 * Inline pictures.
 *
 * The endpoint takes an address OR bytes and exactly one of them, and for a long time
 * every client here could only send the address. That is the wrong way round for the
 * commonest case: the reason to check an image is to decide whether to publish it, so
 * demanding it be published first defeats the purpose.
 */
test('it sends bytes as data, never as a url', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  await tf.imageData(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { reference: 'avatar_9' })

  assert.equal(calls[0].url, 'https://example.test/api/v1/image')
  assert.equal(calls[0].body.data, 'iVBORw0KGgo=')
  assert.equal('url' in calls[0].body, false)
  assert.equal(calls[0].body.reference, 'avatar_9')
})

test('a data uri handed to image() goes out as bytes', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  await tf.image('data:image/png;base64,iVBORw0KGgo=')

  // Sending it as `url` would be refused, and the caller would have no idea why: it is a
  // URI, it just is not an address.
  assert.equal(calls[0].body.data, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal('url' in calls[0].body, false)
})

test('an already encoded string is not encoded twice', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  await tf.imageData('iVBORw0KGgo=')

  assert.equal(calls[0].body.data, 'iVBORw0KGgo=')
})

test('large pictures do not blow the argument limit', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  // Over `String.fromCharCode`'s comfortable limit, which is what the chunking is for. A
  // spread of the whole array throws a RangeError on exactly the files this path exists to
  // carry.
  const big = new Uint8Array(200_000).fill(65)

  await tf.imageData(big)

  assert.equal(calls[0].body.data.length, Math.ceil(200_000 / 3) * 4)
})

test('bare base64 handed to image() also goes out as bytes', async () => {
  const { tf, calls } = client([[200, VERDICT]])

  await tf.image('iVBORw0KGgo=')

  assert.equal(calls[0].body.data, 'iVBORw0KGgo=')
  assert.equal('url' in calls[0].body, false)
})

/**
 * How long a retry waits, and who decides.
 *
 * A 429 now says exactly how long: the service knows when its own window turns over, and
 * guessing at it is how a client either gives up early or comes back too soon. Bounded all
 * the same, or a number on the wire decides how long the caller's own request hangs.
 */
function waiting(responses, options = {}) {
  const waited = []
  const { tf, calls } = client(responses, { sleep: async (ms) => waited.push(ms), ...options })

  return { tf, calls, waited }
}

test('it waits as long as the service asked', async () => {
  const { tf, waited } = waiting([
    [429, { error: { code: 'rate_limited' }, retry_after: 7 }],
    [200, VERDICT],
  ])

  await tf.text('hello')

  assert.deepEqual(waited, [7000])
})

test('the wait is bounded', async () => {
  const { tf, calls, waited } = waiting([
    [429, { error: { code: 'rate_limited' }, retry_after: 86_400 }],
    [200, VERDICT],
  ])

  await tf.text('hello')

  assert.deepEqual(waited, [30_000], 'A day is not a retry, it is a hang.')
  assert.equal(calls.length, 2, 'Still retried: the wait is capped, not abandoned.')
})

test('a rate limit with no number still waits', async () => {
  const { tf, waited } = waiting([[429, { error: { code: 'rate_limited' } }], [200, VERDICT]])

  await tf.text('hello')

  assert.deepEqual(waited, [1000])
})

test('a server error grows its own wait', async () => {
  const { tf, waited } = waiting([[500, {}], [500, {}], [200, VERDICT]])

  await tf.text('hello')

  assert.deepEqual(waited, [2000, 4000], 'Nothing said how long, so it doubles.')
})

test('the bound is yours to set', async () => {
  const { tf, waited } = waiting([[429, { retry_after: 45 }], [200, VERDICT]], { maxWait: 5000 })

  await tf.text('hello')

  assert.deepEqual(waited, [5000])
})

/**
 * The fields the API returns and this client could not reach.
 *
 * All of it was in `raw`, which means the client was answering "dig it out yourself" about
 * fields its own service documents, and a field somebody reads out of `raw` is a field this
 * client is free to break.
 */
test('it reads the masked content', async () => {
  const { tf } = client([[200, { ...VERDICT, redacted: 'call me on [redacted]' }]])

  const verdict = await tf.text('call me on 600 123 456', { redact: true })

  assert.equal(verdict.redacted, 'call me on [redacted]')
})

test('content that was not masked is null', async () => {
  const { tf } = client([[200, VERDICT]])

  // Null and not '': you did not ask, which is a different statement from "there was
  // nothing to mask" and must not read as "the content is empty".
  assert.equal((await tf.text('anything')).redacted, null)
})

test('it reads the context', async () => {
  const { tf } = client([[200, {
    ...VERDICT,
    context: { actor: 'u_91', repeats: 47, similar: 12, history: { seen: 800, blocked: 2, adjustment: 0.1 } },
  }]])

  const context = (await tf.text('buy now')).context

  assert.equal(context.repeats, 47)
  assert.equal(context.similar, 12)
  // Always reported, because a line moved by somebody's record with no way to see it is not
  // something you can defend.
  assert.equal(context.history.adjustment, 0.1)
})

test('a verdict judged on its own has no context', async () => {
  const { tf } = client([[200, VERDICT]])

  assert.deepEqual((await tf.text('anything')).context, {})
})

test('it reads what the trialled policy would have said', async () => {
  const { tf } = client([[200, { ...VERDICT, shadow: { slug: 'stricter', version: 3, decision: 'block' } }]])

  const verdict = await tf.text('you fucking legend')

  assert.equal(verdict.decision, 'review', 'The live policy decides; the trial never does.')
  assert.equal(verdict.shadow.decision, 'block')
  assert.equal(verdict.shadow.slug, 'stricter')
  assert.equal(verdict.shadow.version, 3)
})

test('it reads a stored verdicts flat shadow fields', async () => {
  const { Verdict } = await import('../index.js')
  const verdict = new Verdict({ decision: 'review', shadow_slug: 'stricter', shadow_decision: 'block' })

  assert.equal(verdict.shadow.slug, 'stricter')
  assert.equal(verdict.shadow.decision, 'block')
})

test('no shadow policy is null', async () => {
  const { tf } = client([[200, VERDICT]])

  assert.equal((await tf.text('anything')).shadow, null)
})

test('it reads the queue state', async () => {
  const { tf } = client([[200, {
    ...VERDICT,
    kind: 'text',
    created_at: '2026-09-17T10:00:00+00:00',
    batch_id: 'batch_01',
    review: {
      state: 'approved',
      resolved_at: '2026-09-17T11:00:00+00:00',
      resolved_by: 'ana@example.com',
      note: 'Enthusiasm.',
    },
    feedback: { verdict: 'false_positive', note: null, at: '2026-09-17T11:01:00+00:00' },
    content: 'you fucking legend',
    content_expires_at: '2026-09-17T17:00:00+00:00',
  }]])

  const verdict = await tf.record('mod_01')

  assert.equal(verdict.reviewState, 'approved')
  assert.equal(verdict.resolved, true)
  assert.equal(verdict.resolvedBy, 'ana@example.com')
  assert.equal(verdict.resolvedAt, '2026-09-17T11:00:00+00:00')
  assert.equal(verdict.review.note, 'Enthusiasm.')
  assert.equal(verdict.feedback.verdict, 'false_positive')
  assert.equal(verdict.content, 'you fucking legend')
  assert.equal(verdict.contentExpiresAt, '2026-09-17T17:00:00+00:00')
  assert.equal(verdict.kind, 'text')
  assert.equal(verdict.createdAt, '2026-09-17T10:00:00+00:00')
  assert.equal(verdict.batchId, 'batch_01')
  assert.equal(verdict.tookMs, 2)
})

test('an open entry is not resolved and has no feedback', async () => {
  const { Verdict } = await import('../index.js')
  const verdict = new Verdict({ decision: 'review', review: { state: 'open' }, feedback: null })

  assert.equal(verdict.reviewState, 'open')
  assert.equal(verdict.resolved, false)
  assert.equal(verdict.feedback, null)
  // Retention is off by default, so there is normally nothing to show a moderator.
  assert.equal(verdict.content, null)
})

test('a batch page carries its cursor', async () => {
  const { tf, calls } = client([
    [200, { batch_id: 'batch_01', status: 'running', results: [], next_after: 99 }],
    [200, { batch_id: 'batch_01', status: 'completed', results: [], next_after: null }],
  ])

  const first = await tf.batchStatus('batch_01')

  assert.equal(first.nextAfter, 99)
  assert.equal(first.hasMore, true)

  const last = await tf.batchStatus('batch_01', { after: first.nextAfter })

  assert.equal(last.nextAfter, null)
  assert.equal(last.hasMore, false)
  assert.ok(calls[1].url.includes('after=99'))
})
