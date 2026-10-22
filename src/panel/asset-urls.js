/** Resolve both current and pre-character-module asset status responses. */
function basename(value) {
  return typeof value === 'string' ? value.split(/[\\/]/).filter(Boolean).at(-1) || '' : ''
}

export function modelAssetUrl(model) {
  const entry = model?.entryName || basename(model?.entry)
  if (!entry) return null
  const parts = entry.split(/[\\/]/)
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return '/amadeus/assets/current/' + parts.map(encodeURIComponent).join('/')
}

export function runtimeAssetUrl(runtime) {
  const target = runtime?.targetName || basename(runtime?.path)
  return target ? '/amadeus/assets/runtime/' + encodeURIComponent(target) : null
}
