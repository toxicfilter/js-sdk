/**
 * Statements of reasons, appeals and the Transparency Database export.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import ToxicFilter, { ServerError, ToxicFilterError, Verdict } from '../index.js'

const VERDICT = {
  id: 'mod_01',
  reference: 'c_1',
  decision: 'review',
  flagged: ['toxicity'],
  scores: { toxicity: 0.55 },
  signals: [],
  policy: { slug: 'house', version: 4 },
}

const STATEMENT = {
  restrictions: ['removal'],
  territories: [],
  duration: null,
  facts: { flagged: ['harassment'], reasons: ['Insults aimed at the reader'], source: 'own_initiative' },
  automated: { detection: true, decision: true },
  ground: { type: 'terms', policy: { slug: 'comments', version: 3 }, clauses: [], terms_url: null },
  redress: { internal: 'appeals@example.com', out_of_court: true, judicial: true },
  locale: 'en',
  text: 'We have removed your content.',
}

function client(responses) {
  const calls = []

  const fetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
      key: init.headers['Idempotency-Key'] ?? null,
    })

    const [status, payload] = responses.shift()

    return { status, text: async () => JSON.stringify(payload) }
  }

  const tf = new ToxicFilter('tf_test_key', { baseUrl: 'https://example.test', fetch, sleep: async () => {} })

  return { tf, calls }
}

test('a verdict carries its statement', () => {
  const verdict = new Verdict({ ...VERDICT, decision: 'block', statement: STATEMENT })

  assert.equal(verdict.statement.restrictions[0], 'removal')
  assert.equal(verdict.statementText, 'We have removed your content.')
})

test('a verdict without a statement says null', () => {
  const verdict = new Verdict(VERDICT)

  assert.equal(verdict.statement, null)
  assert.equal(verdict.statementText, null)
  assert.equal(verdict.appeal, null)
  assert.equal(verdict.appealDecision, null)
  assert.equal(verdict.transparency, null)
})

test('a record carries its appeal and its filing', () => {
  const verdict = new Verdict({
    ...VERDICT,
    appeal: { state: 'open', filed_at: '2026-10-04T10:00:00+00:00', reason: 'A recipe.' },
    transparency: { uuid: '9f1c', submitted_at: '2026-10-04T10:01:00+00:00' },
  })

  assert.equal(verdict.appeal.state, 'open')
  assert.equal(verdict.transparency.uuid, '9f1c')
})

test('it fetches a statement later in a language', async () => {
  const { tf, calls } = client([[200, { id: 'mod_01', statement: STATEMENT }]])

  const statement = await tf.statement('mod_01', { locale: 'es' })

  assert.equal(statement.restrictions[0], 'removal')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'https://example.test/api/v1/records/mod_01/statement?locale=es')
  assert.equal(calls[0].key, null)
})

test('no restriction is raised and never retried', async () => {
  const { tf, calls } = client([[409, { error: { code: 'no_restriction', message: 'This verdict restricts nothing.' } }]])

  await assert.rejects(tf.statement('mod_01'), (e) => {
    assert.ok(e instanceof ToxicFilterError)
    assert.ok(!(e instanceof ServerError))
    assert.equal(e.code, 'no_restriction')
    return true
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/api/v1/records/mod_01/statement')
})

test('a call still in flight is still retried', async () => {
  const { tf, calls } = client([
    [409, { error: { code: 'idempotency_in_flight', message: 'Still running.' } }],
    [200, VERDICT],
  ])

  await tf.text('hello')

  assert.equal(calls.length, 2)
})

test('it files an appeal', async () => {
  const { tf, calls } = client([[201, { ...VERDICT, decision: 'block', appeal: { state: 'open' } }]])

  const verdict = await tf.appeal('mod_01', { reason: 'A recipe.' })

  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://example.test/api/v1/records/mod_01/appeal')
  assert.deepEqual(calls[0].body, { reason: 'A recipe.' })
  assert.ok(calls[0].key)
  assert.equal(verdict.appeal.state, 'open')
})

test('an appeal without words sends an empty body', async () => {
  const { tf, calls } = client([[201, { ...VERDICT, appeal: { state: 'open' } }]])

  await tf.appeal('mod_01')

  assert.deepEqual(calls[0].body, {})
})

test('it resolves an appeal and reads the decision', async () => {
  const { tf, calls } = client([[200, {
    ...VERDICT,
    appeal: { state: 'upheld', resolved_by: 'ana', explanation: 'Because.' },
    appeal_decision: 'We have reviewed your appeal and upheld our decision.',
  }]])

  const verdict = await tf.resolveAppeal('mod_01', 'upheld', 'ana', 'Because.', { locale: 'es' })

  assert.equal(calls[0].url, 'https://example.test/api/v1/records/mod_01/appeal/resolve')
  assert.deepEqual(calls[0].body, { outcome: 'upheld', moderator: 'ana', explanation: 'Because.', locale: 'es' })
  assert.equal(verdict.appealDecision, 'We have reviewed your appeal and upheld our decision.')
  assert.equal(verdict.appeal.state, 'upheld')
})

test('it exports a period for the transparency database', async () => {
  const { tf, calls } = client([[200, { statements: [{ puid: 'mod_01' }], next: 100 }]])

  const page = await tf.transparency('2026-10-01', { until: '2026-10-31', project: 'forum', after: 50 })

  assert.equal(calls[0].method, 'GET')
  assert.equal(
    calls[0].url,
    'https://example.test/api/v1/statements/transparency?since=2026-10-01&until=2026-10-31&project=forum&after=50',
  )
  assert.equal(page.statements[0].puid, 'mod_01')
  assert.equal(page.next, 100)
})

test('an export sends only what was given', async () => {
  const { tf, calls } = client([[200, { statements: [], next: null }]])

  await tf.transparency('2026-10-01')

  assert.equal(calls[0].url, 'https://example.test/api/v1/statements/transparency?since=2026-10-01')
})
