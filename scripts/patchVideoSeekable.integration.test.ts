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

describe('native seekable-window patch', () => {
  it('adds native endpoints and bridge fields once and rejects a changed dependency', () => {
    const root = mkdtempSync(join(tmpdir(), 'seekable-patch-'))
    const native = join(root, 'ios/Video/RCTVideo.swift')
    const spec = join(root, 'src/specs/VideoNativeComponent.ts')
    mkdirSync(join(root, 'ios/Video'), { recursive: true })
    mkdirSync(join(root, 'src/specs'), { recursive: true })
    const patch = (): void => {
      execFileSync('ruby', [resolve('scripts/patch-video-seekable.rb'), root], {
        stdio: 'pipe'
      })
    }
    try {
      writeFileSync(
        native,
        '"seekableDuration": RCTVideoUtils.calculateSeekableDuration(_player),'
      )
      writeFileSync(spec, '  seekableDuration: Float;')
      patch()
      const once = [readFileSync(native, 'utf8'), readFileSync(spec, 'utf8')]
      expect(once[0]).contains('CMTimeRangeGetEnd')
      expect(once[0]).contains('seekableStart')
      expect(once[1]).contains('seekableEnd?: Float')
      patch()
      expect([
        readFileSync(native, 'utf8'),
        readFileSync(spec, 'utf8')
      ]).deep.equals(once)
      writeFileSync(native, 'changed dependency')
      expect(patch).throws('review seekable bounds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
