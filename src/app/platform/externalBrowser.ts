export async function openExternal(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer')
}
export async function resumeBrowser(url: string): Promise<void> {
  window.location.assign(url)
}
export const nativeBrowser = false
