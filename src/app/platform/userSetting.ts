import { gumboOfUserId } from '../../common/userId'

export interface UserSettingStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem?: (key: string) => Promise<void>
}

/** Upgrade a pre-migration account's local key without losing its saved value. */
export async function readUserSetting(
  storage: UserSettingStorage,
  userId: string,
  key: (id: string) => string
): Promise<string | null> {
  const current = await storage.getItem(key(userId))
  if (current != null) return current
  const oldId = gumboOfUserId(userId)
  if (oldId == null) return null
  const oldKey = key(String(oldId))
  const legacy = await storage.getItem(oldKey)
  if (legacy == null) return null
  try {
    await storage.setItem(key(userId), legacy)
    // Some platform adapters silently refuse writes. Keep the source until
    // the new copy can actually be read back.
    if ((await storage.getItem(key(userId))) === legacy) {
      await storage.removeItem?.(oldKey)
    }
  } catch {
    // A quota or unavailable storage must not discard a usable old setting.
  }
  return legacy
}
