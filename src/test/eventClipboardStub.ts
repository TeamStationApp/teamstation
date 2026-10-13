export const clipboardTest = { value: '', fail: false }
export default {
  setString(value: string): void {
    if (clipboardTest.fail) throw new Error('Clipboard unavailable')
    clipboardTest.value = value
    const clipboard = (
      globalThis as unknown as {
        navigator?: {
          clipboard?: { writeText: (text: string) => Promise<void> }
        }
      }
    ).navigator?.clipboard
    if (clipboard != null) clipboard.writeText(value).catch(() => undefined)
  }
}
