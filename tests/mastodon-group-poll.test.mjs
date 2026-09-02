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
  let source = readFileSync(sourcePath, 'utf8')
  source = source
    .replace(/^import .* from 'drizzle-orm'\n/m, '')
    .replace(/^import .* from '\.\.\/db'\n/m, '')
    .replace(/^import .* from '\.\.\/db\/schema'\n/m, '')
    .replace(/^import .* from '\.\.\/types'\n/m, '')
    .replace(/^import .* from '\.\/activitypub'\n/m, '')
    .replace(/^import .* from '\.\/mastodon-sync'\n/m, '')
    .replace(
      /import \{ generateId, stripHtml, truncate \} from '\.\.\/lib\/utils'\n/,
      'const stripHtml = (html) => html.replace(/<[^>]*>/g, "").replace(/\\s+/g, " ").trim(); const truncate = (text, max) => text.length > max ? text.slice(0, max - 1) + "…" : text;\n',
    )

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

test('parses Mastodon actor URIs for group mention polling', () => {
  const { parseMastodonActor } = loadModule('src/services/mastodon-group-poll.ts')

  assert.deepEqual(
    JSON.parse(JSON.stringify(parseMastodonActor('https://mastodon.social/users/asahi001'))),
    { domain: 'mastodon.social', acct: 'asahi001' },
  )
})

test('detects Mastodon mentions for a local group actor', () => {
  const { mentionsGroup, titleFromStatus } = loadModule('src/services/mastodon-group-poll.ts')

  const status = {
    mentions: [{ acct: 'board@neogrp.club', username: 'board', url: 'https://neogrp.club/group/AbjyyyMQgftC' }],
    content: '<p><span>@<span>board</span></span> 最近香港天气如何？</p>',
  }

  assert.equal(mentionsGroup(status, 'board', 'neogrp.club'), true)
  assert.equal(titleFromStatus(status.content), '最近香港天气如何？')
})
