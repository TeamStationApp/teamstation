// Give two existing controls a unique background in the measurement build so
// the video can identify their first presented frame over changing game footage.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function markControls(root) {
  for (const [name, anchor, color] of [
    [
      'GestureFeedback.tsx',
      '        styles.slowMo,',
      "{ backgroundColor: '#bb1be1' }"
    ],
    [
      'ZoneIcons.tsx',
      '              styles.circle,',
      "shown === 'play_arrow' ? { backgroundColor: '#18e49a' } : null"
    ]
  ]) {
    const path = resolve(root, 'src/app/player', name)
    const source = readFileSync(path, 'utf8')
    if (source.split(anchor).length !== 2)
      throw new Error('Unknown measurement target: ' + name)
    writeFileSync(path, source.replace(anchor, anchor + '\n' + color + ','))
  }
}
