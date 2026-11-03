import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { deviceStorage } from '../platform/deviceStorage'
import {
  clearHomeListExpanded,
  HOME_LIST_EXPANDED_KEY,
  readHomeListExpanded,
  writeHomeListExpanded
} from './homeListExpanded'

const collapsed = {
  teams: false,
  seasons: false,
  leagues: false
}

describe('home list expanded', function () {
  afterEach(async () => {
    window.localStorage.removeItem(HOME_LIST_EXPANDED_KEY)
  })

  it('keeps a write for the next read, and clear removes it', async () => {
    expect(await readHomeListExpanded()).deep.equals({
      teams: false,
      seasons: false,
      leagues: false
    })
    await writeHomeListExpanded({ teams: true, seasons: false, leagues: true })
    expect(await readHomeListExpanded()).deep.equals({
      teams: true,
      seasons: false,
      leagues: true
    })
    await clearHomeListExpanded()
    expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).equals(null)
    expect(await readHomeListExpanded()).deep.equals(collapsed)
  })

  it('reads missing and unreadable storage as collapsed', async () => {
    expect(await readHomeListExpanded()).deep.equals(collapsed)
    for (const raw of ['{', 'null', '[]', 'true']) {
      window.localStorage.setItem(HOME_LIST_EXPANDED_KEY, raw)
      expect(await readHomeListExpanded(), raw).deep.equals(collapsed)
    }
    window.localStorage.setItem(
      HOME_LIST_EXPANDED_KEY,
      '{"teams":"yes","seasons":true}'
    )
    expect(await readHomeListExpanded()).deep.equals({
      teams: false,
      seasons: true,
      leagues: false
    })
  })

  it('stays collapsed when storage refuses', async () => {
    const getItem = deviceStorage.getItem
    const setItem = deviceStorage.setItem
    const removeItem = deviceStorage.removeItem
    deviceStorage.getItem = async () => {
      throw new Error('private')
    }
    deviceStorage.setItem = async () => {
      throw new Error('quota')
    }
    deviceStorage.removeItem = async () => {
      throw new Error('quota')
    }
    try {
      expect(await readHomeListExpanded()).deep.equals(collapsed)
      await writeHomeListExpanded({
        teams: true,
        seasons: true,
        leagues: true
      })
      await clearHomeListExpanded()
      expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).equals(null)
    } finally {
      deviceStorage.getItem = getItem
      deviceStorage.setItem = setItem
      deviceStorage.removeItem = removeItem
    }
  })
})
