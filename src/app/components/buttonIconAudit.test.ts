import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import ts from 'typescript'

/** Catch new bypasses in real buttons, including non-font artwork. */
describe('button icon placement source audit', function () {
  it('routes button artwork through ButtonIcon', function () {
    const failures: string[] = []
    const vectorNames = new Set([
      'ControlIcon',
      'PitchIcon',
      'LineupQrGlyph',
      'AddPersonGlyph',
      'ScoringMenuIcon',
      'TransportMark'
    ])
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'tv') scan(file)
          continue
        }
        if (
          !file.endsWith('.tsx') ||
          /\.(test|spec|e2e)\./.test(file) ||
          entry.name === 'ButtonIcon.tsx'
        )
          continue
        const source = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        )
        function visit(node: ts.Node): void {
          let tag: string | undefined
          if (ts.isJsxSelfClosingElement(node))
            tag = node.tagName.getText(source)
          const textGlyph =
            ts.isJsxElement(node) &&
            node.openingElement.tagName.getText(source) === 'Text' &&
            node.children.every(child => ts.isJsxText(child)) &&
            /^(?:[☰×✕‹›✓↩]|•••)$/.test(
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
              if (ts.isJsxElement(parent)) {
                const parentTag = parent.openingElement.tagName.getText(source)
                if (
                  /Pressable|Touchable|ScoringPlayerCard|HeaderMenu/.test(
                    parentTag
                  )
                )
                  action = true
                if (parentTag === 'ButtonIcon') placed = true
              }
              parent = parent.parent
            }
            if (
              !placed &&
              (action ||
                textGlyph ||
                [
                  'ControlIcon',
                  'PitchIcon',
                  'TransportMark',
                  'ScoringMenuIcon'
                ].includes(tag ?? ''))
            )
              failures.push(
                `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
              )
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    scan('src/app')
    expect(failures).deep.equals([])
  })
})
