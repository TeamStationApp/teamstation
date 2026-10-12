export const clipboardTest = { value: '', fail: false }
export default {
  setString(value: string): void {
    if (clipboardTest.fail) throw new Error('Clipboard unavailable')
    clipboardTest.value = value
  }
}
