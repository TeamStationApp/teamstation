import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { VideoSummary } from '../../common/api'
import { openingCameras, replacedSlot, selectableCamera } from './cameraChoice'

const video = (
  id: string,
  status: string,
  startAt: string | null = null,
  extra: Partial<VideoSummary> = {}
): VideoSummary => ({
  id,
  numCameras: 1,
  kind: 'camera',
  title: `Angle ${id}`,
  status,
  receiving: status === 'live',
  storage: 'local',
  startAt,
  syncOffsetSec: 0,
  durationSec: null,
  width: null,
  height: null,
  codecs: null,
  posterUrl: null,
  ...extra
})

describe('TV camera choice', () => {
  it('offers single cameras that can play, recorded or live', () => {
    expect(
      [
        video('a', 'ready'),
        video('b', 'live'),
        video('c', 'processing'),
        video('d', 'ready', null, { numCameras: 4 }),
        video('e', 'ready', null, { durationSec: 0 })
      ]
        .filter(selectableCamera)
        .map(v => v.id)
    ).deep.equals(['a', 'b'])
  })
  it('opens on the live cameras and the newest recordings, in the game order', () => {
    const old = Array.from({ length: 17 }, (_, i) =>
      video(
        `old${i}`,
        'ready',
        `2026-10-01T00:${String(i).padStart(2, '0')}:00Z`
      )
    )
    const live = [
      video('liveA', 'live', '2026-10-01T02:00:00Z'),
      video('liveB', 'live', '2026-10-01T02:01:00Z'),
      video('liveC', 'live', null)
    ]
    expect(openingCameras([...old, ...live]).map(v => v.id)).deep.equals([
      'old16',
      'liveA',
      'liveB',
      'liveC'
    ])
    expect(openingCameras(old.slice(0, 3)).map(v => v.id)).deep.equals([
      'old0',
      'old1',
      'old2'
    ])
    // Without start times, later in the game's list is newer.
    expect(
      openingCameras(
        Array.from({ length: 6 }, (_, i) => video(String(i), 'ready'))
      ).map(v => v.id)
    ).deep.equals(['2', '3', '4', '5'])
  })
  it('replaces a hidden player first, then one with nothing to show, never the enlarged one', () => {
    const showing = (): boolean => true
    expect(
      replacedSlot({ count: 4, visible: [0, 1, 3], full: null, showing })
    ).equals(2)
    expect(
      replacedSlot({
        count: 4,
        visible: [0, 1, 2, 3],
        full: null,
        showing: slot => slot !== 1
      })
    ).equals(1)
    expect(
      replacedSlot({ count: 4, visible: [0, 1, 2, 3], full: null, showing })
    ).equals(3)
    expect(
      replacedSlot({ count: 4, visible: [0, 1, 2, 3], full: 3, showing })
    ).equals(2)
    expect(
      replacedSlot({
        count: 4,
        visible: [0, 1, 2, 3],
        full: 1,
        showing: slot => slot !== 1
      })
    ).equals(3)
  })
})
