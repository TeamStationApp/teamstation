import type { QueueStorage } from '../../common/observability/queue'

/**
 * Where the TV keeps its unsent analytics events: in memory, since the TV
 * has no AsyncStorage (its pod declares no tvOS) and the Keychain module is
 * the bearer session's alone. An event still queued when the app is killed is
 * lost; the queue flushes on its interval and on backgrounding, so that is at
 * most one interval of events. Each call is a store of its own.
 */
export function memoryQueueStorage(): QueueStorage {
  const kept = new Map<string, string>()
  return {
    getItem: async key => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value)
    }
  }
}
