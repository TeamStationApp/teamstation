import { expect } from 'chai'
import type { OnLoadData, VideoRef } from 'react-native-video'

import type { EventName, Property } from '../../common/observability/contract'
import { NativeVideoHandle } from '../player/nativeVideoHandle'
import type { VideoEventName, VideoHandle } from '../player/videoHandle'
import { watchPlayer } from './watchPlayer'

describe('Passive player analytics', () => {
  it('resumes counting after Android confirms a playing seek through progress alone', async () => {
    let time = 0
    const player = new NativeVideoHandle(
      () => {},
      () => time
    )
    const rows: Array<{
      event: EventName
      properties: Record<string, Property>
    }> = []
    const observer = watchPlayer(
      player,
      'vid_example',
      true,
      true,
      () => '00000000-0000-4000-8000-000000000001',
      (event, properties) => rows.push({ event, properties }),
      () => time
    )
    await player.play()
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    time += 2000
    player.currentTime = 50
    player.handlePlaybackState({ isPlaying: true, isSeeking: true })
    player.handleBuffer({ isBuffering: true })
    const progress = (currentTime: number): void => {
      player.handleProgress({
        currentTime,
        playableDuration: 100,
        seekableDuration: 100
      })
    }
    time += 5000
    progress(50)
    expect(player.actuallyPlaying).equals(false)
    player.handleBuffer({ isBuffering: false })
    progress(50.25)
    expect(player.actuallyPlaying).equals(true)
    time += 3000
    player.pause()
    progress(53.25)
    expect(player.actuallyPlaying).equals(false)
    observer.close()
    expect(
      rows
        .filter(x => x.event === 'watch_progress')
        .reduce((sum, x) => sum + Number(x.properties.ms), 0)
    ).equals(5000)
    expect(rows.filter(x => x.event === 'video_seeked')).length(1)
  })
  it('observes real native callbacks without treating intent as playback or multiplying angles', async () => {
    let time = 0
    const calls: string[] = []
    const player = new NativeVideoHandle(
      () => {},
      () => time
    )
    player.attach({
      seek: () => calls.push('seek'),
      resume: () => calls.push('resume')
    } as unknown as VideoRef)
    const load = {
      duration: 1000,
      currentTime: 0,
      naturalSize: { width: 100, height: 100 }
    }
    player.handleLoad(load as OnLoadData)
    const events: Array<{
      event: EventName
      properties: Record<string, Property>
    }> = []
    const observer = watchPlayer(
      player,
      'vid_example',
      true,
      true,
      () => '00000000-0000-4000-8000-000000000001',
      (event, properties) => events.push({ event, properties }),
      () => time
    )
    await player.play()
    time += 5000
    expect(events).length(0)
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    time += 10000
    player.handleBuffer({ isBuffering: true })
    time += 5000
    player.handleBuffer({ isBuffering: false })
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    time += 2000
    observer.foreground(false)
    time += 5000
    observer.foreground(true)
    time += 3000
    observer.select(false)
    time += 5000
    observer.select(true)
    player.currentTime = 200
    player.handlePlaybackState({ isPlaying: false, isSeeking: true })
    time += 5000
    // Progress may clear the pending seek before AVPlayer's completion arrives.
    player.handleProgress({
      currentTime: 200,
      playableDuration: 1000,
      seekableDuration: 1000
    })
    player.handleSeek({ currentTime: 200, seekTime: 200 })
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    player.playbackRate = 0.25
    time += 1000
    player.pause()
    time += 5000
    player.handleEnd()
    expect(
      events
        .filter(x => x.event === 'watch_progress')
        .reduce((n, x) => n + Number(x.properties.ms), 0)
    ).equals(16000)
    expect(events.map(x => x.event)).includes('video_completed')
    expect(events.filter(x => x.event === 'video_seeked')).length(1)
    expect(calls).deep.equals(['seek', 'resume'])
    await player.play()
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    time += 1000
    player.handleError({ error: {} })
    time += 1000
    player.reset()
    observer.close()
    const count = events.length
    player.handlePlaybackState({ isPlaying: true, isSeeking: false })
    expect(events).length(count)
  })

  it('handles browser media events, unknown live positions, source reset and replay', () => {
    let time = 0
    const listeners = new Map<string, () => void>()
    const player = {
      paused: false,
      readyState: 4,
      currentTime: NaN,
      playbackRate: Infinity,
      addEventListener: (name: string, fn: () => void) =>
        listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name)
    }
    const rows: Array<{
      event: EventName
      properties: Record<string, Property>
    }> = []
    const observer = watchPlayer(
      player as unknown as VideoHandle,
      'vid_example',
      false,
      false,
      () => '00000000-0000-4000-8000-000000000001',
      (event, properties) => rows.push({ event, properties }),
      () => time
    )
    const fire = (event: VideoEventName): void => {
      listeners.get(event)!()
    }
    time += 10000
    observer.select(true)
    observer.foreground(true)
    fire('playing')
    player.currentTime = 2
    player.playbackRate = -0.25
    fire('timeupdate')
    time += 1000
    fire('seeking')
    time += 5000
    fire('seeked')
    player.paused = true
    player.currentTime = 20
    fire('seeking')
    fire('seeking')
    fire('seeked')
    player.currentTime = 40
    fire('seeking')
    fire('seeked')
    expect(rows.filter(x => x.event === 'video_seeked')).length(3)
    player.paused = false
    fire('playing')
    time += 2000
    fire('ended')
    fire('playing')
    time += 1000
    fire('emptied')
    observer.close()
    expect(
      rows
        .filter(x => x.event === 'watch_progress')
        .reduce((n, x) => n + Number(x.properties.ms), 0)
    ).equals(4000)
    expect(rows.some(x => x.event === 'video_completed')).equals(true)
    expect(rows.some(x => x.properties.rt === -0.25)).equals(true)
    expect(listeners.size).equals(0)
  })
})
