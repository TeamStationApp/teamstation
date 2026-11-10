import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const OBSERVER = 'ios/Video/Features/RCTPlayerObserver.swift'

/** react-native-video 6.19.3's observer registrations, as published. */
const UNPATCHED = [
  'AVPlayerItemPlaybackStalled',
  'AVPlayerItemFailedToPlayToEndTime'
]
  .map((name, index) =>
    [
      '        NotificationCenter.default.removeObserver(_handlers,',
      `                                                  name: NSNotification.Name.${name},`,
      '                                                  object: nil)',
      '',
      '        NotificationCenter.default.addObserver(_handlers,',
      `                                               selector: #selector(RCTPlayerObserverHandler.${index === 0 ? 'handlePlaybackStalled' : 'handleDidFailToFinishPlaying'}(notification:)),`,
      `                                               name: NSNotification.Name.${name},`,
      '                                               object: nil)'
    ].join('\n')
  )
  .join('\n\n')

describe('native per-item notification patch', () => {
  it("observes only the player's own item, once, and rejects a changed dependency", () => {
    const root = mkdtempSync(join(tmpdir(), 'item-notifications-'))
    const observer = join(root, OBSERVER)
    mkdirSync(join(root, 'ios/Video/Features'), { recursive: true })
    const patch = (): void => {
      execFileSync(
        'ruby',
        [resolve('scripts/patch-video-item-notifications.rb'), root],
        { stdio: 'pipe' }
      )
    }
    try {
      writeFileSync(observer, UNPATCHED)
      const original = readFileSync(observer, 'utf8')
      patch()
      const once = readFileSync(observer, 'utf8')
      for (const name of [
        'AVPlayerItemPlaybackStalled',
        'AVPlayerItemFailedToPlayToEndTime'
      ]) {
        expect(once).contains(
          `name: NSNotification.Name.${name},\n                                               object: player?.currentItem)`
        )
      }
      // Removal still drops an earlier item's registration.
      expect(once.split('object: nil)').length).equals(
        original.split('object: nil)').length - 2
      )
      patch()
      expect(readFileSync(observer, 'utf8')).equals(once)
      writeFileSync(observer, 'changed dependency')
      expect(patch).throws('review the observers')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
