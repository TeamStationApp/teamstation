import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultHighlightSettings } from '../settings'
import { recapClips, type RecapEvent } from './clips'

const event = (index: number, seconds: number): RecapEvent => ({
  atBatIndex: index,
  endTime: new Date(seconds * 1000),
  startTime: null,
  eventType: 'single',
  timeNudgeSec: 1,
  isScoringPlay: false,
  hidden: false
})
const video = {
  id: 'vid_demo',
  start_at: new Date(0),
  sync_offset_sec: 2,
  duration_sec: 200
}
const settings = {
  ...defaultHighlightSettings,
  lagSec: 3,
  leadSec: 4,
  leadSecByEventType: { single: 6 }
}
describe('recap clip timing', () => {
  it('starts at the existing highlight offset and ends five seconds before next scoring play', () => {
    expect(
      recapClips(
        [event(0, 20), { ...event(1, 60), isScoringPlay: true }],
        [video],
        settings
      )['0']
    ).deep.equals({ videoId: 'vid_demo', start: 14, end: 55 })
    expect(recapClips([event(0, 20)], [video], settings)['0'].end).equals(32)
  })
  it('uses fallback taps/leads, clamps video bounds and accepts uncredited plays', () => {
    expect(
      recapClips(
        [
          {
            ...event(0, 3),
            endTime: null,
            startTime: new Date(3000),
            eventType: null
          }
        ],
        [{ ...video, duration_sec: 10 }],
        settings
      )['0']
    ).deep.equals({ videoId: 'vid_demo', start: 0, end: 10 })
    expect(
      recapClips(
        [{ ...event(0, 20), eventType: 'field_error' }],
        [video],
        settings
      )['0'].start
    ).equals(16)
  })
  it('keeps hidden, unavailable and invalid clips as plain text', () => {
    for (const e of [
      { ...event(0, 20), hidden: true },
      { ...event(0, 20), startTime: null, endTime: null },
      event(0, -20),
      event(0, 300)
    ])
      expect(recapClips([e], [video], settings)).deep.equals({})
    for (const v of [
      { ...video, start_at: null },
      { ...video, duration_sec: null },
      { ...video, duration_sec: 0 }
    ])
      expect(recapClips([event(0, 20)], [v], settings)).deep.equals({})
    expect(
      recapClips(
        [
          event(0, 20),
          { ...event(1, 20), isScoringPlay: true, timeNudgeSec: -20 }
        ],
        [video],
        settings
      )['0']
    ).equals(undefined)
    expect(
      recapClips(
        [event(0, 20)],
        [{ ...video, id: 'vid_first' }, video],
        settings
      )['0'].videoId
    ).equals('vid_first')
  })
})
