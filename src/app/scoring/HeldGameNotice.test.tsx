import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { find, mount, press, text, unmount } from '../../test/gameFormDom'
import type { HeldControl } from '../sync/useOffline'
import {
  HELD_GAME_CONSEQUENCE,
  HELD_TEAM_CONSEQUENCE,
  HeldGameNotice,
  TRY_AGAIN,
  USE_SERVER_COPY
} from './HeldGameNotice'

const held = (calls: string[]): HeldControl => ({
  state: 'dead',
  text: 'Not sent: Only staff.',
  discard: async () => {
    calls.push('discard')
    return true
  },
  retry: async () => {
    calls.push('retry')
  }
})

describe('the held notice', () => {
  afterEach(async () => {
    await unmount()
  })

  it("says a game's cost by default, and carries the id it is given on its button", async () => {
    const calls: string[] = []
    const settled: boolean[] = []
    await mount(
      <HeldGameNotice
        held={held(calls)}
        testID="heldGameNotice"
        onSettled={arrived => settled.push(arrived)}
      >
        <span>Not sent: Only staff.</span>
      </HeldGameNotice>
    )
    const button = document.querySelector('[data-testid="heldGameNotice"]')!
    expect(button.getAttribute('aria-label')).equals('Unsent changes')
    await press('Unsent changes')
    expect(text()).includes(HELD_GAME_CONSEQUENCE)
    expect(find(TRY_AGAIN)).not.equals(undefined)
    await press(USE_SERVER_COPY)
    expect(calls).deep.equals(['discard'])
    expect(settled).deep.equals([true])
  })

  it('says the cost it is given: a team’s', async () => {
    const calls: string[] = []
    await mount(
      <HeldGameNotice
        held={held(calls)}
        consequence={HELD_TEAM_CONSEQUENCE}
        onSettled={() => undefined}
      >
        <span>held</span>
      </HeldGameNotice>
    )
    await press('Unsent changes')
    expect(text()).includes(HELD_TEAM_CONSEQUENCE)
    expect(text()).not.includes(HELD_GAME_CONSEQUENCE)
    await press(TRY_AGAIN)
    expect(calls).deep.equals(['retry'])
  })
})
