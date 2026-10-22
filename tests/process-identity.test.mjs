import test from 'node:test'
import assert from 'node:assert/strict'
import { isOurPanelBrowser, killStalePanelBrowsers, PROFILE_FLAG } from '../src/host/panel-launcher.mjs'

/**
 * Learned from Code-Codex's process guard: never kill by "the command line
 * mentions this path".
 *
 * That exact shortcut killed a verification shell on this machine - its own
 * command line contained the profile directory because it was the one running
 * the kill. Identity is now: a browser image, *and* the profile passed as the
 * `--user-data-dir` argument.
 */

const PROFILE = 'C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\panel-profile'

test('a browser started on our profile is ours', () => {
  assert.equal(
    isOurPanelBrowser(
      { name: 'msedge.exe', commandLine: `"C:\\edge\\msedge.exe" --app=http://127.0.0.1:1/x ${PROFILE_FLAG}${PROFILE}` },
      PROFILE,
    ),
    true,
  )
  assert.equal(
    isOurPanelBrowser({ Name: 'chrome.exe', CommandLine: `chrome.exe "${PROFILE_FLAG}${PROFILE}"` }, PROFILE),
    true,
    'the PowerShell field names work too',
  )
})

test('a shell that merely mentions the path is not ours', () => {
  assert.equal(
    isOurPanelBrowser(
      {
        name: 'pwsh.exe',
        commandLine: `pwsh -Command "$targets = Get-CimInstance ... Contains('${PROFILE}')"`,
      },
      PROFILE,
    ),
    false,
    'this is the process that killed itself before the guard existed',
  )
})

test('a browser on a different profile is not ours', () => {
  assert.equal(
    isOurPanelBrowser(
      { name: 'msedge.exe', commandLine: `msedge.exe ${PROFILE_FLAG}C:\\Users\\ExampleUser\\AppData\\Local\\Amadeus\\panel-profile-old` },
      PROFILE,
    ),
    false,
  )
  assert.equal(
    isOurPanelBrowser({ name: 'msedge.exe', commandLine: `msedge.exe --user-data-dir=${PROFILE}` }, ''),
    false,
  )
})

test('only the matching processes are killed', () => {
  const killed = []
  const count = killStalePanelBrowsers(PROFILE, {
    platform: 'win32',
    query: () => [
      { Name: 'msedge.exe', ProcessId: 111, CommandLine: `msedge ${PROFILE_FLAG}${PROFILE}` },
      { Name: 'msedge.exe', ProcessId: 222, CommandLine: 'msedge --user-data-dir=C:\\other' },
      { Name: 'pwsh.exe', ProcessId: 333, CommandLine: `pwsh -Command "echo ${PROFILE}"` },
      { Name: 'chrome.exe', ProcessId: process.pid, CommandLine: `chrome ${PROFILE_FLAG}${PROFILE}` },
      { Name: 'msedge.exe', ProcessId: 111, CommandLine: `msedge ${PROFILE_FLAG}${PROFILE}` },
    ],
    kill: (pids) => {
      killed.push(...pids)
      return pids.length
    },
  })
  assert.deepEqual(killed, [111], 'deduplicated, and never our own process')
  assert.equal(count, 1)
})

test('a failed query or kill is reported as zero, never as an exception', () => {
  assert.equal(
    killStalePanelBrowsers(PROFILE, {
      platform: 'win32',
      query: () => {
        throw new Error('wmi exploded')
      },
    }),
    0,
  )
  assert.equal(
    killStalePanelBrowsers(PROFILE, {
      platform: 'win32',
      query: () => [{ Name: 'msedge.exe', ProcessId: 42, CommandLine: `msedge ${PROFILE_FLAG}${PROFILE}` }],
      kill: () => {
        throw new Error('access denied')
      },
    }),
    0,
  )
  assert.equal(killStalePanelBrowsers(PROFILE, { platform: 'darwin', query: () => [] }), 0)
  assert.equal(killStalePanelBrowsers('', { platform: 'win32', query: () => [] }), 0)
})
