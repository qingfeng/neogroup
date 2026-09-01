import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(import.meta.url)

function loadModule(relativePath) {
  const sourcePath = resolve(root, relativePath)
  const source = readFileSync(sourcePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText

  const module = { exports: {} }
  vm.runInNewContext(transpiled, {
    Date,
    URL,
    console,
    exports: module.exports,
    fetch,
    module,
    require,
  }, { filename: sourcePath })
  return module.exports
}

test('resolves ActivityPub-origin Mastodon status URLs to the origin context API target', () => {
  const { resolveMastodonContextTarget } = loadModule('src/lib/mastodon-sync-target.ts')

  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveMastodonContextTarget('activitypub_origin', 'https://douban.city/users/qingfeng/statuses/117197021490955826'))),
    { domain: 'douban.city', statusId: '117197021490955826', rootStatusId: '117197021490955826', storesCanonicalUri: true },
  )
})

test('keeps regular Mastodon status IDs unchanged', () => {
  const { resolveMastodonContextTarget } = loadModule('src/lib/mastodon-sync-target.ts')

  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveMastodonContextTarget('mastodon.social', '117197021556797850'))),
    { domain: 'mastodon.social', statusId: '117197021556797850', rootStatusId: '117197021556797850', storesCanonicalUri: false },
  )
})
