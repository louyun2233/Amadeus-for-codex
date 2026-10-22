/** First-use guide. Completion is stored in the daemon config, not per browser port. */
const $ = (id) => document.getElementById(id)

export function createOnboarding({ api, getConfig, onConfigChanged }) {
  const dialog = $('onboarding')
  const intro = $('guide-intro')
  const choices = $('guide-choices')
  const error = $('guide-error')
  const ids = ['voice', 'broadcast', 'memory', 'extract', 'idle', 'call']
  const controls = Object.fromEntries(ids.map((id) => [id, $(`guide-${id}`)]))
  let busy = false
  let forcedOpen = false

  function setStep(step) {
    intro.hidden = step !== 1
    choices.hidden = step !== 2
    error.hidden = true
    const target = step === 1 ? $('guide-next') : $('guide-back')
    target.focus()
  }

  function syncDependencies() {
    controls.broadcast.disabled = !controls.voice.checked
    if (!controls.voice.checked) controls.broadcast.checked = false
    controls.extract.disabled = !controls.memory.checked
    if (!controls.memory.checked) controls.extract.checked = false
  }

  function open({ force = false } = {}) {
    const config = getConfig()
    if (!config || (!force && config.panel?.onboardingSeen === true)) return false
    if (dialog.open) return true
    forcedOpen = force
    controls.voice.checked = config.voice?.enabled === true
    controls.broadcast.checked = config.broadcast?.enabled === true
    controls.memory.checked = config.memory?.enabled === true
    controls.extract.checked = config.memory?.autoExtract === true
    controls.idle.checked = config.proactive?.idleEnabled === true
    controls.call.checked = config.proactive?.callEnabled === true
    syncDependencies()
    dialog.showModal()
    setStep(1)
    return true
  }

  async function save(patch) {
    if (busy) return
    busy = true
    error.hidden = true
    for (const button of dialog.querySelectorAll('button')) button.disabled = true
    try {
      const result = await api('/amadeus/config', { method: 'PATCH', body: { patch } })
      if (result.rejected?.length) throw new Error(`设置未保存：${result.rejected.join('、')}`)
      onConfigChanged(result.config)
      dialog.close()
    } catch (cause) {
      error.textContent = `保存失败：${cause.message}。请重试或稍后在设置中修改。`
      error.hidden = false
    } finally {
      busy = false
      for (const button of dialog.querySelectorAll('button')) button.disabled = false
    }
  }

  $('guide-next').addEventListener('click', () => setStep(2))
  $('guide-back').addEventListener('click', () => setStep(1))
  $('guide-skip').addEventListener('click', () => save({ panel: { onboardingSeen: true } }))
  $('guide-finish').addEventListener('click', () => save({
    panel: { onboardingSeen: true },
    voice: { enabled: controls.voice.checked },
    broadcast: { enabled: controls.voice.checked && controls.broadcast.checked },
    memory: { enabled: controls.memory.checked, autoExtract: controls.memory.checked && controls.extract.checked },
    proactive: { idleEnabled: controls.idle.checked, callEnabled: controls.call.checked },
  }))
  controls.voice.addEventListener('change', syncDependencies)
  controls.memory.addEventListener('change', syncDependencies)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    if (!busy) save({ panel: { onboardingSeen: true } })
  })

  return {
    open,
    showIfNeeded: () => open(),
    sync(config) {
      if (dialog.open && !forcedOpen && config?.panel?.onboardingSeen === true) dialog.close()
    },
  }
}
