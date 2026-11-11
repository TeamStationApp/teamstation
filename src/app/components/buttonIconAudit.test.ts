import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import ts from 'typescript'

// Every unwrapped icon is explicitly classified, including artwork passed through
// variables, object properties and helper arguments. New uses fail closed.
const decorative: Record<string, string> = {
  'player/GestureFeedback.tsx:Icon': 'Non-interactive gesture feedback',
  'walkup/WalkUpSongScreen.tsx:Icon': 'File metadata preview',
  'walkup/DjLineupRow.tsx:Icon': 'Read-only branch when onEdit is absent',
  'walkup/AppleMusicSetup.tsx:Icon': 'Setup illustration',
  'scoring/ScoringPlayerSearchField.tsx:Icon': 'Search input decoration',
  'chat/ConversationScreen.tsx:Icon': 'Encryption status',
  'stream/StreamEmptyState.tsx:Icon': 'Empty state illustration',
  'chat/Composer.tsx:Icon': 'Attachment metadata',
  'tess/TessMessage.tsx:Icon': 'Attachment metadata',
  'components/VideoPoster.tsx:Icon': 'Missing poster placeholder',
  'tess/TessChat.tsx:Icon': 'Assistant identity',
  'tess/AttachPanel.tsx:Icon': 'Attachment metadata',
  'tess/TessThinking.tsx:Icon': 'Failure status',
  'components/PlacePhoto.tsx:Icon': 'Missing photo placeholder',
  'components/Emblem.tsx:Icon': 'Identity emblem',
  'components/PlayerSearchField.tsx:Icon': 'Search input decoration',
  'components/TextField.tsx:Icon': 'Input decoration',
  'umpires/UmpireLeaderboardView.tsx:UmpireMaskDrawing': 'Leaderboard identity',
  'scoring/LineupShareSheet.tsx:LineupQrGlyph': 'QR preview'
}
function unplaced(file: string, text: string): string[] {
  const failures: string[] = []
  const classified = new Set<string>()
  const vectorNames = new Set([
    'ControlIcon',
    'PitchIcon',
    'LineupQrGlyph',
    'AddPersonGlyph',
    'ScoringMenuIcon',
    'TransportMark',
    'StreamGlyph',
    'UmpireMaskDrawing'
  ])
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  function visit(node: ts.Node): void {
    let tag: string | undefined
    if (ts.isJsxSelfClosingElement(node)) tag = node.tagName.getText(source)
    const textGlyph =
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(source) === 'Text' &&
      node.children.every(child => ts.isJsxText(child)) &&
      /^(?:[☰×✕‹›✓↩…＋+⌖✎]|•••)$/.test(
        node.children
          .map(child => (ts.isJsxText(child) ? child.text.trim() : ''))
          .join('')
      )
    if (
      tag === 'Icon' ||
      tag === 'TsMark' ||
      vectorNames.has(tag ?? '') ||
      textGlyph
    ) {
      let parent = node.parent
      let action = false
      let placed = false
      while (parent != null) {
        if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) {
          const opening = ts.isJsxElement(parent)
            ? parent.openingElement
            : parent
          const parentTag = opening.tagName.getText(source)
          if (
            /Pressable|Touchable|ScoringPlayerCard|HeaderMenu/.test(parentTag)
          )
            action = true
          if (
            parentTag === 'ListRow' &&
            opening.attributes.properties.some(
              attribute =>
                ts.isJsxAttribute(attribute) &&
                attribute.name.getText(source) === 'onPress'
            )
          )
            action = true
          if (parentTag === 'ButtonIcon') placed = true
        }
        parent = parent.parent
      }
      const classification = decorative[`${file}:${tag}`]
      const selectionStatus =
        tag === 'Icon' &&
        ['chat/IncludeAdultSheet.tsx', 'chat/NewDmScreen.tsx'].includes(file) &&
        ts.isJsxSelfClosingElement(node) &&
        node.attributes.properties.some(
          attribute =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === 'name' &&
            attribute.initializer != null &&
            ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text === 'star'
        )
      const key = `${file}:${tag}`
      const exempt = selectionStatus || (!action && classification != null)
      if (!placed && (!exempt || classified.has(key)))
        failures.push(
          `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
        )
      if (!placed && exempt) classified.add(key)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return failures
}

describe('button icon placement source audit', function () {
  it('routes button artwork through ButtonIcon', function () {
    const failures: string[] = []
    function scan(directory: string): void {
      for (const entry of readdirSync(join('src/app', directory), {
        withFileTypes: true
      })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'tv') scan(file)
        } else if (
          file.endsWith('.tsx') &&
          !/\.(test|spec|e2e)\./.test(file) &&
          entry.name !== 'ButtonIcon.tsx'
        ) {
          failures.push(
            ...unplaced(file, readFileSync(join('src/app', file), 'utf8'))
          )
        }
      }
    }
    scan('')
    expect(failures).deep.equals([])
  })
  it('rejects unwrapped glyphs even through variables, props and helper arguments', function () {
    for (const glyph of ['…', '＋', '+', '⌖', '✎', '‹', '›']) {
      const icon = `<Text>${glyph}</Text>`
      for (const text of [
        `const chevron = ${icon}; <ActionRow chevron={chevron} />`,
        `<ActionRow chevron={${icon}} />`,
        `const entries = [{icon: ${icon}}]; <HeaderMenu entries={entries} />`,
        `button('More', ${icon})`
      ])
        expect(unplaced('example.tsx', text), text).has.length(1)
    }
    expect(
      unplaced(
        'example.tsx',
        'const details = <Icon name="music_note"/>; <Pressable>{details}</Pressable>'
      )
    ).has.length(1)
    expect(
      unplaced(
        'example.tsx',
        'const details = <ButtonIcon name="music_note"/>; <Pressable>{details}</Pressable>'
      )
    ).has.length(0)
  })
})
