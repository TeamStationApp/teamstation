import { expect } from 'chai'
import { describe, it } from 'mocha'

import { seekTo } from './explicitSeek'
import { joinLiveOnFirstPlay } from './liveStart'
import { seekBy } from './zones'

function fixture(): {
  video: HTMLVideoElement
  emit: (name: string) => void
  ranges: (values: Array<[number, number]>) => void
  pause: (paused: boolean) => void
  detach: () => void
} {
  const video = document.createElement('video')
  let paused = false
  let values: Array<[number, number]> = []
  Object.defineProperty(video, 'paused', { get: () => paused })
  Object.defineProperty(video, 'seekable', {
    get: () => ({
      length: values.length,
      start: (index: number) => values[index][0],
      end: (index: number) => values[index][1]
    })
  })
  return {
    video,
    emit: name => video.dispatchEvent(new window.Event(name)),
    ranges: next => {
      values = next
    },
    pause: next => {
      paused = next
    },
    detach: joinLiveOnFirstPlay(video)
  }
}

describe('joining the latest footage on first play', function () {
  it('uses the latest seekable end rather than the browser default position', function () {
    const f = fixture()
    f.video.currentTime = 240
    f.ranges([[0, 7200]])
    f.emit('loadedmetadata')
    expect(f.video.currentTime).equals(240)
    f.emit('play')
    expect(f.video.currentTime).equals(7140)
    f.detach()
  })

  it('uses the current live end when play is delayed after opening the page', function () {
    const f = fixture()
    f.ranges([[0, 600]])
    f.emit('loadedmetadata')
    f.ranges([[0, 900]])
    f.emit('play')
    expect(f.video.currentTime).equals(840)
    f.detach()
  })

  it('waits for metadata and seekable ranges when play arrives first', function () {
    for (const event of [
      'loadedmetadata',
      'durationchange',
      'progress',
      'canplay'
    ]) {
      const f = fixture()
      f.emit('play')
      expect(f.video.currentTime).equals(0)
      f.ranges([[0, 600]])
      f.emit(event)
      expect(f.video.currentTime).equals(540)
      f.detach()
    }
  })

  it('clamps a short stream to available footage and uses the last seekable range', function () {
    const f = fixture()
    f.ranges([
      [0, 20],
      [100, 120]
    ])
    f.emit('play')
    expect(f.video.currentTime).equals(100)
    f.detach()
  })

  it('waits through invalid ranges and a pause before the metadata arrives', function () {
    const f = fixture()
    f.ranges([[0, Infinity]])
    f.emit('play')
    f.ranges([[10, 10]])
    f.emit('progress')
    expect(f.video.currentTime).equals(0)
    f.pause(true)
    f.ranges([[0, 600]])
    f.emit('canplay')
    expect(f.video.currentTime).equals(0)
    f.pause(false)
    f.emit('play')
    expect(f.video.currentTime).equals(540)
    f.detach()
  })

  it('does not move a rewind, pause/resume, or subsequent playlist update', function () {
    const f = fixture()
    f.ranges([[0, 600]])
    f.emit('play')
    f.video.currentTime = 100
    f.ranges([[0, 900]])
    f.emit('progress')
    f.emit('play')
    expect(f.video.currentTime).equals(100)
    f.detach()
  })

  it('honors a highlight selected before the first play or metadata', function () {
    const f = fixture()
    seekTo(f.video, 300)
    f.emit('play')
    f.ranges([[0, 7200]])
    f.emit('loadedmetadata')
    expect(f.video.currentTime).equals(300)
    f.detach()
    // Seeks also work after the initial-join listener is removed.
    seekTo(f.video, 200)
    expect(f.video.currentTime).equals(200)
  })

  it('honors a seek gesture before the first play', function () {
    const f = fixture()
    f.video.currentTime = 300
    f.ranges([[0, 7200]])
    seekBy(f.video, -10)
    f.emit('play')
    expect(f.video.currentTime).equals(290)
    f.detach()
  })

  it('honors browser-control seeks following pointer or keyboard input', function () {
    for (const input of ['pointerdown', 'keydown']) {
      const f = fixture()
      f.ranges([[0, 7200]])
      f.emit(input)
      f.video.currentTime = 300
      f.emit('seeking')
      f.emit('play')
      expect(f.video.currentTime).equals(300)
      f.detach()
    }
  })

  it('still joins fresh footage after an engine seek or a Play-button press', function () {
    const f = fixture()
    f.ranges([[0, 600]])
    f.video.currentTime = 540
    f.emit('seeking')
    f.ranges([[0, 900]])
    f.emit('pointerdown')
    f.emit('play')
    expect(f.video.currentTime).equals(840)
    f.detach()
  })

  it('removes every pending listener when the player detaches', function () {
    const f = fixture()
    f.emit('play')
    f.detach()
    f.ranges([[0, 600]])
    for (const event of [
      'play',
      'pointerdown',
      'keydown',
      'seeking',
      'loadedmetadata',
      'durationchange',
      'progress',
      'canplay'
    ])
      f.emit(event)
    expect(f.video.currentTime).equals(0)
  })
})
