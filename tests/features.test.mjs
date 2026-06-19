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
    exports: module.exports,
    module,
    require,
  }, { filename: sourcePath })
  return module.exports
}

test('social payment features are disabled unless explicitly enabled', () => {
  const { isSocialPaymentEnabled } = loadModule('src/lib/features.ts')

  assert.equal(isSocialPaymentEnabled({}), false)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: '0' }), false)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: 'false' }), false)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: '1' }), true)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: 'true' }), true)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: 'on' }), true)
  assert.equal(isSocialPaymentEnabled({ SOCIAL_PAYMENTS_ENABLED: 'enabled' }), true)
})
