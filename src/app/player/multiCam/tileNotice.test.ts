import { expect } from 'chai'
import { describe, it } from 'mocha'

import { lstrings } from '../../locales/strings'
import { tileNotice, type TileNoticeState } from './tileNotice'

describe("a tile's notice", function () {
  const none: TileNoticeState = {
    unavailable: false,
    unplaceable: false,
    parked: null,
    waiting: false
  }

  it('says the first thing that is true, in order', function () {
    const said = (patch: Partial<TileNoticeState>): string =>
      tileNotice({ ...none, ...patch })
    expect(said({ unsupported: true, unavailable: true })).equals(
      lstrings.video_not_supported
    )
    expect(said({ unavailable: true, unplaceable: true })).equals(
      lstrings.game_video_unavailable
    )
    expect(said({ unplaceable: true, parked: 'afterEnd' })).equals(
      lstrings.angles_unplaceable
    )
    expect(said({ parked: 'beforeStart', waiting: true })).equals(
      lstrings.angles_not_recording_yet
    )
    expect(said({ parked: 'afterEnd', waiting: true })).equals(
      lstrings.angles_stopped
    )
    expect(said({ parked: 'notYet', waiting: true })).equals(
      lstrings.angles_tile_waiting_live
    )
    expect(said({ waiting: true })).equals(lstrings.angles_tile_catching_up)
    expect(said({ unsupported: false })).equals(lstrings.angles_tile_loading)
  })
})
