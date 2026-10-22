import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Codex plugin marketplace entry.
 *
 * `.agents/plugins/marketplace.json` is read by `codex plugin marketplace add`
 * and `codex plugin list`; the enums below are not guesses - the CLI rejects
 * anything outside them ("unknown variant `NONE`, expected `ON_INSTALL` or
 * `ON_USE`"), and `tests/verify-install.ps1` exercises the real binary when it
 * is available. These tests keep the manifest and the plugin it points at from
 * drifting apart between releases.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'))
const plugin = JSON.parse(read('.codex-plugin/plugin.json'))
const pkg = JSON.parse(read('package.json'))

const INSTALL_POLICIES = ['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'HIDDEN']
const AUTH_POLICIES = ['ON_INSTALL', 'ON_USE']

test('the marketplace manifest has the shape the CLI reads', () => {
  assert.equal(typeof marketplace.name, 'string')
  assert.match(marketplace.name, /^[a-z0-9-]+$/)
  assert.equal(typeof marketplace.interface?.displayName, 'string')
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0)
})

test('every entry points at a plugin that exists and matches by name', () => {
  for (const entry of marketplace.plugins) {
    assert.equal(entry.source?.source, 'local', 'only local sources are shipped here')
    const dir = path.resolve(ROOT, entry.source.path)
    assert.ok(
      dir === ROOT || dir.startsWith(ROOT + path.sep),
      `${entry.source.path} escapes the repository`,
    )
    const manifestPath = path.join(dir, '.codex-plugin', 'plugin.json')
    assert.ok(fs.existsSync(manifestPath), `missing plugin manifest under ${entry.source.path}`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.name, entry.name, 'the entry name must match the plugin name')
    assert.equal(manifest.version, pkg.version, 'the plugin version must track package.json')
    assert.equal(manifest.interface?.category, entry.category, 'category must agree with the entry')
  }
})

test('policies stay inside the enums the CLI accepts', () => {
  for (const entry of marketplace.plugins) {
    assert.ok(
      INSTALL_POLICIES.includes(entry.policy?.installation),
      `installation policy ${entry.policy?.installation}`,
    )
    assert.ok(
      AUTH_POLICIES.includes(entry.policy?.authentication),
      `authentication policy ${entry.policy?.authentication}`,
    )
    assert.equal(typeof entry.category, 'string')
  }
})

test('the plugin manifest carries what the install UI needs', () => {
  for (const key of ['name', 'version', 'description', 'license']) {
    assert.equal(typeof plugin[key], 'string', `plugin.json needs ${key}`)
  }
  assert.equal(typeof plugin.author?.name, 'string')
  assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.length > 0)
  for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    assert.equal(typeof plugin.interface?.[key], 'string', `interface.${key} is shown to users`)
  }
  assert.ok(Array.isArray(plugin.interface.capabilities) && plugin.interface.capabilities.length > 0)
  assert.ok(Array.isArray(plugin.interface.defaultPrompt) && plugin.interface.defaultPrompt.length > 0)
  assert.match(plugin.interface.brandColor || '', /^#[0-9A-Fa-f]{6}$/)
})

test('the skills directory the manifest advertises exists and is populated', () => {
  assert.equal(plugin.skills, './skills/')
  const dir = path.join(ROOT, 'skills')
  assert.ok(fs.statSync(dir).isDirectory())
  const skills = fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, 'SKILL.md')))
  assert.ok(skills.length >= 3, `expected several skills, found ${skills.length}`)
})

test('the listing does not claim a repository this project does not have', () => {
  // Inventing a homepage/repository URL would misattribute the plugin and
  // mislead anyone who reads the marketplace card. Add them only alongside a
  // real public repo, and update this test in the same change.
  const urls = [
    plugin.homepage,
    plugin.repository,
    plugin.interface?.websiteURL,
    plugin.interface?.privacyPolicyURL,
    plugin.interface?.termsOfServiceURL,
  ].filter(Boolean)
  assert.deepEqual(urls, [], `remove these or point them at a real public page: ${urls.join(', ')}`)
})

test('the plugin does not advertise lifecycle hooks', () => {
  // The Codex build in use lists nothing on its /hooks page, so trusting a
  // plugin hook is not something to depend on: the panel is launched by the
  // Startup-folder watcher (bin/amadeus-watch.mjs) instead. If hooks are ever
  // re-adopted, this test is the place to say so.
  assert.equal(plugin.hooks, undefined)
  assert.equal(fs.existsSync(path.join(ROOT, 'hooks', 'hooks.json')), false)
})
