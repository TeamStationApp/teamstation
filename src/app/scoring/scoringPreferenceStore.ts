import { DICTATION_MODELS, type DictationModel } from '../../common/api'
import {
  readUserSetting,
  type UserSettingStorage
} from '../platform/userSetting'

export interface ScoringPreferences {
  sound?: boolean
  /** Plays are drawn as they happen; off, the field just shows the result. */
  animations?: boolean
  /** The LLM dictation puts a sentence to; absent, the server's own. */
  dictationModel?: DictationModel
  help: boolean
  shown: number
}
export type PreferenceStorage = UserSettingStorage
export function scoringPreferenceStore(storage: PreferenceStorage): {
  read: (userId: string) => Promise<ScoringPreferences>
  write: (userId: string, value: ScoringPreferences) => Promise<void>
  /**
   * Reads the stored preferences and writes back what `change` makes of
   * them, one update after another: they are all kept under one key, so a
   * change never rolls back another's field. `change` may answer null to
   * write nothing. Answers what was written, or null.
   */
  update: (
    userId: string,
    change: (stored: ScoringPreferences) => ScoringPreferences | null
  ) => Promise<ScoringPreferences | null>
} {
  const key = (id: string): string =>
    `teamstation:scoring:${encodeURIComponent(id)}:switch-hitter`
  let updates: Promise<unknown> = Promise.resolve()
  const store = {
    async read(userId: string): Promise<ScoringPreferences> {
      try {
        const raw = await readUserSetting(storage, userId, key)
        if (raw == null) return { help: true, shown: 0 }
        const value: unknown = JSON.parse(raw)
        if (
          typeof value !== 'object' ||
          value == null ||
          !('help' in value) ||
          !('shown' in value)
        )
          return { help: true, shown: 0 }
        return {
          ...('sound' in value ? { sound: value.sound !== false } : {}),
          ...('animations' in value
            ? { animations: value.animations !== false }
            : {}),
          ...('dictationModel' in value &&
          DICTATION_MODELS.includes(value.dictationModel as DictationModel)
            ? { dictationModel: value.dictationModel as DictationModel }
            : {}),
          help: value.help !== false,
          shown:
            typeof value.shown === 'number' && Number.isInteger(value.shown)
              ? Math.max(0, Math.min(3, value.shown))
              : 0
        }
      } catch {
        return { help: true, shown: 0 }
      }
    },
    async write(userId: string, value: ScoringPreferences): Promise<void> {
      try {
        await storage.setItem(key(userId), JSON.stringify(value))
      } catch {
        /* Restricted device storage must not block scoring. */
      }
    },
    async update(
      userId: string,
      change: (stored: ScoringPreferences) => ScoringPreferences | null
    ): Promise<ScoringPreferences | null> {
      const next = updates.then(async () => {
        const value = change(await store.read(userId))
        if (value != null) await store.write(userId, value)
        return value
      })
      updates = next.catch(() => undefined)
      return await next
    }
  }
  return store
}
