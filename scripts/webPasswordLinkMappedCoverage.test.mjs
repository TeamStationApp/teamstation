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
    measuredMappedLines(map, [8, 8], [script], { [file]: new Set([1, 2, 3]) }),
    {
      [file]: { 1: 1, 3: 0 }
    }
  )
})
