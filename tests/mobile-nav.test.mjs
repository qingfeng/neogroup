import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const css = readFileSync(resolve('public/static/css/style.css'), 'utf8')

function ruleFor(selector) {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  return match?.[1] || ''
}

test('mobile navigation menu participates in page flow when expanded', () => {
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.navbar\s*\{[\s\S]*?height:\s*auto[\s\S]*?min-height:\s*50px[\s\S]*?flex-wrap:\s*wrap/)
  const mobileMenuRule = ruleFor('.navbar .navbar-menu')
  assert.match(mobileMenuRule, /display:\s*none/)
  assert.match(mobileMenuRule, /position:\s*static/)
  assert.match(mobileMenuRule, /width:\s*100%/)
  assert.doesNotMatch(mobileMenuRule, /position:\s*absolute/)
})
