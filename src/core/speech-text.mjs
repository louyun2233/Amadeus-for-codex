/**
 * Text hygiene for the voice provider.
 *
 * Three things made lines sound broken rather than merely wrong:
 *   - markdown (`**`, backticks, `#`, list markers) was read out or produced
 *     long pauses,
 *   - emoji came back as "unknown symbol" or silence in the middle of a
 *     sentence, which reads as the audio cutting out,
 *   - links were spelled out character by character.
 *
 * The cache key is derived from this cleaned text, so the same sentence always
 * maps to the same audio file even when the model decorates it differently.
 */

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu

export function sanitizeForSpeech(input) {
  return String(input ?? '')
    .replace(/\r/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1') // keep a link's label, drop the URL
    .replace(/https?:\/\/\S+/gi, '')
    .replace(EMOJI, '')
    .replace(/[*_`~#>|]+/g, '')
    .replace(/^[\s\-–—•]+/gm, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
