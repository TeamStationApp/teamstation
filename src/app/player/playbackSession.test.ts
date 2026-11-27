import { expect } from 'chai'
import { describe, it } from 'mocha'

import type {
  EventName,
  Level,
  Property
} from '../../common/observability/contract'
import {
  bufferedAheadOf,
  FIRST_FRAME_WAIT_MS,
  HEARTBEAT_MS,
  hlsDetail,
  hlsKind,
  markSeek,
  nameSurface,
  nativeErrorCode,
  PER_MINUTE_CAP,
  type PlaybackClock,
  type PlaybackDescription,
  playbackOf,
  PlaybackSession,
  ROUTINE_PER_MINUTE_CAP,
  ROUTINE_SESSION_CAP,
  SEEK_MARK_MS,
  SEEK_PER_MINUTE_CAP,
  SEEK_SESSION_CAP,
  SEEK_STALE_MS,
  SESSION_EVENT_CAP,
  startOf,
  startPlayback,
  surfaceOf,
  videoIdOf
} from './playbackSession'
import type { VideoEventName, VideoHandle } from './videoHandle'

const ID = '00000000-0000-4000-8000-0000000000aa'

class FakePlayer implements VideoHandle {
  currentTime = 0
  duration = Number.POSITIVE_INFINITY
  paused = true
  muted = true
  volume = 1
  playbackRate = 1
  readyState = 0
  videoWidth = 1920
  videoHeight = 1080
  seekableEnd: number | null = null
  bufferedEnd?: number | null
  buffered?: {
    length: number
    start: (index: number) => number
    end: (index: number) => number
  }

  error?: { code: number } | null
  lastError?: unknown
  bandwidthEstimate?: number | null
  getVideoPlaybackQuality?: () => {
    droppedVideoFrames: number
    totalVideoFrames: number
  }

  private readonly listeners = new Map<string, Set<() => void>>()
  async play(): Promise<void> {
    this.paused = false
    this.fire('play')
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(type: VideoEventName, listener: () => void): void {
    const held = this.listeners.get(type) ?? new Set()
    held.add(listener)
    this.listeners.set(type, held)
  }

  removeEventListener(type: VideoEventName, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  fire(type: VideoEventName): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  count(): number {
    let total = 0
    for (const held of this.listeners.values()) total += held.size
    return total
  }

  /** Plays forward by `sec` with a time update. */
  advance(sec: number): void {
    this.currentTime += sec
    this.fire('timeupdate')
  }
}

class ManualClock {
  at = 1_000_000
  now: PlaybackClock = () => this.at
  tick(ms: number): void {
    this.at += ms
  }
}

interface Sent {
  event: EventName
  properties: Record<string, Property>
  level?: Level
}

function setup(
  description: Partial<PlaybackDescription> = {},
  player = new FakePlayer()
): {
  player: FakePlayer
  clock: ManualClock
  sent: Sent[]
  session: PlaybackSession
  last: (event: EventName) => Record<string, Property> | undefined
} {
  const clock = new ManualClock()
  const sent: Sent[] = []
  const session = new PlaybackSession(
    player,
    {
      videoId: 'vid_demo',
      engine: 'native',
      surface: 'game',
      live: true,
      start: 'live_edge',
      ...description
    },
    (event, properties, level) => {
      sent.push({ event, properties, level })
    },
    clock.now,
    () => ID
  )
  return {
    player,
    clock,
    sent,
    session,
    last: event => sent.filter(row => row.event === event).at(-1)?.properties
  }
}

describe('playback session', () => {
  it('reports the attachment, then its first moving frame', () => {
    const { player, clock, sent, session, last } = setup()
    expect(sent[0]).deep.equals({
      event: 'playback_attached',
      properties: {
        ps: ID,
        en: 'native',
        sf: 'game',
        lv: true,
        vi: 'vid_demo',
        si: 'live_edge',
        pos: 0
      },
      level: 'info'
    })
    expect(playbackOf(player)).equals(session)
    session.sourceSet()
    session.pending(28_000)
    clock.tick(800)
    player.readyState = 1
    player.fire('loadedmetadata')
    player.fire('canplay')
    player.fire('canplay')
    player.play().catch(() => undefined)
    player.currentTime = 600
    player.seekableEnd = 645
    player.fire('timeupdate')
    clock.tick(400)
    expect(last('playback_first_frame')).equals(undefined)
    player.advance(0.25)
    expect(last('playback_source_set')).deep.include({ ms: 0 })
    expect(last('playback_metadata')).deep.include({
      ms: 800,
      wd: 1920,
      ht: 1080,
      n: 1
    })
    expect(last('playback_metadata')).not.to.have.property('dur')
    expect(sent.filter(row => row.event === 'playback_canplay')).length(1)
    expect(last('playback_first_frame')).deep.include({
      ms: 1200,
      pms: 28000,
      rl: 0,
      pr: false,
      pos: 600.25,
      be: 44.75
    })
    clock.tick(FIRST_FRAME_WAIT_MS)
    player.fire('progress')
    expect(last('playback_first_frame_missed')).equals(undefined)
  })

  it('says a player asked to play has shown nothing in thirty seconds', () => {
    const { player, clock, sent, last, session } = setup()
    clock.tick(FIRST_FRAME_WAIT_MS * 2)
    player.fire('progress')
    expect(last('playback_first_frame_missed')).equals(undefined)
    player.play().catch(() => undefined)
    session.recovery('reload', 1)
    session.refused()
    session.refused()
    clock.tick(FIRST_FRAME_WAIT_MS - 1)
    player.fire('progress')
    expect(last('playback_first_frame_missed')).equals(undefined)
    clock.tick(1)
    player.fire('progress')
    player.fire('progress')
    expect(last('playback_first_frame_missed')).deep.include({
      ms: FIRST_FRAME_WAIT_MS * 3,
      rl: 1,
      pr: true
    })
    expect(
      sent.filter(row => row.event === 'playback_first_frame_missed')
    ).length(1)
    expect(last('playback_error')).deep.include({ pr: true, ft: false })
  })

  it('counts the wait from attach for a player already playing, and says it at the latest on detach', () => {
    const player = new FakePlayer()
    player.paused = false
    const { clock, sent, session } = setup({}, player)
    clock.tick(FIRST_FRAME_WAIT_MS)
    session.detach()
    expect(sent.slice(-2).map(row => row.event)).deep.equals([
      'playback_first_frame_missed',
      'playback_detached'
    ])
  })

  it('times each stall after the first frame, and not the startup wait', () => {
    const { player, clock, sent, last } = setup()
    player.play().catch(() => undefined)
    player.fire('waiting')
    player.fire('timeupdate')
    player.advance(1)
    player.seekableEnd = 10
    player.fire('waiting')
    player.fire('waiting')
    clock.tick(1000)
    player.fire('playing')
    player.fire('waiting')
    clock.tick(500)
    player.advance(0.5)
    const started = sent.filter(row => row.event === 'playback_stall_started')
    expect(started).length(2)
    expect(started[0].level).equals('warn')
    expect(started[0].properties).deep.include({ sr: 'waiting', be: 9 })
    expect(
      sent
        .filter(row => row.event === 'playback_stall_ended')
        .map(row => row.properties.ms)
    ).deep.equals([1000, 500])
    expect(last('playback_stall_ended')).deep.include({ pos: 1.5 })
  })

  it('names each seek by the reason given just before it', () => {
    const { player, clock, sent } = setup()
    player.currentTime = 100
    player.seekableEnd = 150
    player.fire('timeupdate')
    markSeek(player, 'jump_to_present', true, clock.now())
    markSeek(player, 'scrub', false, clock.now())
    player.fire('seeking')
    player.fire('seeking')
    player.currentTime = 149
    player.fire('seeked')
    player.fire('seeked')
    markSeek(player, 'scrub', true, clock.now() - SEEK_MARK_MS - 1)
    player.fire('seeking')
    player.currentTime = 50
    player.fire('seeked')
    markSeek(player, 'seek_by', true, clock.now() - SEEK_MARK_MS - 1)
    markSeek(player, 'scrub', false, clock.now())
    player.fire('seeking')
    player.fire('seeked')
    const seeks = sent
      .filter(row => row.event === 'playback_seek')
      .map(row => row.properties)
    expect(seeks[0]).deep.include({
      sk: 'jump_to_present',
      fr: 100,
      to: 149,
      bb: 50,
      bf: 1
    })
    expect(seeks[1]).deep.include({ sk: 'other', fr: 149, to: 50 })
    expect(seeks[2]).deep.include({ sk: 'scrub' })
    expect(seeks).length(3)
  })

  it("does not count a seek's own buffering as a stall", () => {
    const { player, clock, sent } = setup()
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.advance(1)
    player.seekableEnd = 200
    markSeek(player, 'jump_to_present', true, clock.now())
    player.fire('seeking')
    player.fire('waiting')
    clock.tick(1500)
    player.currentTime = 190
    player.fire('seeked')
    player.fire('playing')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(0)
    expect(sent.filter(row => row.event === 'playback_seek')).length(1)
    // Once the seek is answered, buffering is a stall again.
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(1)
  })

  it('forgets a seek the player never answered', () => {
    const { player, clock, sent, session } = setup()
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.advance(1)
    player.fire('seeking')
    clock.tick(SEEK_STALE_MS + 1)
    // The position moves again and the next seek is reported.
    player.advance(1)
    player.fire('seeking')
    player.currentTime = 40
    player.fire('seeked')
    expect(sent.filter(row => row.event === 'playback_seek')).length(1)
    expect(
      sent.find(row => row.event === 'playback_seek')?.properties
    ).deep.include({ fr: 2, to: 40 })
    // A new source, or a reload, drops one too.
    player.fire('seeking')
    session.sourceSet()
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(1)
    player.fire('playing')
    player.fire('seeking')
    session.recovery('reload')
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(2)
    // Giving up keeps it: nothing will answer it either way.
    player.fire('playing')
    player.fire('seeking')
    session.recovery('give_up')
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(2)
  })

  it('keeps every duration inside the contract after a day attached', () => {
    const { player, clock, last, session } = setup()
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    clock.tick(25 * 3600000)
    player.advance(1)
    player.fire('waiting')
    clock.tick(25 * 3600000)
    session.detach()
    expect(last('playback_first_frame')?.ms).equals(86400000)
    expect(last('playback_stall_ended')?.ms).equals(86400000)
    expect(last('playback_detached')).deep.include({
      ms: 86400000,
      sms: 86400000
    })
  })

  it("sends a phone player's own throughput estimate as bandwidth, not bitrate", () => {
    const { player, clock, last } = setup({ engine: 'exoplayer' })
    player.bandwidthEstimate = 12_000_000
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    clock.tick(HEARTBEAT_MS)
    player.advance(1)
    const beat = last('playback_heartbeat')
    expect(beat).deep.include({ bw: 12_000_000 })
    expect(beat?.br).equals(undefined)
  })

  it("does not take a paused phone player's stop for a stall, and ends one on pause", () => {
    const { player, clock, sent } = setup({ engine: 'avplayer' })
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.advance(1)
    // The viewer pauses; the phone's player then says it is not playing.
    player.pause()
    player.fire('pause')
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(0)
    // A real stall, then a pause in the middle of it, ends it there.
    player.paused = false
    player.fire('play')
    player.fire('waiting')
    clock.tick(800)
    player.pause()
    player.fire('pause')
    clock.tick(60_000)
    player.fire('playing')
    expect(
      sent
        .filter(row => row.event === 'playback_stall_ended')
        .map(row => row.properties.ms)
    ).deep.equals([800])
  })

  it('does not count the jump a seek makes as playing, and lets playing end a phone seek', () => {
    const { player, clock, sent, last } = setup({ engine: 'exoplayer' })
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.fire('seeking')
    player.currentTime = 300
    clock.tick(400)
    player.fire('timeupdate')
    // No first frame from the jump itself.
    expect(sent.filter(row => row.event === 'playback_first_frame')).length(0)
    // The phone's player says it plays without a seeked.
    player.fire('playing')
    expect(last('playback_seek')).deep.include({ fr: 0, to: 300 })
    clock.tick(250)
    player.advance(0.25)
    expect(sent.filter(row => row.event === 'playback_first_frame')).length(1)
    expect(last('playback_detached')).equals(undefined)
  })

  it('starts the wait for a first frame again after a pause before it', () => {
    const { player, clock, sent } = setup()
    player.play().catch(() => undefined)
    clock.tick(5000)
    player.pause()
    player.fire('pause')
    clock.tick(FIRST_FRAME_WAIT_MS + 1)
    player.fire('progress')
    expect(
      sent.filter(row => row.event === 'playback_first_frame_missed')
    ).length(0)
    // Played again: the thirty seconds count from this play.
    player.play().catch(() => undefined)
    clock.tick(FIRST_FRAME_WAIT_MS - 1)
    player.fire('progress')
    expect(
      sent.filter(row => row.event === 'playback_first_frame_missed')
    ).length(0)
    clock.tick(2)
    player.fire('progress')
    expect(
      sent.filter(row => row.event === 'playback_first_frame_missed')
    ).length(1)
  })

  it("sends a phone player's stream bitrate as bitrate", () => {
    const { player, clock, last } = setup({ engine: 'avplayer' })
    ;(player as unknown as { streamBitrate: number }).streamBitrate = 4_300_000
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    clock.tick(HEARTBEAT_MS)
    player.advance(1)
    expect(last('playback_heartbeat')).deep.include({ br: 4_300_000 })
    expect(last('playback_heartbeat')?.bw).equals(undefined)
  })

  it('leaves distances behind live out of a recording', () => {
    const { player, last } = setup({ live: false, start: 'start' })
    player.seekableEnd = 600
    player.duration = 600
    player.currentTime = 10
    player.fire('seeking')
    player.fire('seeked')
    player.fire('loadedmetadata')
    expect(last('playback_seek')).not.to.have.property('bb')
    expect(last('playback_seek')).not.to.have.property('bf')
    expect(last('playback_metadata')).deep.include({ dur: 600 })
  })

  it('buckets errors by their source', () => {
    const web = setup()
    web.player.error = { code: 1 }
    web.player.fire('error')
    web.player.error = null
    web.player.fire('error')
    web.player.error = { code: 3 }
    web.player.fire('error')
    web.player.error = { code: 9 }
    web.player.fire('error')
    expect(
      web.sent
        .filter(row => row.event === 'playback_error')
        .map(row => [row.properties.ek, row.properties.cd, row.level])
    ).deep.equals([
      ['media_decode', 3, 'error'],
      ['unknown', 9, 'error']
    ])
    web.session.hlsError('networkError', 'fragLoadError', false)
    expect(web.last('playback_error')).deep.include({
      ek: 'hls_network',
      ed: 'frag_load_error',
      ft: false
    })

    const phone = setup({ engine: 'avplayer' })
    phone.player.lastError = {
      error: { code: -12660, domain: 'CoreMediaErrorDomain' }
    }
    phone.player.fire('error')
    expect(phone.last('playback_error')).deep.include({
      ek: 'avplayer',
      cd: -12660,
      ft: true
    })
    const android = setup({ engine: 'exoplayer' })
    android.player.lastError = { error: { errorCode: '2004' } }
    android.player.fire('error')
    expect(android.last('playback_error')).deep.include({
      ek: 'exoplayer',
      cd: 2004
    })
  })

  it('beats while playing, with what the player can say of itself', () => {
    const { player, clock, sent, session, last } = setup()
    clock.tick(HEARTBEAT_MS)
    player.fire('timeupdate')
    expect(last('playback_heartbeat')).equals(undefined)
    player.play().catch(() => undefined)
    player.currentTime = 10
    player.seekableEnd = 55
    player.buffered = {
      length: 2,
      start: index => [0, 9][index],
      end: index => [5, 14][index]
    }
    player.getVideoPlaybackQuality = () => ({
      droppedVideoFrames: 2,
      totalVideoFrames: 900
    })
    session.bandwidth(8_000_000)
    session.targetDuration(6)
    session.bitrate(4_000_000)
    session.bitrate(4_100_000)
    session.bitrate(0)
    session.bitrate(5_000_000)
    clock.tick(HEARTBEAT_MS - 1)
    player.fire('timeupdate')
    expect(last('playback_heartbeat')).equals(undefined)
    clock.tick(HEARTBEAT_MS)
    player.fire('timeupdate')
    expect(last('playback_heartbeat')).deep.include({
      rt: 1,
      bw: 8_000_000,
      br: 5_000_000,
      df: 2,
      tf: 900,
      pl: true,
      pos: 10,
      be: 45,
      ba: 4,
      td: 6
    })
    expect(
      sent
        .filter(row => row.event === 'playback_bitrate')
        .map(row => row.properties.br)
    ).deep.equals([4_000_000, 5_000_000])
    player.getVideoPlaybackQuality = () => {
      throw new Error('gone')
    }
    clock.tick(HEARTBEAT_MS)
    player.fire('timeupdate')
    expect(last('playback_heartbeat')).not.to.have.property('df')
  })

  it('counts reloads and closes with what the attachment amounted to', () => {
    const { player, clock, sent, session, last } = setup()
    player.play().catch(() => undefined)
    player.advance(1)
    clock.tick(500)
    player.advance(0.5)
    clock.tick(5000)
    player.advance(0.5)
    session.recovery('stall_reload')
    expect(last('playback_recovery')).deep.include({ rk: 'stall_reload', n: 1 })
    session.recovery('give_up', 4)
    expect(last('playback_recovery')).deep.include({ rk: 'give_up', n: 4 })
    expect(sent.at(-1)?.level).equals('error')
    player.fire('waiting')
    clock.tick(700)
    const listening = player.count()
    session.detach()
    session.detach()
    expect(last('playback_detached')).deep.include({
      wms: 2500,
      sc: 1,
      sms: 700,
      rl: 1,
      n: 0
    })
    expect(player.count()).equals(listening - 11)
    expect(playbackOf(player)).equals(undefined)
    const before = sent.length
    player.fire('waiting')
    session.recovery('reload')
    expect(sent.length).equals(before)
  })

  it('goes quiet past its caps but still says how it ended', () => {
    const { sent, session, last } = setup()
    for (let index = 0; index < PER_MINUTE_CAP + 10; index++)
      session.recovery('network_retry')
    expect(sent.filter(row => row.event === 'playback_recovery').length).equals(
      PER_MINUTE_CAP
    )
    session.detach()
    expect(last('playback_detached')).deep.include({ n: 10 })
    const many = setup()
    for (
      let minute = 0;
      minute * PER_MINUTE_CAP < SESSION_EVENT_CAP + 120;
      minute++
    ) {
      for (let index = 0; index < PER_MINUTE_CAP; index++)
        many.session.recovery('rejoin')
      many.clock.tick(60_000)
    }
    expect(many.sent.length).at.most(SESSION_EVENT_CAP + 1)
  })

  it('sends a stall even after heartbeats and non-fatal errors have spent their budget', () => {
    const { player, clock, sent, session } = setup()
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.advance(1)
    // A bad line: a flood of non-fatal errors, minute after minute.
    for (let minute = 0; minute < 20; minute++) {
      for (let index = 0; index < ROUTINE_PER_MINUTE_CAP + 5; index++)
        session.hlsError('mediaError', 'bufferStalledError', false)
      clock.tick(60_000)
    }
    const routine = sent.filter(
      row => row.event === 'playback_error' && row.properties.ft === false
    )
    expect(routine.length).equals(ROUTINE_SESSION_CAP)
    // The events the telemetry is for still go out.
    player.fire('waiting')
    session.hlsError('networkError', 'levelLoadError', true)
    session.recovery('reload')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(1)
    expect(
      sent.filter(
        row => row.event === 'playback_error' && row.properties.ft === true
      )
    ).length(1)
    expect(sent.filter(row => row.event === 'playback_recovery')).length(1)
  })

  it('counts every recovery that loads the source again, and gives no count it does not have', () => {
    const { sent, session, last } = setup()
    session.recovery('playlist_watch_reload')
    expect(last('playback_recovery')).deep.include({ n: 1 })
    session.recovery('reload')
    session.recovery('network_retry')
    expect(last('playback_recovery')?.n).equals(undefined)
    session.recovery('rejoin')
    expect(last('playback_recovery')?.n).equals(undefined)
    session.recovery('network_retry', 3)
    expect(last('playback_recovery')).deep.include({ n: 3 })
    session.detach()
    expect(last('playback_detached')).deep.include({ rl: 2 })
    expect(sent.filter(row => row.event === 'playback_recovery')).length(5)
  })

  it('keeps a scrub burst of seeks from crowding out the stall after it', () => {
    const { player, clock, sent } = setup({ surface: 'grid' })
    player.play().catch(() => undefined)
    player.fire('timeupdate')
    player.advance(1)
    // Four seeks a second for fifteen seconds, as a grid scrub sends them.
    for (let index = 0; index < 60; index++) {
      player.fire('seeking')
      player.currentTime = 10 + index
      player.fire('seeked')
      clock.tick(250)
    }
    expect(sent.filter(row => row.event === 'playback_seek')).length(
      SEEK_PER_MINUTE_CAP
    )
    player.fire('waiting')
    expect(sent.filter(row => row.event === 'playback_stall_started')).length(1)
    // A long session's seeks stop at their own cap.
    for (let minute = 0; minute < 20; minute++) {
      for (let index = 0; index < SEEK_PER_MINUTE_CAP; index++) {
        player.fire('seeking')
        player.fire('seeked')
      }
      clock.tick(60_000)
    }
    expect(sent.filter(row => row.event === 'playback_seek')).length(
      SEEK_SESSION_CAP
    )
  })

  it('never lets a failing reporter reach the player', () => {
    const player = new FakePlayer()
    const session = new PlaybackSession(
      player,
      { engine: 'hlsjs', surface: 'tile', live: false, start: 'start' },
      () => {
        throw new Error('queue full')
      },
      new ManualClock().now,
      () => ID
    )
    player.play().catch(() => undefined)
    player.advance(1)
    player.fire('waiting')
    expect(() => {
      session.detach()
    }).not.to.throw()
    expect(
      startPlayback(
        {
          addEventListener: () => {
            throw new Error('not a player')
          }
        } as unknown as VideoHandle,
        { engine: 'none', surface: 'other', live: false, start: 'start' },
        () => undefined,
        new ManualClock().now
      )
    ).equals(undefined)
  })

  it('starts with the real clock and reporter without holding a process open', () => {
    const player = new FakePlayer()
    const session = startPlayback(player, {
      engine: 'native',
      surface: 'card',
      live: false,
      start: 'start'
    })
    expect(session?.id).to.match(/^[0-9a-f-]{36}$/)
    session?.detach()
  })
})

describe('playback session helpers', () => {
  it('reads the video id from an address and never more', () => {
    expect(
      videoIdOf(
        'https://api.example.test/api/v1/videos/vid_demoLive0001/hls/index.m3u8?t=abc'
      )
    ).equals('vid_demoLive0001')
    expect(
      videoIdOf(
        'https://cdn.example/videos/vid_a-b_c-0123456789abcdef0123456789abcdef/index.m3u8'
      )
    ).equals('vid_a-b_c')
    expect(videoIdOf('https://cdn.example/videos/vid_x')).equals('vid_x')
    expect(videoIdOf('https://cdn.example/media/clip.m3u8')).equals(undefined)
    // PeerTube-stored videos, public and private.
    expect(
      videoIdOf(
        'https://api.example.test/media/1700000000/abc/peertube/vid_tube01/master.m3u8'
      )
    ).equals('vid_tube01')
    expect(
      videoIdOf(
        'https://api.example.test/media/1700000000/abc/peertube/private/vid_tube02/x/master.m3u8'
      )
    ).equals('vid_tube02')
    expect(
      videoIdOf('https://api.example.test/media/peertube/other/master.m3u8')
    ).equals(undefined)
  })

  it('names the surface and the start', () => {
    const tile = {}
    expect(surfaceOf(undefined)).equals('game')
    expect(surfaceOf({ buffer: { aheadSec: 5 } })).equals('tile')
    expect(surfaceOf({ preview: true })).equals('card')
    expect(surfaceOf({ surface: 'grid', preview: true })).equals('grid')
    nameSurface(tile, 'card')
    expect(surfaceOf(undefined, tile)).equals('card')
    expect(surfaceOf(undefined, {})).equals('game')
    const live = (): boolean => true
    expect(startOf(undefined)).equals('start')
    expect(startOf({ isLive: live })).equals('live_edge')
    expect(startOf({ isLive: live, startAtLiveEdge: false })).equals('position')
    expect(startOf({ startSec: 30 })).equals('position')
    // A grid places its live tiles itself.
    expect(startOf({ isLive: live, buffer: { aheadSec: 5 } })).equals(
      'position'
    )
    expect(startOf({ isLive: live, startSec: 120 })).equals('position')
    expect(startOf({ startAtLiveEdge: false })).equals('position')
  })

  it('measures what is buffered ahead on either platform', () => {
    const player = new FakePlayer()
    player.currentTime = 20
    expect(bufferedAheadOf(player)).equals(undefined)
    player.bufferedEnd = 32
    expect(bufferedAheadOf(player)).equals(12)
    player.bufferedEnd = Number.NaN
    expect(bufferedAheadOf(player)).equals(undefined)
    player.buffered = { length: 0, start: () => 0, end: () => 0 }
    expect(bufferedAheadOf(player)).equals(undefined)
    player.buffered = { length: 1, start: () => 40, end: () => 50 }
    expect(bufferedAheadOf(player)).equals(0)
  })

  it('maps platform error shapes and hls.js names', () => {
    expect(nativeErrorCode(undefined)).equals(undefined)
    expect(nativeErrorCode('boom')).equals(undefined)
    expect(nativeErrorCode({ error: 'boom' })).equals(undefined)
    expect(nativeErrorCode({ error: { code: 'x' } })).equals(undefined)
    expect(nativeErrorCode({ code: -1009 })).equals(-1009)
    expect(hlsDetail('bufferStalledError')).equals('buffer_stalled_error')
    expect(hlsDetail('somethingNew')).equals('other')
    expect(hlsDetail(3)).equals('other')
    expect(
      ['networkError', 'mediaError', 'muxError', 'keySystemError', 'other'].map(
        hlsKind
      )
    ).deep.equals([
      'hls_network',
      'hls_media',
      'hls_mux',
      'hls_key',
      'hls_other'
    ])
  })
})
