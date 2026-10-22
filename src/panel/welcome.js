/** Wait for the selected local clone to synthesize the welcome line before queuing it. */
export async function speakWelcomeWhenReady({
  provider,
  prepare,
  speak,
  shouldCancel = () => false,
  onWaiting = () => {},
  onTimeout = () => {},
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = 360000,
  retryMs = 5000,
}) {
  if (provider === 'qwen-local') {
    const deadline = clock() + maxWaitMs
    let lastError = null
    while (true) {
      if (shouldCancel()) return 'cancelled'
      try {
        const result = await prepare()
        if (result?.ready) break
        lastError = new Error(result?.reason || 'local voice not ready')
      } catch (error) {
        lastError = error
      }
      if (shouldCancel()) return 'cancelled'
      if (clock() >= deadline) {
        onTimeout(lastError)
        return 'timeout'
      }
      onWaiting()
      await sleep(Math.min(retryMs, Math.max(1, deadline - clock())))
    }
  }
  if (shouldCancel()) return 'cancelled'
  await speak()
  return 'sent'
}
