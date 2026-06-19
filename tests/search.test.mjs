import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const sourcePath = resolve(root, 'src/lib/search.ts')
const require = createRequire(import.meta.url)

function loadSearchModule() {
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

test('normalizes site search queries for SQLite LIKE matching', () => {
  const { normalizeSearchQuery, toSearchLikePattern } = loadSearchModule()

  assert.equal(normalizeSearchQuery('  Lightning   支付  '), 'Lightning 支付')
  assert.equal(normalizeSearchQuery('a'.repeat(90)), 'a'.repeat(80))
  assert.equal(toSearchLikePattern('100%_match\\test'), '%100\\%\\_match\\\\test%')
  assert.equal(toSearchLikePattern('   '), null)
})
