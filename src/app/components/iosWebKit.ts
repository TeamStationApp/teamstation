/**
 * What a browser says of itself; the phone's build has no DOM types. React
 * Native defines a `navigator` too, with neither field.
 */
export interface BrowserNavigator {
  userAgent?: string
  maxTouchPoints?: number
}

/** The global navigator: a browser's, React Native's, or none. */
export function browserNavigator(): BrowserNavigator | undefined {
  return (globalThis as { navigator?: BrowserNavigator }).navigator
}

/**
 * Whether this browser is one on an iPhone, iPad or iPod: every one of them
 * is WebKit and presents form controls as Safari does. iPadOS asks for the
 * desktop site with a Mac's user agent, which only its touch screen tells
 * apart. False wherever no user agent is given, the app included.
 */
export function isIosWebKit(navigator: BrowserNavigator | undefined): boolean {
  const agent = navigator?.userAgent ?? ''
  return (
    /iPhone|iPad|iPod/.test(agent) ||
    (agent.includes('Macintosh') && (navigator?.maxTouchPoints ?? 0) > 1)
  )
}
