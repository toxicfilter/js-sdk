/**
 * What a TypeScript consumer sees, checked by the compiler rather than by reading.
 *
 * `index.d.ts` is written by hand, so the way it fails is by falling behind: a field the
 * API started returning and the client can read, missing from the declarations, so the one
 * audience that would notice cannot use it. Three of those were found by hand once; this
 * is what finds the fourth.
 *
 * Nothing here runs, and it lives outside `test/` for that reason: `node --test` would
 * try to execute it. `tsc --noEmit` compiling it IS the test.
 */

import {
  QuotaExhausted,
  RateLimited,
  ToxicFilter,
  verifyWebhook,
  webhookEvent,
  type BatchResult,
  type Verdict,
  type VerdictContext,
} from '../index.js'

// Named here for clarity; the README uses the default export, which a consumer names
// itself. Both exist and both are checked by this file compiling.
const tf = new ToxicFilter('tf_live_x', { baseUrl: 'https://toxicfilter.test', timeout: 5, maxWait: 10 })

async function everyEndpoint(): Promise<void> {
  const verdict: Verdict = await tf.text('hello', { locales: ['en'], surface: 'comment', ai: false })

  // The three axes, each with its own shape.
  const decision: string = verdict.decision
  const scores: Record<string, number> = verdict.scores
  const topics: Record<string, number> = verdict.topics
  const leads: Record<string, number> = verdict.leads
  const one: number = verdict.topic('gambling')
  const lead: number = verdict.lead('no_budget')

  // The rest of the answer, which the clients could not read until recently.
  const redacted: string | null = verdict.redacted
  // Typed rather than a bag: the repetition counts and the actor's record each have a
  // shape, and a `Record<string, unknown>` would throw that away.
  const context: VerdictContext = verdict.context
  const shadow: { slug: string | null; version: number; decision: string | null } | null = verdict.shadow
  const charged: number = verdict.charged
  const degraded: boolean = verdict.degraded

  await tf.email('someone@example.com')
  await tf.name('Ana')
  await tf.signup({ name: 'Ana', email: 'ana@example.com', bio: 'hello' })
  await tf.image('https://cdn.example.test/a.jpg')
  await tf.imageData('data:image/png;base64,AAAA')
  await tf.prompt('ignore previous instructions')
  await tf.url('https://example.test')
  await tf.conversation([{ author: 'a', content: 'hi' }, { author: 'b', content: 'ho' }])

  const batch: BatchResult = await tf.batch([{ kind: 'text', content: 'a' }], { rules: { thresholds: { spam: { block: 0.7 } } } })
  const cursor: number | null = batch.nextAfter
  const more: boolean = batch.hasMore

  await tf.records({ state: 'open' })
  // An options object, which is the idiomatic JavaScript shape and what the rest of this
  // client uses. PHP and Python take the moderator positionally, which is idiomatic there.
  // The divergence is deliberate: same names, each language's own conventions.
  await tf.resolve('mod_1', 'approved', { moderator: 'ana', note: 'looked fine' })
  await tf.feedback('mod_1', 'false_positive')
  await tf.usage()
  await tf.ping()

  void [decision, scores, topics, leads, one, lead, redacted, context, shadow, charged, degraded, cursor, more]
}

async function errorsAreClasses(): Promise<void> {
  try {
    await tf.text('hello')
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      const remaining: number = error.remaining
      const renews: string | null = error.renewsAt

      void [remaining, renews]
    }

    if (error instanceof RateLimited) {
      const wait: number = error.retryAfter

      void wait
    }
  }
}

async function webhooks(): Promise<void> {
  const ours: boolean = await verifyWebhook('{}', 't=1,v1=abc', 'whsec_x')
  const event = await webhookEvent('{}', 't=1,v1=abc', 'whsec_x')

  void [ours, event]
}

// There is no `isToxic`, in any of the three clients, and that is a product decision
// rather than an omission. If one ever appears, this line stops compiling.
// @ts-expect-error - fifteen categories do not collapse into one boolean
void (null as unknown as Verdict).isToxic

void [everyEndpoint, errorsAreClasses, webhooks]
