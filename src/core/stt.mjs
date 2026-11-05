/** Native recognition is owned by the Windows panel; the daemon never accepts recordings. */
export class SttService {
  constructor({ config } = {}) { this.config = config }

  providerId() {
    return this.config?.getPath?.('speechInput.provider') === 'none' ? 'none' : 'windows-native'
  }

  describe() {
    const enabled = this.providerId() !== 'none'
    return {
      provider: this.providerId(), endpoint: 'Windows Speech Recognition',
      selfHosted: true, keyConfigured: false, ready: enabled,
      degrade: enabled ? null : 'mic-disabled',
      reason: enabled ? 'recognition runs in the native Windows panel' : 'speech input is switched off',
    }
  }

  isReady() { return this.describe().ready }
}
