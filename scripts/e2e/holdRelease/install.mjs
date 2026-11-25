// Apply only to a disposable test-build checkout, before its normal native build.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { markControls } from './markControls.mjs'

const root = process.argv[2]
if (root == null) throw new Error('Pass the disposable test-build checkout')
const add = (path, suffix, edits) => {
  const target = resolve(root, path)
  let source = readFileSync(target, 'utf8')
  if (source.includes('class HoldInputStrip'))
    throw new Error('Overlay already installed')
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw new Error('Unexpected build source: ' + path)
    source = source.replace(before, after)
  }
  writeFileSync(
    target,
    source +
      '\n' +
      readFileSync(fileURLToPath(new URL(suffix, import.meta.url)), 'utf8')
  )
}
add('ios/TeamStation/SceneDelegate.swift', 'InputStrip.swift', [
  [
    '    window = app.window',
    '    window = app.window\n    if let window { HoldInputStrip.install(window) }'
  ]
])
add(
  'android/app/src/main/java/app/teamstation/app/MainActivity.kt',
  'InputStrip.kt',
  [
    [
      '  override fun onCreate',
      '  private val inputStrip by lazy { HoldInputStrip(this) }\n  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {\n    inputStrip.record(event)\n    return super.dispatchTouchEvent(event)\n  }\n\n  override fun onCreate'
    ],
    [
      '    super.onCreate(savedInstanceState)',
      '    super.onCreate(savedInstanceState)\n    inputStrip.install()'
    ]
  ]
)

markControls(root)
