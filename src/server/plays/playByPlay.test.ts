import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultHighlightTimings } from '../../common/nodeSettings'
import {
  buildPlayByPlay,
  CLIP_TAIL_SEC,
  type PlayByPlayEvent
} from './playByPlay'

const settings = defaultHighlightTimings

function event(fields: Partial<PlayByPlayEvent>): PlayByPlayEvent {
  return {
    id: 'e1',
    atBatIndex: 0,
    eventType: 'single',
    inning: 1,
    halfInning: 'top',
    awayScore: 0,
    homeScore: 0,
    isScoringPlay: false,
    startTime: new Date(100_000),
    timeNudgeSec: 0,
    hidden: false,
    outs: 1,
    credits: [],
    avatarUrl: null,
    ...fields
  }
}

const video = {
  id: 'vid',
  startAt: new Date(0),
  syncOffsetSec: 0,
  durationSec: 400
}

describe('the Plays tab', () => {
  it('recounts each at-bat by half-inning and leaves out bookkeeping', () => {
    const built = buildPlayByPlay({
      settings,
      video: null,
      awayLabel: 'Cubs',
      homeLabel: 'Padres',
      prelude: { time: '7:11 PM PDT', place: 'Petco Park' },
      events: [
        event({ id: 'visit', eventType: 'mound_visit', atBatIndex: 0 }),
        event({
          id: 'k',
          atBatIndex: 1,
          eventType: 'strikeout',
          outs: 1,
          credits: [
            {
              eventType: 'strikeout',
              label: 'Strikeout: Alex L',
              creditUserId: 1,
              credit: { name: 'Alex L', role: 'batter', position: null }
            }
          ]
        }),
        event({
          id: 'hr',
          atBatIndex: 2,
          eventType: 'home_run',
          halfInning: 'bottom',
          isScoringPlay: true,
          awayScore: 0,
          homeScore: 1,
          outs: null,
          credits: [
            {
              eventType: 'home_run',
              label: 'Home run: Manny M',
              creditUserId: 2,
              credit: { name: 'Manny M', role: 'batter', position: null }
            }
          ]
        })
      ]
    })
    expect(built.prelude).deep.equals({
      time: '7:11 PM PDT',
      place: 'Petco Park'
    })
    expect(built.innings.map(inning => inning.heading)).deep.equals([
      'Top 1st',
      'Bottom 1st'
    ])
    expect(built.innings[0].plays).has.length(1)
    expect(built.innings[0].plays[0].outcome).equals('Strikeout')
    expect(built.innings[0].plays[0].sentence).equals('Alex L strikes out.')
    expect(built.innings[0].plays[0].outsLabel).equals('1 out')
    expect(built.innings[0].plays[0].score).equals(null)
    expect(built.innings[0].plays[0].clip).equals(null)
    expect(built.innings[1].plays[0].score).deep.equals({
      awayLabel: 'Cubs',
      awayScore: 0,
      homeLabel: 'Padres',
      homeScore: 1,
      batting: 'home'
    })
    expect(built.innings[1].plays[0]).not.to.have.key('winProbability')
  })

  it('starts a major-play clip at the highlight rewind and stops before the next score', () => {
    const built = buildPlayByPlay({
      settings,
      video,
      awayLabel: 'Away',
      homeLabel: 'Home',
      prelude: null,
      events: [
        event({
          id: 'double',
          eventType: 'double',
          startTime: new Date(100_000),
          isScoringPlay: true,
          awayScore: 1,
          homeScore: 0
        }),
        event({
          id: 'out',
          atBatIndex: 1,
          eventType: 'field_out',
          startTime: new Date(140_000),
          outs: 1
        }),
        event({
          id: 'next',
          atBatIndex: 2,
          eventType: 'single',
          startTime: new Date(200_000),
          isScoringPlay: true,
          awayScore: 2,
          homeScore: 0,
          outs: 1
        })
      ]
    })
    const clip = built.innings[0].plays[0].clip
    // Tap at 100s, lag 8, rewind 30: the clip opens at 62s.
    expect(clip?.startOffsetSec).equals(62)
    // The next scoring tap is at 200s. Stop five seconds before that play.
    expect(clip?.endOffsetSec).equals(200 - settings.lagSec - CLIP_TAIL_SEC)
    expect(built.innings[0].plays[1].clip).equals(null)
    expect(built.innings[0].plays[2].clip).equals(null)
  })

  it('clips a double play and plays to the end of the video when nothing else scores', () => {
    const built = buildPlayByPlay({
      settings,
      video,
      awayLabel: 'Away',
      homeLabel: 'Home',
      prelude: null,
      events: [
        event({
          id: 'dp',
          eventType: 'grounded_into_double_play',
          outs: 2,
          startTime: new Date(100_000)
        })
      ]
    })
    expect(built.innings[0].plays[0].outcome).equals('Double play')
    expect(built.innings[0].plays[0].outsLabel).equals('2 outs')
    expect(built.innings[0].plays[0].clip?.endOffsetSec).equals(400)
  })
})
