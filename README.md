![ToxicFilter JavaScript SDK](https://raw.githubusercontent.com/toxicfilter/js-sdk/main/art/banner.png)

# ToxicFilter JavaScript SDK

[![npm version](https://img.shields.io/npm/v/toxicfilter-sdk.svg)](https://www.npmjs.com/package/toxicfilter-sdk) [![npm downloads](https://img.shields.io/npm/dm/toxicfilter-sdk.svg)](https://www.npmjs.com/package/toxicfilter-sdk) [![license](https://img.shields.io/npm/l/toxicfilter-sdk.svg)](https://github.com/toxicfilter/js-sdk/blob/main/LICENSE) [![bundle size](https://img.shields.io/bundlephobia/minzip/toxicfilter-sdk)](https://bundlephobia.com/package/toxicfilter-sdk)

The official JavaScript client for [ToxicFilter](https://toxicfilter.com).

```bash
npm install toxicfilter-sdk
```

```js
import ToxicFilter from 'toxicfilter-sdk'

const tf = new ToxicFilter(process.env.TOXICFILTER_KEY)

const verdict = await tf.text('Check this message', {
  locales: ['en'],
  surface: 'comment',
  reference: 'comment_9931',
})

if (verdict.blocked) return refuse(verdict.reason) // the first reason; reasons has them all
if (verdict.needsReview) return hold(verdict.id, verdict.reasons)

publish()
```

Three decisions, not two. `review` is where the uncertainty is allowed to live: forced to
choose between publishing and deleting, a threshold set safely deletes real posts and one
set kindly publishes the abuse. There is no `isToxic` here for the same reason: fifteen
categories collapsed into one boolean is somebody else's policy in your code.

> **Server side only.** Your API key is a bearer credential for the whole account. In a
> browser bundle it is public and anybody who reads it can spend your allowance. Moderate
> on your backend and send the verdict to the page.

## What it does for you

**Retries the right failures and never the wrong one.** A 429 or a 5xx is asked again with
a growing wait; `QuotaExhausted` is not, ever.

**Makes those retries safe.** Every call carries an `Idempotency-Key`, generated per call,
so a request that timed out and is asked again is judged once and billed once.

**Waits as long as the service asked, and no longer.** A 429 carries `retry_after`, and
honouring it beats guessing: the service knows when its own window turns over. It is bounded
by `maxWait` (30000 ms by default) all the same, because a number on the wire should not
decide how long your own request hangs.

```js
import { QuotaExhausted, RateLimited } from 'toxicfilter-sdk'

try {
  await tf.text(comment)
} catch (error) {
  if (error instanceof QuotaExhausted) alert(`out of credits: ${error.remaining} left`)
  if (error instanceof RateLimited) backOff()
}
```

## When the model is down

A verdict reached without the model because the provider was failing comes back with
`degraded` set, and is billed as the check alone: a check costs 1 credit, and only a model
reading adds its tokens, rounded up. It is a separate field from `used_ai` on
purpose: one says the cheap detectors were enough, the other says nobody read it, and only
the first is reassuring. Hold or queue what matters to you when you see it.

## Projects

An organization can moderate several sites, one project each. Name the project and the
verdict is filed there, with its own activity, review queue and webhooks; leave it out and it
goes to your default project. The keys and the credits are the organization's.

```js
const verdict = await tf.text(comment, { project: 'forum' })
verdict.project // 'forum'

await tf.batch(items, { project: 'forum' })   // the whole batch, on the envelope
await tf.records({ project: 'forum' })        // one project's queue
await tf.batches({ project: 'forum' })        // its recent batches
```

A project that does not exist is refused with an `InvalidRequest` (`unknown_project`).

## Rules without a policy

Send the line you care about and nothing else is acted on. No stored policy is looked up,
and no default of ours is laid underneath.

```js
const verdict = await tf.text(comment, {
  rules: { thresholds: { sexual: { block: 0.7 } } },
})
```

A category you did not mention still scores and still appears in `signals`; it just does not
decide anything. A name that is not a real category, subject or lead type is a `422`: a line
that acts on nothing looks exactly like a line that works.

Send `rules` together with a `policy` and they are laid over it instead: the call wins for
what it names, the policy keeps everything else, and words are added to its lists.
`verdict.policy` then says `overridden: true`.

```js
const verdict = await tf.text(comment, {
  policy: 'comments',
  rules: { thresholds: { spam: { block: 0.6 } } },
})
```

## The rest of the answer

```js
verdict.redacted   // the content with the personal data masked, when you asked
verdict.context    // repeats, near-duplicates, the actor's record and what it moved
verdict.shadow     // what a policy you are trialling would have said. Never what happened
verdict.facts      // noticed, not a finding: a language, an age signal, a fingerprint
verdict.degraded   // part of the pipeline could not run
verdict.model      // { asked, read, why } when the model was deliberately not run, else null
```

`redacted` is usually worth more than a refusal: throwing a whole comment away because it
carried one phone number throws away everything else the person wrote.

```js
const verdict = await tf.text(comment, { redact: true, actor: 'user_8812' })

publish(verdict.redacted ?? comment)
```

## Who is writing

Every verdict also carries `leads`: what kind of lead wrote it, scored per type. Neither a
harm nor a subject, but who is on the other side and what they want.

```js
const verdict = await tf.conversation(messages, {
  rules: { leads: { free_work_for_equity: { block: 0.6 } } },
})

verdict.leads                 // { free_work_for_equity: 0.9, no_budget: 0.7 }
verdict.lead('sales_pitch')   // 0 when nothing of that type showed
verdict.blocked               // true: your rule discarded it
```

Types: `free_work_for_equity`, `no_budget`, `unrealistic_expectations`, `free_consulting`,
`scope_creep`, `no_show`, `sales_pitch`, `partnership_offer`, `job_seeker`,
`student_or_survey`, `support_request`. Send the conversation rather than one message and
everything that person said counts.

## Everything else

```js
await tf.email('someone@mailinator.com')
await tf.name('asdkjhasd')
await tf.signup({ name: 'Ana', email: 'ana@example.com', bio: '...' })
await tf.image('https://cdn.example.com/photo.jpg')
await tf.image(base64OrDataUri)                 // or the bytes, if you have not published it
await tf.imageData(bytes)                       // Uint8Array, ArrayBuffer, Blob or Buffer
await tf.url('https://bit.ly/3xYz')             // one link, judged as a link
await tf.prompt(whatTheUserTypedIntoYourChatbot)   // prompt injection, plus everything else

// A message with what came before it. A pile-on is thirty people each writing one
// ordinary rude sentence, and no classifier reading one of them can see it.
await tf.conversation([
  { author: 'u1', content: '...' },
  { author: 'u2', content: '...' },
  { author: 'u5', content: 'the one being judged' },
], { locales: ['es'] })

// Many things in one call. One bad item is an item, not a batch.
const batch = await tf.batch([
  { kind: 'text', content: '...', reference: 'c_1' },
  { kind: 'image', url: '...', reference: 'p_2' },
], { ai: false })

batch.verdicts.forEach((verdict, index) => { /* ... */ })
batch.failures.forEach((error, index) => { /* ... */ })   // index -1, -2... names no item

// A backfill: queued, answered immediately, polled or webhooked.
const queued = await tf.batchAsync(tenThousandComments)
await tf.batchStatus(queued.id)

// A backfill read back a page at a time. A cursor, not an offset: rows appear as workers
// finish them, so an offset skips whatever was inserted behind it.
let page = await tf.batchStatus(queued.id)

while (page.hasMore) {
  page = await tf.batchStatus(queued.id, { after: page.nextAfter })
}

// The review queue.
const { records } = await tf.records({ state: 'open' })   // the verdicts; review state via record(id)
await tf.resolve(id, 'approved', { moderator: 'ana@example.com' })
await tf.feedback(id, 'false_positive')   // free, and the only honest measure we have

// And what a held verdict has had done to it.
const held = await tf.record(id)
held.reviewState   // open, approved or rejected
held.resolvedBy    // your own name for whoever decided
held.feedback      // what you already told us, or null
held.content       // only when your policy keeps it, and only until it expires

await tf.keys()               // prefixes, modes, last use. Never a secret.
await tf.revokeKey(id)        // including the one you are calling with. There is no create.

await tf.usage()   // credits, the monthly window, prices. Works at zero credits.
await tf.ping()
```

## What is not an answer

Only a `2xx` carrying a JSON object with a decision in it is a verdict. A redirect (an
`http://` baseUrl), a proxy's HTML page, an empty body or a connection cut off halfway
through one throws a retryable `ServerError` instead, and the timeout covers the body as
well as the headers. A moderation client that read those as `allow` would publish whatever
it was asked about on the day something between it and the API went wrong.

## Webhooks

Your endpoint URL is public. Verify before you act:

```js
import { webhookEvent } from 'toxicfilter-sdk'

const body = await request.text()          // the RAW body

const event = await webhookEvent(
  body,
  request.headers.get('x-toxicfilter-signature'),
  process.env.TOXICFILTER_WEBHOOK_SECRET,
)

if (!event) return new Response('', { status: 400 })
```

It is async because it uses WebCrypto, which is the only HMAC that exists in every runtime
this package supports.

## Notes

Node 20+, Deno, Bun, Cloudflare Workers and Vercel Edge: anywhere with `fetch` and
`crypto.subtle`, which is what verifying a webhook signature needs. No dependencies. Types
included.

## How this is tested

The suite drives the client through a stub transport and covers the parts a caller cannot
see: what is retried, what never is, and that a retry reuses its idempotency key while two
separate calls do not.

The API contract itself is pinned on the other side, by the ToxicFilter application's own
suite, which runs the PHP client against its real routes. Recorded fixtures would agree
with the API on the day they were written and drift silently afterwards.

## Author

Created by [Edu Lazaro](https://edulazaro.com) for [ToxicFilter](https://toxicfilter.com),
the moderation API this client speaks to.

## License

The ToxicFilter JavaScript SDK is open-sourced software licensed under the [MIT license](LICENSE).
