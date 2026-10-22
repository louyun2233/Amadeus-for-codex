/**
 * Presentational modules for the panel.
 *
 * Each factory owns its own DOM subtree and exposes a small imperative API;
 * none of them touch transport state directly, so a view can be replaced
 * without touching the boot logic.
 */

const $ = (id) => document.getElementById(id)

export function fmtTime(t) {
  const d = new Date(t || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ------------------------------------------------------------------ chat view

export function createChatView({ onSend, onCancel, onToggleMic }) {
  const host = $('history')
  const input = $('input')
  const sendBtn = $('send')
  const sendIcon = sendBtn.innerHTML
  const micBtn = $('mic')
  let streamBubble = null
  let streamText = ''
  let busy = false

  function bubble(role, text, extra = {}) {
    const empty = host.querySelector('.empty')
    if (empty) empty.remove()
    const wrap = document.createElement('div')
    wrap.className = `msg ${role === 'user' ? 'user' : role === 'system' ? 'system' : 'amadeus'}`
    const el = document.createElement('div')
    el.className = 'bubble' + (extra.error ? ' error' : '')
    el.textContent = text
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = fmtTime(extra.ts)
    el.appendChild(time)
    wrap.appendChild(el)
    host.appendChild(wrap)
    host.scrollTop = host.scrollHeight
    return el
  }

  function setBody(el, text) {
    // the body is the first text node; the timestamp span must survive
    if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.nodeValue = text
    else el.insertBefore(document.createTextNode(text), el.firstChild)
  }

  return {
    renderHistory(messages) {
      host.innerHTML = ''
      if (!messages || messages.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'empty'
        empty.textContent = '—— 还没有聊天记录，和她说句话吧 ——'
        host.appendChild(empty)
        return
      }
      for (const m of messages) bubble(m.role, m.zh || m.ja || '', { ts: m.ts })
    },
    addUser: (text) => bubble('user', text),
    addSystem: (text) => bubble('system', text),
    addAssistant: (text, extra) => bubble('amadeus', text, extra),
    /** A message committed by the daemon (this tab or another one). */
    appendMessage(entry) {
      if (!entry) return
      const text = entry.zh || entry.ja || ''
      if (!text) return
      bubble(entry.role === 'user' ? 'user' : 'amadeus', text, { ts: entry.ts })
    },
    beginStream() {
      streamBubble = bubble('amadeus', '正在连接…')
      streamText = ''
      return streamBubble
    },
    setWaitStatus(text) {
      if (streamBubble && !streamText) setBody(streamBubble, text)
    },
    appendStream(delta) {
      if (!streamBubble) return
      streamText += delta
      setBody(streamBubble, streamText)
      host.scrollTop = host.scrollHeight
    },
    finishStream(text, { error = false } = {}) {
      if (!streamBubble) return
      if (error) streamBubble.classList.add('error')
      setBody(streamBubble, text)
      streamBubble = null
      streamText = ''
      host.scrollTop = host.scrollHeight
    },
    get streaming() {
      return Boolean(streamBubble)
    },
    setBusy(on) {
      busy = on
      sendBtn.innerHTML = on ? '&times;' : sendIcon
      sendBtn.title = on ? '取消回复' : '发送'
      sendBtn.setAttribute('aria-label', sendBtn.title)
      sendBtn.classList.toggle('danger', on)
      input.disabled = on
    },
    setMicActive(on) {
      micBtn.classList.toggle('active', on)
    },
    clearInput() {
      input.value = ''
    },
    value: () => input.value,
    mount() {
      sendBtn.addEventListener('click', () => (busy ? onCancel() : onSend()))
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          onSend()
        }
      })
      micBtn.addEventListener('click', onToggleMic)
    },
  }
}

// -------------------------------------------------------------- memory view

export function createMemoryView({ api, report }) {
  const host = $('memory-list')

  async function refresh() {
    host.innerHTML = ''
    let data
    try {
      data = await api('/amadeus/memory?limit=80')
    } catch (e) {
      host.innerHTML = `<div class="empty">读取失败：${e.message}</div>`
      return
    }
    const entries = data.entries || []
    if (entries.length === 0) {
      host.innerHTML = '<div class="empty">还没有记忆。</div>'
      return
    }
    for (const m of entries) {
      const row = document.createElement('div')
      row.className = 'mem-item'
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = m.content
      const meta = document.createElement('div')
      meta.className = 'meta'
      // provenance comes from the daemon (core renders the wording) so "where
      // did she learn this" is auditable right here
      meta.textContent = `${m.namespace || ''} · ${m.type || 'fact'} · ${m.provenance || fmtTime(m.ts)}`
      body.appendChild(meta)
      const del = document.createElement('button')
      del.className = 'icon-btn danger'
      del.title = '删除这条记忆'
      del.textContent = '×'
      del.addEventListener('click', async () => {
        del.disabled = true
        try {
          await api(`/amadeus/memory?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
          await refresh()
        } catch (e) {
          del.disabled = false
          report('error', '删除记忆失败', e.message, 'memory')
          meta.textContent = `删除失败：${e.message}`
        }
      })
      row.append(body, del)
      host.appendChild(row)
    }
  }

  async function exportAll() {
    try {
      const data = await api('/amadeus/memory/export')
      const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'amadeus-memory.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (e) {
      report('error', '导出记忆失败', e.message, 'memory')
    }
  }

  async function clearPanel() {
    if (!window.confirm('清空面板记忆？此操作不可撤销。')) return
    try {
      await api('/amadeus/memory/clear', { method: 'POST', body: { namespace: 'panel' } })
      await refresh()
    } catch (e) {
      report('error', '清空记忆失败', e.message, 'memory')
    }
  }

  return {
    mount() {
      $('mem-export').addEventListener('click', exportAll)
      $('mem-clear').addEventListener('click', clearPanel)
    },
    refresh,
  }
}

// ------------------------------------------------------------ settings view

// The voice list is 默认 + 导入 only: no curated speaker menu, because a fixed
// menu inevitably ships speakers nobody asked for. Anything a user wants comes
// in through the import form below (an online voice id, or a voice installed
// in Windows).
const IMPORT_OPTION = '__import__'
const DEFAULT_VOICE_ID = 'ja-JP-NanamiNeural'

export function createSettingsView({
  api,
  report,
  onConfigChanged,
  getAssetStatus,
  onInstallAssets,
  onReloadAvatar,
  getSecrets,
  onSecretsChanged,
  getVoices,
  onVoicesChanged,
  onOpenGuide,
}) {
  const host = $('settings')
  // Each entry knows how to push the current config into its own control, so a
  // config change updates values in place instead of rebuilding the DOM and
  // stealing focus / scroll position from the user.
  const syncers = []
  let assetDescEl = null
  let assetBtnEl = null
  let built = false

  function row(label, desc, control, sync) {
    const wrap = document.createElement('div')
    wrap.className = 'row'
    const left = document.createElement('div')
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    left.appendChild(l)
    if (desc) {
      // `desc` is usually copy, but a row may need a live hint that is rewritten
      // in place (the credential row), so an existing element is accepted as-is.
      const d = typeof desc === 'string' ? document.createElement('div') : desc
      if (typeof desc === 'string') {
        d.className = 'desc'
        d.textContent = desc
      } else if (!d.className) {
        d.className = 'desc'
      }
      left.appendChild(d)
    }
    wrap.append(left, control)
    if (sync) syncers.push(sync)
    return wrap
  }

  function checkbox(get, set) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.addEventListener('change', () => set(el.checked))
    return [el, () => { el.checked = Boolean(get()) }]
  }

  function select(get, options, set) {
    const el = document.createElement('select')
    for (const [value, text] of options) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = text
      el.appendChild(opt)
    }
    el.addEventListener('change', () => set(el.value))
    return [
      el,
      () => {
        const current = String(get() ?? '')
        // A value outside the list (hand-edited config, older version) must
        // still be visible: a blank control looks like a broken setting.
        if (current && ![...el.options].some((o) => o.value === current)) {
          const opt = document.createElement('option')
          opt.value = current
          opt.textContent = current
          el.appendChild(opt)
        }
        el.value = current
      },
    ]
  }

  async function patch(p) {
    try {
      const res = await api('/amadeus/config', { method: 'PATCH', body: { patch: p } })
      if (res.rejected && res.rejected.length) {
        report('warn', '配置被拒绝', res.rejected.join(','), 'settings')
      }
      onConfigChanged(res.config)
    } catch (e) {
      report('error', '保存配置失败', e.message, 'settings')
    }
  }

  function build() {
    host.innerHTML = ''
    syncers.length = 0
    const cfg = () => window.__amadeusConfig || {}

    const [voiceOn, syncVoiceOn] = checkbox(
      () => cfg().voice?.enabled !== false,
      (v) => patch({ voice: { enabled: v } }),
    )
    host.appendChild(row('语音朗读', '面板打开时朗读 Amadeus 的回复', voiceOn, syncVoiceOn))

    // 音色 = 默认 + 导入。The select is rebuilt from the daemon's list so an
    // imported voice shows up immediately after the import round-trip.
    const voiceCatalog = () =>
      getVoices() || { default: { id: DEFAULT_VOICE_ID, label: '默认' }, custom: [], system: [] }
    const voiceSelect = document.createElement('select')
    voiceSelect.setAttribute('aria-label', '音色')
    const selectedVoice = () => cfg().voice?.name || voiceCatalog().default.id

    const importBox = document.createElement('div')
    importBox.className = 'row'
    importBox.style.display = 'none'
    importBox.style.flexDirection = 'column'
    importBox.style.alignItems = 'stretch'
    const importLeft = document.createElement('div')
    const importLabel = document.createElement('div')
    importLabel.className = 'label'
    importLabel.textContent = '导入音色'
    const importDesc = document.createElement('div')
    importDesc.className = 'desc'
    importDesc.textContent = '选择音色来源，再填写对应的音色 ID'
    importLeft.append(importLabel, importDesc)

    const importRight = document.createElement('div')
    importRight.style.display = 'flex'
    importRight.style.flexDirection = 'column'
    importRight.style.gap = '4px'
    importRight.style.alignItems = 'stretch'
    importRight.style.width = '100%'
    importRight.style.minWidth = '0'
    const importProvider = document.createElement('select')
    importProvider.setAttribute('aria-label', '音色来源')
    for (const [id, label] of [
      ['edge', 'Edge 在线音色'],
      ['dashscope', '阿里云已复刻音色'],
      ['qwen-local', '本地 Qwen 克隆音色'],
      ['system', '本机语音'],
    ]) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = label
      importProvider.appendChild(option)
    }
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.setAttribute('aria-label', '音色名称')
    nameInput.placeholder = '名称（可选）'
    nameInput.style.maxWidth = '100%'
    const idInput = document.createElement('input')
    idInput.type = 'text'
    idInput.setAttribute('aria-label', '音色 ID')
    idInput.placeholder = 'ja-JP-MayuNeural'
    idInput.style.maxWidth = '100%'
    const systemSelect = document.createElement('select')
    systemSelect.setAttribute('aria-label', '本机语音')
    const addBtn = document.createElement('button')
    addBtn.className = 'btn-ghost'
    addBtn.textContent = '添加'
    const removeBtn = document.createElement('button')
    removeBtn.className = 'btn-ghost'
    removeBtn.textContent = '移除当前'
    const importButtons = document.createElement('div')
    importButtons.style.display = 'flex'
    importButtons.style.gap = '6px'
    importButtons.append(addBtn, removeBtn)
    importRight.append(importProvider, nameInput, idInput, systemSelect, importButtons)
    importBox.append(importLeft, importRight)

    let systemLoaded = false
    function loadSystemVoices() {
      if (systemLoaded) return
      systemLoaded = true
      api('/amadeus/voices?system=1')
        .then((data) => {
          systemSelect.innerHTML = ''
          const hint = document.createElement('option')
          hint.value = ''
          hint.textContent = data.system.length ? '本机语音…' : '本机没有可导入的语音'
          systemSelect.appendChild(hint)
          for (const v of data.system || []) {
            const opt = document.createElement('option')
            opt.value = v.id
            opt.textContent = `${v.label}${v.culture ? '（' + v.culture + '）' : ''}`
            systemSelect.appendChild(opt)
          }
          systemSelect.style.maxWidth = '150px'
        })
        .catch(() => {
          systemLoaded = false
        })
    }

    function syncImportProvider() {
      const kind = importProvider.value
      systemSelect.hidden = kind !== 'system'
      idInput.placeholder = kind === 'dashscope' ? '复刻返回的音色 ID' :
        kind === 'qwen-local' ? '本地注册的音色名称' :
        kind === 'system' ? '本机语音名称' : 'ja-JP-MayuNeural'
      importDesc.textContent = kind === 'dashscope'
        ? '音频样本不能直接导入；先在原版应用或百炼完成声音复刻，再填返回的 ID'
        : kind === 'qwen-local'
          ? '在本机 Qwen TTS WebUI 注册参考音频后，填写音色名称；服务监听 127.0.0.1:7860'
          : '选择音色来源，再填写对应的音色 ID'
      if (kind === 'system') loadSystemVoices()
    }

    function showImport(show) {
      importBox.style.display = show ? 'flex' : 'none'
      if (show) {
        importProvider.value = ['dashscope', 'qwen-local'].includes(cfg().voice?.provider)
          ? cfg().voice.provider : 'edge'
        syncImportProvider()
      }
    }

    importProvider.addEventListener('change', syncImportProvider)

    function renderVoiceSelect() {
      const catalog = voiceCatalog()
      const current = selectedVoice()
      voiceSelect.innerHTML = ''
      const add = (value, text) => {
        const opt = document.createElement('option')
        opt.value = value
        opt.textContent = text
        voiceSelect.appendChild(opt)
      }
      add(
        catalog.default?.id || DEFAULT_VOICE_ID,
        catalog.default?.provider === 'dashscope' ? '默认（阿里云）' : '默认',
      )
      for (const v of catalog.custom || []) {
        add(v.id, v.provider === 'system' ? `${v.label}（本机）` :
          v.provider === 'dashscope' ? `${v.label}（阿里云）` :
            v.provider === 'qwen-local' ? `${v.label}（本地克隆）` : v.label)
      }
      if (current !== (catalog.default?.id || DEFAULT_VOICE_ID) &&
          !(catalog.custom || []).some((v) => v.id === current)) {
        add(current, current)
      }
      add(IMPORT_OPTION, '＋ 导入…')
      voiceSelect.value = current
      removeBtn.disabled = !(catalog.custom || []).some((v) => v.id === current)
      if (voiceSelect.value !== current) voiceSelect.value = catalog.default?.id || DEFAULT_VOICE_ID
    }

    voiceSelect.addEventListener('change', async () => {
      const value = voiceSelect.value
      if (value === IMPORT_OPTION) {
        showImport(true)
        return
      }
      showImport(false)
      const imported = (voiceCatalog().custom || []).find((v) => v.id === value)
      const next = { name: value }
      if (value === voiceCatalog().default?.id && voiceCatalog().default?.provider === 'dashscope') {
        next.provider = 'dashscope'
        next.dashscopeModel = 'qwen3-tts-flash'
      } else if (imported?.provider === 'dashscope') {
        next.provider = 'dashscope'
        next.dashscopeModel = 'qwen3-tts-vc-2026-01-22'
      } else if (imported?.provider === 'qwen-local') {
        next.provider = 'qwen-local'
      } else {
        next.provider = 'edge'
      }
      await patch({ voice: next })
    })

    systemSelect.addEventListener('change', () => {
      if (!systemSelect.value) return
      idInput.value = systemSelect.value
      if (!nameInput.value) nameInput.value = systemSelect.value
    })

    addBtn.addEventListener('click', async () => {
      const id = idInput.value.trim()
      if (!id) {
        report('warn', '导入音色', '请填写语音 ID，或从「本机语音」里选一个', 'settings')
        return
      }
      addBtn.disabled = true
      try {
        const provider = importProvider.value
        await api('/amadeus/voices/import', {
          method: 'POST',
          body: { id, label: nameInput.value.trim(), provider },
        })
        await onVoicesChanged()
        await patch({ voice: provider === 'dashscope'
          ? { name: id, provider: 'dashscope', dashscopeModel: 'qwen3-tts-vc-2026-01-22' }
          : { name: id, provider: provider === 'qwen-local' ? 'qwen-local' : 'edge' } })
        nameInput.value = ''
        idInput.value = ''
        systemSelect.value = ''
        showImport(false)
      } catch (e) {
        report('error', '导入音色失败', e.message, 'settings')
      } finally {
        addBtn.disabled = false
        renderVoiceSelect()
      }
    })

    removeBtn.addEventListener('click', async () => {
      const current = selectedVoice()
      removeBtn.disabled = true
      try {
        await api('/amadeus/voices/remove', { method: 'POST', body: { id: current } })
        await onVoicesChanged()
      } catch (e) {
        report('error', '移除音色失败', e.message, 'settings')
      } finally {
        renderVoiceSelect()
      }
    })

    host.appendChild(row('音色', '默认音色，或导入你自己的', voiceSelect, renderVoiceSelect))
    host.appendChild(importBox)

    const [intensity, syncIntensity] = select(
      () => String(cfg().voice?.emotionIntensity ?? 1),
      [['0.5', '0.5 克制'], ['0.75', '0.75'], ['1', '1.0 默认'], ['1.2', '1.2'], ['1.5', '1.5 夸张']],
      (v) => patch({ voice: { emotionIntensity: Number(v) } }),
    )
    host.appendChild(row('情绪强度', '放大或收敛情绪语调', intensity, syncIntensity))

    const [stableVoice, syncStableVoice] = checkbox(
      () => cfg().voice?.stability !== false,
      (v) => patch({ voice: { stability: v } }),
    )
    host.appendChild(row('保持音色一致', '语音服务失败时提示错误，不临时换成另一种声线', stableVoice, syncStableVoice))

    const [ringOn, syncRingOn] = checkbox(
      () => cfg().voice?.ringEnabled !== false,
      (v) => patch({ voice: { ringEnabled: v } }),
    )
    host.appendChild(row('来电铃声', '来电时先响提示音，接听后她才开口', ringOn, syncRingOn))

    const [ringVolume, syncRingVolume] = select(
      () => String(cfg().voice?.ringVolume ?? 0.7),
      [['0.3', '轻'], ['0.5', '中'], ['0.7', '默认'], ['1', '响']],
      (v) => patch({ voice: { ringVolume: Number(v) } }),
    )
    host.appendChild(row('铃声音量', '提示音的响度，不影响朗读音量', ringVolume, syncRingVolume))

    const [speechProvider, syncSpeechProvider] = select(
      () => cfg().speechInput?.provider,
      [
        ['browser', '浏览器（免密）'],
        ['api', '独立语音 API'],
        ['none', '关闭'],
      ],
      (v) => patch({ speechInput: { provider: v } }),
    )
    host.appendChild(
      row('语音输入', '浏览器免密，API 需要语音密钥', speechProvider, syncSpeechProvider),
    )

    const [provider, syncProvider] = select(
      () => cfg().chat?.provider,
      [['codex-exec', 'Codex（默认）'], ['openai-compat', '独立 OpenAI 兼容 API']],
      (v) => patch({ chat: { provider: v } }),
    )
    host.appendChild(row('对话模型通道', 'codex-exec 复用 Codex 登录，零额外 key', provider, syncProvider))

    /**
     * Credential entry. Write-only by construction: the field is never filled
     * from the daemon, and the daemon only ever reports "configured or not".
     */
    function credentialRow({ label, secret, emptyHint }) {
      const hint = document.createElement('div')
      hint.className = 'desc'
      const input = document.createElement('input')
      input.type = 'password'
      input.placeholder = 'sk-…'
      input.autocomplete = 'off'
      // The row is a flex line: let the field shrink and the button keep its
      // width, otherwise the placeholder is clipped and 保存 wraps.
      input.style.flex = '1 1 auto'
      input.style.minWidth = '0'
      const save = document.createElement('button')
      save.className = 'btn-ghost'
      save.textContent = '保存'
      save.style.flex = '0 0 auto'
      save.style.whiteSpace = 'nowrap'
      save.addEventListener('click', async () => {
        const value = input.value.trim()
        if (!value) return
        save.disabled = true
        try {
          await api('/amadeus/secrets', { method: 'POST', body: { name: secret, value } })
          input.value = ''
          onSecretsChanged()
        } catch (e) {
          report('error', '保存密钥失败', e.message, 'settings')
        } finally {
          save.disabled = false
        }
      })
      const control = document.createElement('div')
      control.style.display = 'flex'
      control.style.alignItems = 'center'
      control.style.gap = '6px'
      control.style.flex = '1 1 auto'
      control.style.minWidth = '0'
      control.style.maxWidth = '210px'
      control.append(input, save)
      return row(label, hint, control, () => {
        const info = (getSecrets() || {})[secret] || {}
        hint.textContent = info.configured
          ? `已设置（${info.source === 'env' ? '环境变量 ' + (info.envVar || '') : '本机加密存储'}）`
          : emptyHint
      })
    }

    host.appendChild(
      credentialRow({
        label: 'API Key',
        secret: 'chatApiKey',
        emptyHint: '未设置（仅独立 API 需要）',
      }),
    )
    host.appendChild(
      credentialRow({
        label: '语音密钥',
        secret: 'ttsApiKey',
        emptyHint: '未设置（阿里云百炼，默认音色需要）',
      }),
    )

    const [oneshot, syncOneshot] = select(
      () => String(cfg().chat?.oneshot !== false),
      [
        ['true', '单句（默认）'],
        ['false', '连续对话'],
      ],
      (v) => patch({ chat: { oneshot: v === 'true' } }),
    )
    host.appendChild(
      row('对话模式', '单句：回一句就断开，下次从零开始', oneshot, syncOneshot),
    )

    const [sayAuth, syncSay] = checkbox(
      () => cfg().permissions?.preauthorizeSay === true,
      (v) => patch({ permissions: { preauthorizeSay: v } }),
    )
    host.appendChild(row('允许模型主动发声', 'amadeus_say 工具需要预先授权', sayAuth, syncSay))

    const [callAuth, syncCall] = checkbox(
      () => cfg().permissions?.preauthorizeCall === true,
      (v) => patch({ permissions: { preauthorizeCall: v } }),
    )
    host.appendChild(row('允许模型触发来电', 'amadeus_call 工具需要预先授权', callAuth, syncCall))

    const [broadcast, syncBroadcast] = checkbox(
      () => cfg().broadcast?.enabled === true,
      (v) => patch({ broadcast: { enabled: v } }),
    )
    host.appendChild(row('任务完成播报', '任务开始/完成语音的总开关，默认关闭', broadcast, syncBroadcast))

    const [taskStart, syncTaskStart] = checkbox(
      () => cfg().broadcast?.onTaskStart === true,
      (v) => patch({ broadcast: { onTaskStart: v } }),
    )
    host.appendChild(row('任务开始互动', '任务一开始她就应一声，桌面端与 CLI 都算', taskStart, syncTaskStart))

    const [systemTts, syncSystemTtsValue] = checkbox(
      () => cfg().broadcast?.systemTts === true,
      (v) => patch({ broadcast: { systemTts: v } }),
    )
    const syncSystemTts = () => {
      syncSystemTtsValue()
      systemTts.disabled = cfg().voice?.provider === 'qwen-local'
      if (systemTts.disabled) systemTts.checked = false
    }
    host.appendChild(
      row('系统播报', '克隆模式禁用系统音色；面板打开时仍用克隆音色播报', systemTts, syncSystemTts),
    )

    const [memoryOn, syncMemoryOn] = checkbox(
      () => cfg().memory?.enabled === true,
      (v) => patch({ memory: { enabled: v } }),
    )
    host.appendChild(
      row('长期记忆', '允许保存和回忆长期事实；自动抽取需另行开启，默认关闭', memoryOn, syncMemoryOn),
    )

    const [autoExtract, syncAutoExtract] = checkbox(
      () => cfg().memory?.autoExtract === true,
      (v) => patch({ memory: { autoExtract: v } }),
    )
    host.appendChild(row('自动抽取记忆', '仅在可能包含长期事实时抽取；闲聊不额外请求模型', autoExtract, syncAutoExtract))

    const [idleEnabled, syncIdleEnabled] = checkbox(
      () => cfg().proactive?.idleEnabled === true,
      (v) => patch({ proactive: { idleEnabled: v } }),
    )
    host.appendChild(row('空闲主动开口', '长时间没有互动时主动找话题，默认关闭', idleEnabled, syncIdleEnabled))

    const [callEnabled, syncCallEnabled] = checkbox(
      () => cfg().proactive?.callEnabled === true,
      (v) => patch({ proactive: { callEnabled: v } }),
    )
    host.appendChild(row('主动来电', '间隔一段时间主动来电，默认关闭', callEnabled, syncCallEnabled))

    const [idleMs, syncIdleMs] = select(
      () => String(cfg().proactive?.idleMs ?? 1200000),
      [['300000', '5 分钟'], ['600000', '10 分钟'], ['1200000', '20 分钟（默认）'], ['1800000', '30 分钟'], ['3600000', '60 分钟']],
      (v) => patch({ proactive: { idleMs: Number(v) } }),
    )
    host.appendChild(row('空闲多久开口', '长时间没互动时她主动找话题', idleMs, syncIdleMs))

    const [callInterval, syncCallInterval] = select(
      () => String(cfg().proactive?.callIntervalMs ?? 36000000),
      [['7200000', '2 小时'], ['21600000', '6 小时'], ['36000000', '10 小时（默认）'], ['86400000', '24 小时']],
      (v) => patch({ proactive: { callIntervalMs: Number(v) } }),
    )
    host.appendChild(row('来电间隔', '她像原作一样主动打电话给你', callInterval, syncCallInterval))

    assetDescEl = document.createElement('div')
    assetDescEl.className = 'desc'
    assetBtnEl = document.createElement('button')
    assetBtnEl.className = 'btn-ghost'
    assetBtnEl.addEventListener('click', async () => {
      assetBtnEl.disabled = true
      assetBtnEl.textContent = '处理中…'
      try {
        await onInstallAssets()
        onReloadAvatar()
      } catch (e) {
        report('error', '素材操作失败', e.message, 'settings')
      } finally {
        assetBtnEl.disabled = false
        sync()
      }
    })
    host.appendChild(row('Live2D 素材', assetDescEl, assetBtnEl))

    // Closes the last dangling seam: the hub's `clear` action existed but had no
    // caller, and the panel listened for `cleared` without ever triggering it.
    const clearSpeechBtn = document.createElement('button')
    clearSpeechBtn.className = 'btn-ghost'
    clearSpeechBtn.textContent = '清空'
    clearSpeechBtn.addEventListener('click', async () => {
      clearSpeechBtn.disabled = true
      try {
        await api('/amadeus/action', { method: 'POST', body: { cmd: 'clear' } })
      } catch (e) {
        report('error', '清空语音队列失败', e.message, 'settings')
      } finally {
        clearSpeechBtn.disabled = false
      }
    })
    host.appendChild(row('清空语音队列', '立即停止排队与正在播放的语音', clearSpeechBtn))

    const guideBtn = document.createElement('button')
    guideBtn.className = 'btn-ghost'
    guideBtn.textContent = '查看'
    guideBtn.addEventListener('click', () => onOpenGuide?.())
    host.appendChild(row('使用引导', '重看数据去向和功能开关说明', guideBtn))

    built = true
    sync()
  }

  function sync() {
    if (!built) return
    for (const fn of syncers) {
      try {
        fn()
      } catch (e) {
        report('error', '设置同步失败', e.message, 'settings')
      }
    }
    const status = getAssetStatus()
    const model = status?.packs?.find((p) => p.kind === 'model')
    const runtime = status?.packs?.find((p) => p.kind === 'runtime')
    if (assetDescEl) {
      assetDescEl.textContent = !status
        ? '读取中…'
        : model?.installed
          ? runtime?.installed
            ? runtime.matches
              ? `已安装 · 版本 ${model.version}`
              : '运行时哈希不匹配'
            : '缺少 Cubism 2 运行时'
          : '未安装（约 8.6 MB，按需下载）'
    }
    if (assetBtnEl) assetBtnEl.textContent = model?.installed ? '重新校验' : '安装'
  }

  function setConfig(cfg) {
    window.__amadeusConfig = cfg || {}
    sync()
  }

  return {
    mount: build,
    setConfig,
    sync,
  }
}

// ---------------------------------------------------------------- diag view

export function createDiagView({ api, report }) {
  const out = $('diag-out')

  async function run() {
    out.textContent = '检测中…'
    try {
      const data = await api('/amadeus/diag?deep=1')
      const lines = []
      lines.push(`整体: ${data.ok ? '可用' : '有降级项'}`)
      lines.push(`Node: ${data.checks.node?.version ?? '?'}`)
      lines.push(`数据目录: ${data.checks.dataDir?.ok ? '可写' : '不可写'}  ${data.checks.dataDir?.path ?? ''}`)
      lines.push(`codex CLI: ${data.checks.codexCli?.ok ? data.checks.codexCli.path : '未找到'}`)
      lines.push(`Live2D 模型: ${data.checks.live2dModel?.ok ? '已安装' : '未安装（面板显示占位图）'}`)
      lines.push(
        `Cubism 2 运行时: ${data.checks.live2dRuntime?.ok ? '已安装且哈希匹配' : '缺失或哈希不符'}`,
      )
      if (data.checks.edgeTts) {
        lines.push(
          `Edge TTS: ${data.checks.edgeTts.ok ? `正常 ${data.checks.edgeTts.bytes} bytes` : `失败 ${data.checks.edgeTts.reason}`}`,
        )
      }
      if (data.checks.speechInput?.provider) {
        const s = data.checks.speechInput
        lines.push(
          `语音输入: ${s.provider}${s.ready ? '' : ' 未就绪'}${s.reason ? ' · ' + s.reason : ''}`,
        )
      }
      if (data.checks.systemTts) {
        const s = data.checks.systemTts
        lines.push(`系统播报: ${s.available ? s.backend : '不可用（面板播报仍然可用）'}`)
      }
      try {
        const p = await api('/amadeus/proactive')
        lines.push(
          `主动交互: ${p.callEnabled ? '来电开' : '来电关'} / ${p.idleEnabled ? '空闲开' : '空闲关'} · 面板连接 ${p.clients} · 已来电 ${p.callCount}`,
        )
        if (p.inFlight) lines.push('  (正在生成主动台词)')
      } catch {
        /* scheduler status is optional */
      }
      if (data.degrade?.length) {
        lines.push('', '降级项:')
        for (const d of data.degrade) lines.push(` · [${d.capability}] ${d.reason} → ${d.action}`)
      }
      try {
        const logs = await api('/amadeus/logs?limit=10')
        if (logs.client?.length) {
          lines.push('', '最近的客户端错误:')
          for (const l of logs.client.slice(-6)) lines.push(` · ${l.level} ${l.message} ${l.where || ''}`)
        }
      } catch {
        /* logs are optional */
      }
      out.textContent = lines.join('\n')
    } catch (e) {
      report('error', '自检失败', e.message, 'diag')
      out.textContent = `自检失败：${e.message}`
    }
  }

  return {
    mount() {
      $('diag-run').addEventListener('click', run)
    },
    run,
  }
}
