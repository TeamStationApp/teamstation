// iOS keeps the app active while Safari covers the conversation.
let visible = false
const listeners = new Set<() => void>()

export function chatBrowserVisible(): boolean {
  return visible
}

export function watchChatBrowser(update: () => void): () => void {
  listeners.add(update)
  return () => {
    listeners.delete(update)
  }
}

function setVisible(value: boolean): void {
  visible = value
  for (const update of listeners) update()
}

/** A second tap shares the sheet already covering the chat. */
export async function whileChatBrowserOpen(
  open: () => Promise<void>
): Promise<void> {
  if (visible) return
  setVisible(true)
  try {
    await open()
  } finally {
    setVisible(false)
  }
}
