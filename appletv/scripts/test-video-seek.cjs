const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { strict: assert } = require('node:assert')
const sourcePath =
  'appletv/node_modules/react-native-video/ios/Video/Features/RCTPlayerOperations.swift'
execFileSync('ruby', ['appletv/scripts/patch-video-seek.rb', sourcePath])
const source = readFileSync(sourcePath, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'tv-native-seek-'))
try {
  // Compile the actual dependency method against AVFoundation, not a mock.
  const method = source.slice(
    source.indexOf('    static func seek('),
    source.lastIndexOf('}')
  )
  writeFileSync(
    join(dir, 'test.swift'),
    `import AVFoundation\nenum Operations {\n${method}\n}\nlet item = AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent.mp4"))\nlet player = AVPlayer(playerItem: item)\nvar acknowledged = false\nOperations.seek(player: player, playerItem: item, paused: true, seekTime: Float(CMTimeGetSeconds(item.currentTime())), seekTolerance: 0) { done in acknowledged = done }\nprecondition(acknowledged, "native no-op must acknowledge")\nprint("native no-op acknowledged")\n`
  )
  assert.match(
    execFileSync('swift', [join(dir, 'test.swift')], { encoding: 'utf8' }),
    /native no-op acknowledged/
  )
  // Reapplying is harmless; an upgraded incompatible implementation fails closed.
  execFileSync('ruby', ['appletv/scripts/patch-video-seek.rb', sourcePath])
  writeFileSync(join(dir, 'changed.swift'), 'changed implementation')
  assert.throws(() =>
    execFileSync(
      'ruby',
      ['appletv/scripts/patch-video-seek.rb', join(dir, 'changed.swift')],
      { stdio: 'pipe' }
    )
  )
  console.log('Native seek acknowledgement and patch compatibility passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
