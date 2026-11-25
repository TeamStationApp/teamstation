import assert from 'node:assert/strict'
import { test } from 'node:test'

import convert from 'v8-to-istanbul'

import { measuredMappedLines } from './webPasswordLinkMappedCoverage.mjs'

test('an original line synthesized by the converter is absent from the measured ranges', async () => {
  const source = 'first();\nthird();'
  const file = '/fixture.ts'
  const map = {
    version: 3,
    sources: [file],
    sourcesContent: ['first();\nsecond();\nthird();'],
    names: [],
    mappings: 'AAAA;AAEA'
  }
  const script = {
    functions: [
      {
        functionName: '',
        isBlockCoverage: true,
        ranges: [
          { startOffset: 0, endOffset: source.length, count: 1 },
          { startOffset: 9, endOffset: source.length, count: 0 }
        ]
      }
    ]
  }
  const converter = convert('/fixture.js', 0, {
    source,
    sourceMap: { sourcemap: map }
  })
  await converter.load()
  converter.applyCoverage(script.functions)
  const entry = converter.toIstanbul()[file]
  assert.ok(
    Object.entries(entry.statementMap).some(
      ([key, span]) => span.start.line === 2 && entry.s[key] > 0
    )
  )
  assert.deepEqual(
    measuredMappedLines(map, source, [script], { [file]: new Set([1, 2, 3]) }),
    {
      [file]: { 1: 1, 3: 0 }
    }
  )
})

test('whitespace from a later statement cannot credit an unexecuted statement', () => {
  const source = 'first()\n  second()'
  const map = {
    version: 3,
    names: [],
    sources: ['a.ts', 'b.ts'],
    sourcesContent: ['first()', 'second()'],
    mappings: 'AAAA;AAAA,ECAA'
  }
  const functions = [
    {
      ranges: [
        { startOffset: 0, endOffset: source.length, count: 1 },
        { startOffset: 0, endOffset: 7, count: 0 }
      ]
    }
  ]
  assert.deepEqual(
    measuredMappedLines(map, source, [{ functions }], {
      'a.ts': new Set([1]),
      'b.ts': new Set([1])
    }),
    { 'a.ts': { 1: 0 }, 'b.ts': { 1: 1 } }
  )
})

test('a missing nested function counter cannot inherit the enclosing module count', () => {
  const source = 'function hidden() { return 1 }\nhidden()'
  const map = {
    version: 3,
    names: [],
    sources: ['a.js'],
    sourcesContent: [source],
    mappings: 'AAAA;AACA'
  }
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }
  ]
  assert.deepEqual(
    measuredMappedLines(map, source, [{ functions }], {
      'a.js': new Set([1, 2])
    }),
    { 'a.js': { 2: 1 } }
  )
})
