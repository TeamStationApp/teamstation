/** Start copying in the user gesture, and report denial instead of false success. */
export async function copyChatText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText != null) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Insecure origins and denied clipboard permissions may allow selection.
    }
  }
  const previous = document.activeElement
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  try {
    input.select()
    if (!document.execCommand?.('copy')) throw new Error('Copy unavailable')
  } finally {
    input.remove()
    if (previous instanceof HTMLElement && previous.isConnected)
      previous.focus()
  }
}
