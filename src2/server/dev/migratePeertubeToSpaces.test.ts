import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  EQUIVALENT_PRIMARY_MS,
  type LibraryVideo,
  moveDecision
} from './migratePeertubeToSpaces'

function video(
  partial: Partial<LibraryVideo> & Pick<LibraryVideo, 'id' | 'title'>
): LibraryVideo {
  return {
    kind: 'program',
    storage: 'peertube',
    gameId: 'gam_one',
    startAt: new Date('2026-05-09T22:00:00Z'),
    startAtSource: 'originallyPublishedAt',
    numCameras: 1,
    ...partial
  }
}

describe('which PeerTube rows move to Spaces', function () {
  const primary = video({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    title: '2026-05-09 Hawks vs Bay Stars'
  })

  it('copies a primary still on PeerTube', function () {
    expect(moveDecision(primary, [primary])).deep.equals({
      action: 'migrate',
      reason: 'primary still on PeerTube'
    })
  })

  it('leaves a multi-angle composite where it is', function () {
    const mosaic = video({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: '2026-05-09 Hawks vs Bay Stars raw',
      kind: 'combined'
    })
    expect(moveDecision(mosaic, [primary, mosaic]).action).equals('skip')
    expect(moveDecision(mosaic, [primary, mosaic]).reason).match(/multi-angle/)
  })

  it('leaves a live that already has a primary on the same game', function () {
    const live = video({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      title: 'QPLL Live - 5/9/2026, 3:00:00 PM',
      startAtSource: 'liveSession'
    })
    const decided = moveDecision(live, [primary, live])
    expect(decided.action).equals('skip')
    expect(decided.reason).match(/already has primary/)
  })

  it('copies a live whose game has no primary', function () {
    const live = video({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      title: 'Live - 8/29/2026, 3:36:30 PM',
      gameId: 'gam_titan',
      startAtSource: 'liveSession'
    })
    expect(moveDecision(live, [primary, live])).deep.equals({
      action: 'migrate',
      reason: 'live with no equivalent primary'
    })
  })

  it('treats an unattached live within 15 minutes of a primary as the same recording', function () {
    const twin = video({
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      title: 'QPLL Livestream - 5/9/2026, 3:00:03 PM',
      gameId: null,
      startAt: new Date((primary.startAt ?? new Date()).getTime() + 3_000),
      startAtSource: 'liveSession'
    })
    const decided = moveDecision(twin, [primary, twin])
    expect(decided.action).equals('skip')
    expect(decided.reason).match(/unattached/)
  })

  it('copies an unattached live that is further than 15 minutes from every primary', function () {
    const orphan = video({
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      title: 'Live - 9/5/2026, 5:55:32 PM',
      gameId: null,
      startAt: new Date(
        (primary.startAt ?? new Date()).getTime() +
          EQUIVALENT_PRIMARY_MS +
          1_000
      ),
      startAtSource: 'liveSession'
    })
    expect(moveDecision(orphan, [primary, orphan]).action).equals('migrate')
  })

  it('does not copy a partial', function () {
    const part = video({
      id: '11111111-1111-1111-1111-111111111111',
      title: '2026-05-09 Steam Duckies vs Fire (partial)'
    })
    expect(moveDecision(part, [part]).reason).match(/partial/)
  })

  it('does not copy a camera angle', function () {
    const camera = video({
      id: '22222222-2222-2222-2222-222222222222',
      title: '2026-05-09 Hawks vs Bay Stars 1st',
      storage: 'peertube'
    })
    expect(moveDecision(camera, [camera]).reason).match(/camera/)
  })

  it('skips a row already on Spaces', function () {
    const done = video({
      id: primary.id,
      title: primary.title,
      storage: 'spaces'
    })
    expect(moveDecision(done, [done]).reason).equals('already on Spaces')
  })

  it('honours --skip by full id and by an 8-character prefix', function () {
    const skip = new Set(['aaaaaaaa'])
    expect(moveDecision(primary, [primary], skip).reason).equals(
      'listed in --skip'
    )
  })
})
