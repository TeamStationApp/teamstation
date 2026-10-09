import { AccessibilityInfo, Platform } from 'react-native'

/** Android uses its live region; iOS needs an explicit queued announcement. */
export function announceChatArrival(text: string): void {
  if (Platform.OS === 'ios')
    AccessibilityInfo.announceForAccessibilityWithOptions(text, {
      queue: true,
      priority: 'low'
    })
}
