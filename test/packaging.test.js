import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/*
 * What the package promises about itself, rather than what the client does.
 *
 * Each of these fails silently for whoever hits it: a `files` list missing the types is a
 * package that installs without them, an `engines` floor that CI never runs is a promise
 * nobody checks, and a relative banner is a broken image on the registry page.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

test('what gets published is the client, its types, the README and the licence', () => {
  assert.deepEqual(manifest.files.sort(), ['LICENSE', 'README.md', 'index.d.ts', 'index.js'])

  // `art/` is deliberately absent: the images are on GitHub and the README points at them
  // by absolute URL, so the tarball stays small.
  assert.ok(! manifest.files.includes('art'))
})

test('the types are declared in both places a tool might look', () => {
  assert.equal(manifest.types, 'index.d.ts')
  assert.equal(manifest.exports['.'].types, './index.d.ts')
  assert.ok(existsSync(resolve(ROOT, 'index.d.ts')))
})

test('it declares no dependencies', () => {
  // The whole argument for this client: `fetch` and nothing else, so it cannot start an
  // argument with whatever the host application already pins.
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.sideEffects, false)
})

test('the node floor is a version the CI actually runs', () => {
  const floor = manifest.engines.node.match(/(\d+)/)[1]
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf8')
  const tested = [...workflow.matchAll(/'(\d+)'/g)].map((m) => Number(m[1])).sort((a, b) => a - b)

  assert.equal(Number(floor), tested[0], 'engines and the CI matrix disagree')

  // 20 and not 18 for a measured reason: `verifyWebhook` reaches `globalThis.crypto.subtle`,
  // which is only global without a flag from Node 19.
  assert.ok(Number(floor) >= 20)
})

test('a scoped package is published publicly', () => {
  // A scoped package is private by default and `npm publish` refuses it with a 402, which
  // reads exactly like a billing problem and is not one.
  assert.equal(manifest.publishConfig.access, 'public')
})

test('the art exists and the README shows it by absolute url', () => {
  for (const name of ['banner.svg', 'banner.png', 'og.svg', 'og.png']) {
    assert.ok(existsSync(resolve(ROOT, 'art', name)), `art/${name} is missing`)
  }

  // npm rewrites a relative image against the repository and PyPI does not; the absolute
  // URL is the one form that works on every page this README appears on.
  assert.match(
    readFileSync(resolve(ROOT, 'README.md'), 'utf8'),
    /^!\[ToxicFilter JavaScript SDK\]\(https:\/\/raw\.githubusercontent\.com\/toxicfilter\/js-sdk\/main\/art\/banner\.png\)/,
  )
})
