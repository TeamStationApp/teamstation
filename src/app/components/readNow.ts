import { Platform } from 'react-native'
import { runOnUISync } from 'react-native-worklets'

/**
 * What `read` (a worklet) gives on the thread that runs the animations, read
 * there now. On a phone, a shared value an animation is moving on that
 * thread is not kept up to date on the JavaScript thread: its `.value` there
 * can be where the animation started. A browser has the one thread.
 */
export function readNow<T>(read: () => T): T {
  if (Platform.OS === 'web') return read()
  return runOnUISync(read)
}
