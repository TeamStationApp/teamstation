import { DICTATION_MODELS, type DictationModel } from '../../common/api'

export interface ScoringPreferences {
  sound?: boolean
  /** Plays are drawn as they happen; off, the field just shows the result. */
  animations?: boolean
  /** The LLM dictation puts a sentence to; absent, the server's own. */
  dictationModel?: DictationModel
  help: boolean
  shown: number
}
export interface PreferenceStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}
export function scoringPreferenceStore(storage: PreferenceStorage): {
  read: (userId: string) => Promise<ScoringPreferences>
  write: (userId: string, value: ScoringPreferences) => Promise<void>
} {
  const key = (id: string): string =>
    `teamstation:scoring:${encodeURIComponent(id)}:switch-hitter`
  return {
    async read(userId) {
      try {
        const raw = await storage.getItem(key(userId))
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
    async write(userId, value) {
      try {
        await storage.setItem(key(userId), JSON.stringify(value))
      } catch {
        /* Restricted device storage must not block scoring. */
      }
    }
  }
}
