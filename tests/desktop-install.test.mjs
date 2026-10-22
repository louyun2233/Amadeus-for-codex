import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config', 'dist-manifest.json'), 'utf8'))

test('desktop installation entry is included in the complete release', () => {
  assert.ok(manifest.requiredForInstall.includes('安装 Amadeus.cmd'))
  assert.ok(manifest.requiredForInstall.includes('scripts/desktop-install.ps1'))
  const command = fs.readFileSync(path.join(root, '安装 Amadeus.cmd'), 'utf8')
  assert.match(command, /%~dp0scripts\\desktop-install\.ps1/)
  assert.match(command, /if not exist "scripts\\desktop-install\.ps1"/)
  assert.match(command, /pause >nul/)
})

test('one-click setup reuses the checked installer and opens the panel', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/desktop-install.ps1'), 'utf8')
  assert.match(script, /install\.ps1/)
  assert.match(script, /-NoStart/)
  assert.match(script, /amadeus\.mjs start/)
  assert.match(script, /assets verify/)
  assert.match(script, /assets install/)
  assert.match(script, /amadeus\.mjs open/)
  assert.doesNotMatch(script, /qwen-tts-webui|qwen-service\.json/i)
})
