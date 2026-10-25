/**
 * Stable support codes.
 *
 * Learned from Code-Codex's `CC-START-CDP-014` style diagnostics: "no sound"
 * and "the panel is empty" are impossible to triage from prose alone, and a
 * code makes the report searchable, comparable between runs and safe to paste.
 *
 * The number never changes meaning once shipped; new failures get new numbers.
 * Every entry carries the one thing the user can do about it.
 */

export const CODES = Object.freeze({
  DATA_DIR_UNWRITABLE: 'AM-1001',
  LAYOUT_UNOWNED: 'AM-1002',
  CODEX_CLI_MISSING: 'AM-1101',
  MODEL_MISSING: 'AM-1201',
  RUNTIME_MISSING: 'AM-1202',
  RUNTIME_HASH_MISMATCH: 'AM-1203',
  SPEECH_INPUT_NOT_READY: 'AM-1301',
  SYSTEM_TTS_UNAVAILABLE: 'AM-1302',
  EDGE_TTS_UNREACHABLE: 'AM-1401',
  RING_SOUND_MISSING: 'AM-1501',
  DAEMON_POINTER_STALE: 'AM-1601',
  NOTIFY_HOOK_MISSING: 'AM-1602',
  PANEL_BROWSER_MISSING: 'AM-1701',
  PANEL_NATIVE_MISSING: 'AM-1702',
})

/** Titles/actions are data, not UI copy: they are shown by `amadeus doctor`. */
export const CODE_NOTES = Object.freeze({
  [CODES.DATA_DIR_UNWRITABLE]: 'the data directory cannot be written',
  [CODES.LAYOUT_UNOWNED]: 'the data directory is missing its ownership marker',
  [CODES.CODEX_CLI_MISSING]: 'the codex CLI was not found',
  [CODES.MODEL_MISSING]: 'the Live2D model is not installed',
  [CODES.RUNTIME_MISSING]: 'the Cubism 2 runtime is not installed',
  [CODES.RUNTIME_HASH_MISMATCH]: 'the Cubism 2 runtime does not match the pinned hash',
  [CODES.SPEECH_INPUT_NOT_READY]: 'voice input has no usable channel',
  [CODES.SYSTEM_TTS_UNAVAILABLE]: 'system speech is switched on but unavailable',
  [CODES.EDGE_TTS_UNREACHABLE]: 'the built-in Edge voice cannot be reached',
  [CODES.RING_SOUND_MISSING]: 'no incoming-call ring sound is available',
  [CODES.DAEMON_POINTER_STALE]: 'daemon.json pointed at a process that is gone',
  [CODES.NOTIFY_HOOK_MISSING]: 'the notify hook is not installed in Codex config',
  [CODES.PANEL_BROWSER_MISSING]: 'no Edge/Chrome executable was found for the panel',
  [CODES.PANEL_NATIVE_MISSING]: 'the native Qt/OpenGL panel is not installed',
})

/** One degrade entry shape everywhere: code + capability + reason + action. */
export function degrade(code, { capability, reason, action }) {
  return { code, capability, reason, action, note: CODE_NOTES[code] || '' }
}
