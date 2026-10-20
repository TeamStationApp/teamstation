import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo, userIdOfValue } from '../../common/userId'
import { scoringPreferences } from '../scoring/scoringPreferences'
import { scoringPreferenceStore } from '../scoring/scoringPreferenceStore'
import { deviceLinkStore } from '../walkup/resolveSong'
import { deviceStorage } from './deviceStorage'
import { readUserSetting, type UserSettingStorage } from './userSetting'

function memory(): UserSettingStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
    },
    removeItem: async key => {
      values.delete(key)
    }
  }
}
const id = userIdOfGumbo(42)
const key = (id: string): string => `setting:${id}`

describe('account-keyed device settings', () => {
  it('migrates keys through the production browser storage adapters', async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window'
    )
    const storageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage'
    )
    const values = new Map<string, string>()
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      }
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage }
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: localStorage
    })
    try {
      values.set('setting:42', 'held')
      expect(await readUserSetting(deviceStorage, id, key)).equals('held')
      expect(values.has('setting:42')).equals(false)
      values.set(
        'teamstation:scoring:42:switch-hitter',
        '{"help":false,"shown":2,"sound":false}'
      )
      expect(await scoringPreferences.read(id)).deep.equals({
        help: false,
        shown: 2,
        sound: false
      })
      expect(values.has('teamstation:scoring:42:switch-hitter')).equals(false)
    } finally {
      if (windowDescriptor != null)
        Object.defineProperty(globalThis, 'window', windowDescriptor)
      else Reflect.deleteProperty(globalThis, 'window')
      if (storageDescriptor != null)
        Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
  it('moves a legacy setting only after verifying the canonical copy', async () => {
    const storage = memory()
    storage.values.set(key('42'), 'saved')
    expect(await readUserSetting(storage, id, key)).equals('saved')
    expect([...storage.values]).deep.equals([[key(id), 'saved']])
    storage.values.set(key('42'), 'stale')
    expect(await readUserSetting(storage, id, key)).equals('saved')
    expect(storage.values.get(key('42'))).equals('stale')
  })
  it('returns the old setting and preserves it when writing or deleting fails', async () => {
    for (const failure of ['write', 'silent', 'delete', 'noRemove']) {
      const storage = memory()
      storage.values.set(key('42'), 'saved')
      if (failure === 'write')
        storage.setItem = async () => {
          throw new Error('quota')
        }
      if (failure === 'silent') storage.setItem = async () => undefined
      if (failure === 'delete')
        storage.removeItem = async () => {
          throw new Error('unavailable')
        }
      if (failure === 'noRemove') delete storage.removeItem
      expect(await readUserSetting(storage, id, key)).equals('saved')
      expect(storage.values.get(key('42'))).equals('saved')
    }
  })
  it('does not search legacy keys for new random identities or missing settings', async () => {
    const storage = memory()
    expect(await readUserSetting(storage, id, key)).equals(null)
    expect(
      await readUserSetting(storage, userIdOfValue(1n << 80n), key)
    ).equals(null)
    expect(storage.values.size).equals(0)
  })
  it('migrates both scoring preferences and per-team song handles', async () => {
    const storage = memory()
    storage.values.set(
      'teamstation:scoring:42:switch-hitter',
      '{"help":false,"shown":2,"sound":false}'
    )
    expect(await scoringPreferenceStore(storage).read(id)).deep.equals({
      help: false,
      shown: 2,
      sound: false
    })
    expect(storage.values.has('teamstation:scoring:42:switch-hitter')).equals(
      false
    )
    storage.values.set(
      'walkUp:tem_one:42:catalog-song',
      'content://picked/song'
    )
    const links = deviceLinkStore(storage)
    expect(
      await links.read({ teamId: 'tem_one', userId: id }, 'catalog-song')
    ).equals('content://picked/song')
    expect(
      await links.read({ teamId: 'tem_other', userId: id }, 'catalog-song')
    ).equals(null)
    expect(storage.values.has('walkUp:tem_one:42:catalog-song')).equals(false)
  })
})
