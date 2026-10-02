import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { MODAL_ORIENTATIONS } from './modalOrientations'

/** Every `<Modal …>` opening tag in the scoring and walk-up screens. */
function modalTags(): Array<{ file: string; tag: string }> {
  const tags: Array<{ file: string; tag: string }> = []
  for (const dir of [__dirname, join(__dirname, '../walkup')])
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tsx') || name.includes('.test.')) continue
      const source = readFileSync(join(dir, name), 'utf8')
      for (const match of source.matchAll(/<Modal\b[^>]*>/g))
        tags.push({ file: name, tag: match[0] })
    }
  return tags
}

describe('scoring modals', function () {
  it('run in portrait only, as the phone app does', function () {
    expect(MODAL_ORIENTATIONS).deep.equals(['portrait'])
    const tags = modalTags()
    // The sheets, the More and Ball in Play drop menus, and a dictation
    // question.
    expect(tags.map(tag => tag.file).sort()).deep.equals([
      'DictationButton.tsx',
      'DropMenuView.tsx',
      'ScoringSheet.tsx'
    ])
    for (const { file, tag } of tags)
      expect(tag, file).includes('supportedOrientations={MODAL_ORIENTATIONS}')
  })
})
