export type NavTabId = 'home' | 'videos' | 'schedule' | 'search' | 'chat'

export function navTabId(id: NavTabId): string {
  return `tab-${id}`
}
