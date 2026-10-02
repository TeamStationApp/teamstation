import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type AngleCandidate,
  angleLabels,
  defaultAngles,
  groupIntoTakes,
  isMosaic,
  sharedPrefix,
  soundAngle,
  suffixAfter
} from './takes'

const video = (
  id: string,
  title: string,
  extra: Partial<AngleCandidate> = {}
): AngleCandidate => ({
  id,
  title,
  status: 'ready',
  numCameras: 1,
  durationSec: 5912,
  ...extra
})

/** A real take, spelled the way `PeerTubeTitle.make` spells one. */
const take = (): AngleCandidate[] => [
  video('primary', '2026-09-13 Badgers vs Cedar Lakes'),
  video('home', '2026-09-13 Badgers vs Cedar Lakes home'),
  video('first', '2026-09-13 Badgers vs Cedar Lakes 1st'),
  video('third', '2026-09-13 Badgers vs Cedar Lakes 3rd'),
  video('mosaic', '2026-09-13 Badgers vs Cedar Lakes combined')
]

describe('the words two titles share', function () {
  it('stop at a word, never in the middle of one', function () {
    expect(sharedPrefix('Badgers vs Blueberries', 'Badgers vs Blue')).equals(
      'Badgers vs'
    )
    expect(sharedPrefix('a 1st', 'a 1st base')).equals('a 1st')
  })

  it('are nothing when the titles begin differently', function () {
    expect(sharedPrefix('Hawks vs Sox', 'Badgers vs Ripken')).equals('')
  })

  it('give back what is left of a title', function () {
    expect(suffixAfter('one two three', 'one two')).equals('three')
    expect(suffixAfter('one two', 'one two')).equals('')
    expect(suffixAfter('other thing', 'one two')).equals('')
  })
})

describe('grouping a game videos into takes', function () {
  it('keeps one upload session together', function () {
    const groups = groupIntoTakes(take())
    expect(groups).has.length(1)
    expect(groups[0]).has.length(5)
  })

  it('does not collapse a legacy import into the new take', function () {
    const mixed = [
      ...take(),
      video('legacy', '2026-05-20 Hawks vs Bay Widows raw', {
        durationSec: 6563,
        numCameras: 3
      })
    ]
    const groups = groupIntoTakes(mixed)
    expect(groups).has.length(2)
  })

  it('splits two takes of the same day by their length', function () {
    const two = [
      video('a', '2026-09-13 Titan vs SM Impact', { durationSec: 7485 }),
      video('b', '2026-09-13 Titan vs SM Impact 1st', { durationSec: 7480 }),
      video('c', '2026-09-13 Titan vs SM Impact', { durationSec: 600 })
    ]
    const groups = groupIntoTakes(two)
    expect(groups).has.length(2)
    expect(groups[0].map(one => one.id)).deep.equals(['a', 'b'])
  })
})

describe('what to call each angle', function () {
  it('recovers a camera name from what the take shares', function () {
    const names = new Map(angleLabels(take()).map(one => [one.id, one.name]))
    expect(names.get('home')).equals('home')
    expect(names.get('first')).equals('1st')
    expect(names.get('third')).equals('3rd')
  })

  it('calls the track with no suffix the primary', function () {
    const names = new Map(angleLabels(take()).map(one => [one.id, one.name]))
    expect(names.get('primary')).equals('Primary')
  })

  it('keeps the name a live stream already carries', function () {
    const live = [
      video('a', '2026-09-13 Badgers vs Cedar Lakes — Behind the plate', {
        status: 'live'
      }),
      video('b', '2026-09-13 Badgers vs Cedar Lakes — First base', {
        status: 'live'
      })
    ]
    const names = new Map(angleLabels(live).map(one => [one.id, one.name]))
    expect(names.get('a')).equals('Behind the plate')
    expect(names.get('b')).equals('First base')
  })

  it('numbers two angles that would otherwise share a name', function () {
    const twins = [
      video('a', '2026-09-13 Badgers vs Cedar Lakes — Camera 1'),
      video('b', '2026-09-13 Badgers vs Cedar Lakes — Camera 1')
    ]
    const names = angleLabels(twins).map(one => one.name)
    expect(names).deep.equals(['Camera 1 1', 'Camera 1 2'])
  })

  it('falls back to the title, less its date, for a lone video', function () {
    const alone = [video('a', '2026-09-13 Badgers vs Cedar Lakes')]
    expect(angleLabels(alone)[0].name).equals('Badgers vs Cedar Lakes')
  })
})

describe('telling the mosaic from the cameras', function () {
  it('knows it by its suffix, whichever generation spelled it', function () {
    expect(isMosaic(video('x', 'anything'), 'combined')).equals(true)
    expect(isMosaic(video('x', 'anything'), 'raw')).equals(true)
    expect(isMosaic(video('x', 'anything'), '3rd')).equals(false)
  })

  it('knows it by its camera count as well, since the suffix may be absent', function () {
    expect(isMosaic(video('x', 'anything', { numCameras: 3 }), '3rd')).equals(
      true
    )
  })
})

describe('the four ticked when the picker opens', function () {
  it('are the first four cameras, and never the mosaic', function () {
    expect(defaultAngles(take())).deep.equals([
      'primary',
      'home',
      'first',
      'third'
    ])
  })

  it('skip a video whose files have gone', function () {
    const withGone = [
      video('gone', '2026-09-13 Badgers vs Cedar Lakes home', {
        status: 'unavailable'
      }),
      ...take().filter(one => one.id !== 'home')
    ]
    expect(defaultAngles(withGone)).not.includes('gone')
  })

  it('offer the mosaic when it is the only thing there is', function () {
    const only = [
      video('mosaic', '2026-05-20 Hawks vs Bay Widows raw', {
        numCameras: 3,
        durationSec: 6563
      })
    ]
    expect(defaultAngles(only)).deep.equals(['mosaic'])
  })

  it('skip a recording with no length, which could only ever say it stopped', function () {
    const withEmpty = [
      video('empty', '2026-09-13 Badgers vs Cedar Lakes centre', {
        durationSec: 0
      }),
      ...take().filter(one => one.id !== 'mosaic')
    ]
    expect(defaultAngles(withEmpty)).not.includes('empty')
  })

  it("are the take's own cameras, not the live stream sorted before them", function () {
    // A game whose live recording was kept beside a four-camera upload holds
    // five playable videos, and the stream sorts first because it started
    // first. It is another copy of the game rather than an angle of it, so it
    // must not take a quadrant from a camera.
    const withLive = [
      video('live', 'Badgers vs Cedar Lakes — GS Director', {
        durationSec: 5725
      }),
      ...take().filter(one => one.id !== 'mosaic')
    ]
    expect(defaultAngles(withLive)).deep.equals([
      'primary',
      'home',
      'first',
      'third'
    ])
  })

  it('still fill the grid from a game whose videos do not group', function () {
    // Legacy imports whose titles share nothing: one video per take. The grid
    // is filled from what there is rather than left with a single quadrant.
    const strangers = [
      video('a', '2026-05-20 Hawks vs Bay Widows 1st'),
      video('b', 'Some other recording entirely', { durationSec: 1200 }),
      video('c', 'A third thing', { durationSec: 90 })
    ]
    expect(defaultAngles(strangers)).deep.equals(['a', 'b', 'c'])
  })

  it('never offer more than four', function () {
    const many = [
      ...take().filter(one => one.id !== 'mosaic'),
      video('fifth', '2026-09-13 Badgers vs Cedar Lakes centre')
    ]
    expect(defaultAngles(many)).has.length(4)
  })
})

describe('which tile is heard', function () {
  it("is the take's programme output where every angle is the same length", function () {
    // A camera's archive has no sound — the exporter gives it a silent track
    // — so a take's sound is its programme output. It is also the angle that
    // spans the take, but a take stored to the second usually has nothing to
    // choose between on length, and then the answer is the one upload with no
    // camera suffix on its title.
    const angles = take().filter(one => one.id !== 'mosaic')
    expect(soundAngle(angles, ['home', 'primary', 'first'])).equals('primary')
  })

  it('is not a clip that happens to sort first', function () {
    // The game that produced this: a two-hour live recording beside a
    // 107-second upload stamped two days later. The sound went to the clip,
    // which the view refuses to start, so the game played in silence.
    const mixed = [
      video('clip', '2026-09-22 a clip', { durationSec: 107 }),
      video('live', 'Monument Trails at Badgers — GS Director', {
        durationSec: 7057
      })
    ]
    expect(soundAngle(mixed, ['clip', 'live'])).equals('live')
  })

  it('keeps the tile somebody chose, while it is still on the grid', function () {
    const angles = take().filter(one => one.id !== 'mosaic')
    expect(soundAngle(angles, ['primary', 'home', 'first'], 'first')).equals(
      'first'
    )
  })

  it('gives the sound back when the chosen tile is unticked', function () {
    // Untick the tile that holds the sound and every remaining tile was muted
    // in favour of one that is not there, so the game played in silence. What
    // matters is that the answer is a tile on the grid.
    const angles = take().filter(one => one.id !== 'mosaic')
    const heard = soundAngle(angles, ['primary', 'home'], 'first')
    expect(['primary', 'home']).contains(heard)
  })

  it('gives the sound back when the chosen tile has left the game', function () {
    // A kept link outlives the videos it names. Delete the angle that held
    // the sound — or let an upload hide the live recording, which this branch
    // does on its own — and the address still names it: the grid then muted
    // every tile that was playing in favour of one nothing draws.
    const angles = take().filter(one => one.id !== 'mosaic')
    const gone = angles.filter(one => one.id !== 'home')
    const heard = soundAngle(gone, ['primary', 'home', 'first'], 'home')
    expect(heard).is.not.equals('home')
    expect(['primary', 'first']).contains(heard)
  })

  it('never answers with a tile the grid does not draw', function () {
    // The grid stops at four. An address can carry five, and the fifth was
    // answered with while nothing rendered it.
    const five = [
      video('a', 'Take a', { durationSec: 10 }),
      video('b', 'Take b', { durationSec: 10 }),
      video('c', 'Take c', { durationSec: 10 }),
      video('d', 'Take d', { durationSec: 10 }),
      video('e', 'Take e', { durationSec: 9000 })
    ]
    const order = ['a', 'b', 'c', 'd', 'e']
    expect(soundAngle(five, order)).is.not.equals('e')
    expect(soundAngle(five, order, 'e')).is.not.equals('e')
  })

  it('is not an angle that has not started when the grid opens', function () {
    // Tick angles from two takes and the view's timeline starts at the
    // earlier one. The longest angle is then easily the later take's, and it
    // held the sound while its tile read "Not recording yet" — the game
    // played in silence until somebody scrubbed an hour in.
    const across = [
      video('early', '2026-09-20 Badgers vs Titan', {
        startAt: '2026-09-20T19:15:00.000Z',
        durationSec: 600
      }),
      video('early home', '2026-09-20 Badgers vs Titan home', {
        startAt: '2026-09-20T19:15:00.000Z',
        durationSec: 600
      }),
      video('late live', '2026-09-20 Badgers vs Titan — GS Director', {
        startAt: '2026-09-20T21:00:00.000Z',
        durationSec: 7057
      })
    ]
    const heard = soundAngle(across, ['early', 'early home', 'late live'])
    expect(heard).is.not.equals('late live')
    expect(['early', 'early home']).contains(heard)
  })

  it('moves to a tile that is playing once the position has passed the first', function () {
    // The fault the position is here for: asked once, at the open, the answer
    // is about one instant of a timeline that can be days long. Scrub past
    // the short take and the tile holding the sound has stopped, while the
    // recording that is actually playing is muted against it.
    const across = [
      video('clip', '2026-09-20 Badgers vs Titan clip', {
        startAt: '2026-09-20T19:15:00.000Z',
        durationSec: 26
      }),
      video('game', '2026-09-20 Badgers vs Titan — GS Director', {
        startAt: '2026-09-20T21:00:00.000Z',
        durationSec: 7057
      })
    ]
    const order = ['clip', 'game']
    const opensAt = Date.parse('2026-09-20T19:15:00.000Z')
    expect(soundAngle(across, order, null, opensAt)).equals('clip')
    expect(
      soundAngle(across, order, null, Date.parse('2026-09-20T21:30:00.000Z'))
    ).equals('game')
  })

  it('keeps a tile the viewer picked, wherever the position is', function () {
    // An explicit choice is a choice. Somebody who picks a tile from the bar
    // may well be about to scrub to it.
    const across = [
      video('clip', '2026-09-20 Badgers vs Titan clip', {
        startAt: '2026-09-20T19:15:00.000Z',
        durationSec: 26
      }),
      video('game', '2026-09-20 Badgers vs Titan — GS Director', {
        startAt: '2026-09-20T21:00:00.000Z',
        durationSec: 7057
      })
    ]
    expect(
      soundAngle(
        across,
        ['clip', 'game'],
        'clip',
        Date.parse('2026-09-20T21:30:00.000Z')
      )
    ).equals('clip')
  })

  it('keeps taking the longest where every angle is playing', function () {
    // The ordinary case, and the one the rule exists for: one take, every
    // angle on the same instant, the programme output the longest of them.
    const together = [
      video('camera', '2026-09-20 Badgers vs Titan home', {
        startAt: '2026-09-20T19:15:00.000Z',
        durationSec: 600
      }),
      video('programme', '2026-09-20 Badgers vs Titan', {
        startAt: '2026-09-20T19:15:00.200Z',
        durationSec: 3600
      })
    ]
    expect(soundAngle(together, ['camera', 'programme'])).equals('programme')
  })

  it('still answers where no angle carries a start', function () {
    const angles = take().filter(one => one.id !== 'mosaic')
    expect(soundAngle(angles, ['home', 'primary', 'first'])).equals('primary')
  })

  it('does not move when the tiles are dragged around', function () {
    // A take's angles are recorded together and stored to the second, so
    // equal lengths are the ordinary case rather than the odd one. Breaking
    // the tie by position in the tick list meant one drag moved the sound —
    // and moved it onto a camera archive, which is silent by design.
    const tied = [
      video('programme', '2026-09-13 Badgers vs Cedar Lakes', {
        durationSec: 601
      }),
      video('camera', '2026-09-13 Badgers vs Cedar Lakes home', {
        durationSec: 601
      })
    ]
    expect(soundAngle(tied, ['programme', 'camera'])).equals('programme')
    expect(soundAngle(tied, ['camera', 'programme'])).equals('programme')
  })

  it('breaks a tie between two cameras the same way whichever way round', function () {
    const tied = [
      video('bbb', '2026-09-13 Badgers vs Cedar Lakes home', {
        durationSec: 601
      }),
      video('aaa', '2026-09-13 Badgers vs Cedar Lakes 1st', {
        durationSec: 601
      })
    ]
    expect(soundAngle(tied, ['bbb', 'aaa'])).equals(
      soundAngle(tied, ['aaa', 'bbb'])
    )
  })

  it('has nothing to say when nothing is ticked', function () {
    expect(soundAngle(take(), [])).equals(null)
    expect(soundAngle(take(), [], 'primary')).equals(null)
  })

  it('has nothing to say when every ticked angle has gone', function () {
    const angles = take().filter(one => one.id !== 'mosaic')
    expect(soundAngle(angles, ['vid_gone'], 'vid_gone')).equals(null)
  })
})
