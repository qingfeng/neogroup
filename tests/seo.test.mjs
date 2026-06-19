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
    URL,
  }, { filename: sourcePath })
  return module.exports
}

test('buildCanonicalUrl strips noisy query and hash fragments', () => {
  const { buildCanonicalUrl } = loadModule('src/lib/seo.ts')

  assert.equal(buildCanonicalUrl('https://neogrp.club/group/board?utm_source=x#top'), 'https://neogrp.club/group/board')
  assert.equal(buildCanonicalUrl('http://neogrp.club/group/board'), 'https://neogrp.club/group/board')
  assert.equal(buildCanonicalUrl('http://localhost:8787/group/board'), 'http://localhost:8787/group/board')
  assert.equal(buildCanonicalUrl('https://neogrp.club/?source=random'), 'https://neogrp.club/')
})

test('escapeXml safely serializes sitemap values', () => {
  const { escapeXml } = loadModule('src/lib/seo.ts')

  assert.equal(escapeXml('https://example.com/group/a&b<"x">'), 'https://example.com/group/a&amp;b&lt;&quot;x&quot;&gt;')
})

test('buildSeoDescription returns plain text within search snippet length', () => {
  const { buildSeoDescription } = loadModule('src/lib/seo.ts')

  const description = buildSeoDescription('<p>Hello <strong>NeoGroup</strong><br>世界</p>', 'fallback', 18)
  assert.equal(description, 'Hello NeoGroup 世界')
  assert.equal(buildSeoDescription('', 'fallback'), 'fallback')
})

test('buildWebsiteJsonLd includes SearchAction for site search discovery', () => {
  const { buildWebsiteJsonLd } = loadModule('src/lib/seo.ts')

  assert.deepEqual(JSON.parse(JSON.stringify(buildWebsiteJsonLd('NeoGroup', 'https://neogrp.club'))), {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'NeoGroup',
    url: 'https://neogrp.club',
    description: 'NeoGroup 是一个去中心化小组讨论社区',
    potentialAction: {
      '@type': 'SearchAction',
      target: 'https://neogrp.club/search?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  })
})
