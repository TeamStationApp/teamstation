export type NavTabId = 'home' | 'videos' | 'schedule' | 'search' | 'chat'

export function navTabId(id: NavTabId): string {
  return `tab-${id}`
}

export const NAV_TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'videos', label: 'Videos', icon: 'smart_display' },
  { id: 'schedule', label: 'Schedule', icon: 'event' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'chat', label: 'Chat', icon: 'chat' }
] as const satisfies ReadonlyArray<{
  id: NavTabId
  label: string
  icon: string
}>
