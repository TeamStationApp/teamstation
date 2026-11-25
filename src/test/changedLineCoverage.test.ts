import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  changedLines,
  executableLines,
  istanbulCounts,
  jacocoCounts,
  lcovCounts,
  lineReport,
  lineReportFromCounts,
  mappedV8LineCounts,
  withoutModuleDeclarationLines,
  resolveSpecs,
  withoutTriviaLines,
  withoutTypeOnlyLines,
  xccovCounts
} = require('../../scripts/changed-line-coverage.cjs')

describe('changed executable line coverage gate', function () {
  it('measures JSX props and cast values while omitting their erased syntax', () => {
    const source = [
      'const element = <Widget',
      '  prop={getValue()}',
      '/>',
      'render({',
      '  element',
      '} as unknown as Parameters<typeof render>[0])'
    ].join('\n')
    expect([...executableLines('component.tsx', source)]).deep.equals([
      1, 2, 4, 5
    ])
  })

  it('requires source expressions even when a report omits their statements', function () {
    const source = [
      'import { URL } from "url-parser"',
      'type Parser = typeof URL',
      '// The exported parser executes even without a reported statement.',
      'export const CacheUrl: Parser = URL',
      'export const ready = true',
      'declare const injectedAtBuild: string',
      ''
    ].join('\n')
    const required = executableLines('source.ts', source)
    expect([...required]).deep.equals([4, 5])
    const partial = istanbulCounts({
      statementMap: { a: { start: { line: 5 }, end: { line: 5 } } },
      s: { a: 1 }
    })
    const report = lineReportFromCounts(
      { 'source.ts': required },
      {
        'source.ts': Object.fromEntries(
          [...required].map(line => [line, partial[line] ?? 0])
        )
      },
      () => true,
      { min: 95, perFileMin: 95 }
    )
    expect(report).includes({ covered: 1, total: 2, percent: 50, pass: false })
    expect(report.files['source.ts'].uncovered).deep.equals([4])
  })

  it('selects hunk lines and excludes deleted-only hunks', function () {
    const rows = changedLines(
      '+++ b/a.ts\n@@ -1,2 +1,0 @@\n@@ -4 +3,2 @@\n+++ b/b.ts\n@@ -0,0 +1 @@'
    )
    expect([...rows['a.ts']]).deep.equals([3, 4])
    expect([...rows['b.ts']]).deep.equals([1])
  })
  it('gates uncovered and unmapped executable code and accepts covered/type-only code', function () {
    const changes = {
      'a.ts': new Set([1, 2, 3]),
      'new.ts': new Set([1]),
      'deleted.ts': new Set()
    }
    const coverage = {
      'a.ts': {
        statementMap: { a: { start: { line: 1 }, end: { line: 2 } } },
        s: { a: 1 }
      }
    }
    expect(lineReport(changes, coverage, () => true).pass).equals(false)
    const report = lineReport(changes, coverage, () => false)
    expect(report).includes({ covered: 2, total: 2, percent: 100, pass: true })
    coverage['a.ts'].s.a = 0
    expect(lineReport(changes, coverage, () => false).pass).equals(false)
  })
})

describe('compiler-proven erased TypeScript coverage lines', () => {
  const counts = (source: string): Record<number, number> =>
    Object.fromEntries(
      source.split('\n').map((_line, index) => [index + 1, index % 2])
    )

  it('removes covered and uncovered interface/alias lines without mutating the original counters', () => {
    const source = [
      'export interface Shape {',
      '  value: number',
      '}',
      'type Alias = Shape',
      'export const value = 1'
    ].join('\n')
    const original = counts(source)
    expect(withoutTypeOnlyLines('source.ts', source, original)).deep.equals({
      5: 0
    })
    expect(original).deep.equals({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 })
  })

  it('retains mixed type/runtime lines and an actual uncovered return', () => {
    const source = [
      'type Alias = number; export const value: Alias = 1',
      'export function get():',
      '  | {',
      '      value: number',
      '    }',
      '  | undefined {',
      '  return undefined',
      '}'
    ].join('\n')
    const original = Object.fromEntries(
      source.split('\n').map((_line, index) => [index + 1, index === 6 ? 0 : 1])
    )
    const actual = withoutTypeOnlyLines('source.ts', source, original)
    expect(actual).deep.equals({ 1: 1, 2: 1, 7: 0, 8: 1 })
    const report = lineReportFromCounts(
      { 'source.ts': new Set([1, 2, 3, 4, 5, 6, 7, 8]) },
      { 'source.ts': actual },
      () => true,
      { min: 95, perFileMin: 95 }
    )
    expect(report.pass).equals(false)
    expect(report.files['source.ts'].uncovered).deep.equals([7])
  })

  it('excludes erased import/export forms and specifiers, including trailing separators', () => {
    const source = [
      'import type Default, { A } from "./module"',
      'import {',
      '  type B, // annotation only',
      '  value,',
      '  type C as D',
      '} from "./module"',
      'export type { A }',
      'export {',
      '  type B,',
      '  value',
      '}',
      'import type Alias = require("./module")',
      'export type * from "./module"',
      'import type { X } from "./module"; run()'
    ].join('\n')
    expect(
      withoutTypeOnlyLines('source.ts', source, counts(source))
    ).deep.equals({
      2: 1,
      4: 1,
      6: 1,
      8: 1,
      10: 1,
      11: 0,
      14: 1
    })
  })

  it('excludes static linkage while retaining adjacent runtime statements', () => {
    const source = [
      'import { value } from "./module"',
      'import "./side-effect"',
      'export { value }',
      'export * from "./module"',
      'import { other } from "./module"; run(other)',
      'export default run(value)',
      'import Alias = require("./module")'
    ].join('\n')
    expect(
      withoutModuleDeclarationLines('source.ts', source, counts(source))
    ).deep.equals({
      5: 0,
      6: 1,
      7: 0
    })
  })

  it('excludes field type declarations while preserving initializers and computed names', () => {
    const source = [
      'class State {',
      '  private readonly value: string',
      '  ready = start();',
      '  [key()]: string',
      '}'
    ].join('\n')
    const raw = Object.fromEntries(
      source.split('\n').map((_line, i) => [i + 1, 1])
    )
    expect(withoutTypeOnlyLines('source.ts', source, raw)).deep.equals({
      1: 1,
      3: 1,
      4: 1,
      5: 1
    })
  })

  it('keeps executable class base expressions, enums and namespaces', () => {
    const source = [
      'class Child extends',
      '  factory(',
      '    { ready: true }',
      '  ) {}',
      'enum State {',
      '  Ready = makeValue()',
      '}',
      'namespace Values {',
      '  export const value = makeValue()',
      '}'
    ].join('\n')
    expect(
      withoutTypeOnlyLines('source.ts', source, counts(source))
    ).deep.equals(counts(source))
  })

  it('parses TSX without hiding JSX or a mixed annotation and initializer', () => {
    const source = [
      'type Props = { text: string }',
      'const element: Props = { text: "retained" }',
      'export const view = <div>{element.text}</div>'
    ].join('\n')
    expect(
      withoutTypeOnlyLines('source.tsx', source, counts(source))
    ).deep.equals({ 2: 1, 3: 0 })
  })

  it('keeps all counters when syntax is invalid or source is not TypeScript', () => {
    expect(
      withoutTypeOnlyLines('source.ts', 'type Broken = {', { 1: 0 })
    ).deep.equals({ 1: 0 })
    expect(
      withoutTypeOnlyLines('source.js', 'type Shape = number', { 1: 0 })
    ).deep.equals({ 1: 0 })
  })

  it('does not remove counters outside the source or on an ambiguous blank line', () => {
    const source = 'type Shape = {\n\n  value: number\n}'
    expect(
      withoutTypeOnlyLines('source.ts', source, {
        0: 0,
        1: 1,
        2: 0,
        3: 1,
        4: 1,
        9: 0
      })
    ).deep.equals({ 0: 0, 2: 0, 9: 0 })
  })
})

describe('runtime coverage excludes trivia', () => {
  it('does not let added comments or blank lines dilute an uncovered statement', () => {
    const source = [
      // eslint-disable-next-line no-template-curly-in-string -- source fixture
      'const value = `hello ${name}`',
      ...Array(100).fill('/** description */'),
      '',
      'missed()'
    ].join('\n')
    const original = Object.fromEntries(
      source.split('\n').map((_line, i) => [i + 1, i === 102 ? 0 : 1])
    )
    const counts = withoutTriviaLines('source.ts', source, original)
    expect(counts).deep.equals({ 1: 1, 103: 0 })
    for (const newFiles of [[], ['source.ts']]) {
      const report = lineReportFromCounts(
        { 'source.ts': new Set(Object.keys(original).map(Number)) },
        { 'source.ts': counts },
        () => true,
        { min: 95, perFileMin: 95, newFileMin: 95, newFiles }
      )
      expect(report).includes({
        covered: 1,
        total: 2,
        percent: 50,
        pass: false
      })
    }
    expect(original[2]).equals(1)
  })

  it('does not let closing punctuation dilute an uncovered statement', () => {
    const source = [
      'first(' + '('.repeat(99) + '0',
      ...Array(100).fill(')'),
      'missing()'
    ].join('\n')
    const raw = Object.fromEntries(
      source
        .split('\n')
        .map((_line, index) => [index + 1, index === 101 ? 0 : 1])
    )
    const filtered = withoutTriviaLines('source.ts', source, raw)
    expect(filtered).deep.equals({ 1: 1, 102: 0 })
    const report = lineReportFromCounts(
      { 'source.ts': new Set(Object.keys(raw).map(Number)) },
      { 'source.ts': filtered },
      () => true,
      { min: 95 }
    )
    expect(report.percent).equals(50)
    expect(report.pass).equals(false)
  })

  it('excludes plain parameter lines while preserving defaults, rest and expressions', () => {
    const source = [
      'function run(',
      '  plain: string,',
      '  fallback = read(),',
      '  ...rest: string[]',
      ') {',
      '  return [plain, fallback, ...rest]',
      '}'
    ].join('\n')
    const raw = Object.fromEntries(
      source.split('\n').map((_line, i) => [i + 1, 1])
    )
    expect(
      withoutTypeOnlyLines(
        'source.ts',
        source,
        withoutTriviaLines('source.ts', source, raw)
      )
    ).deep.equals({ 1: 1, 3: 1, 4: 1, 6: 1 })
  })

  it('retains strings, multiline literals and code beside comments', () => {
    const source = [
      '/** comment',
      ' * still comment */',
      'const text = `// literal',
      '/* also literal */`',
      '/* prefix */ run() // suffix',
      'const url = "https://example.test"',
      '  // only trivia',
      ' '
    ].join('\n')
    const counts = Object.fromEntries(
      source.split('\n').map((_line, i) => [i + 1, i])
    )
    expect(withoutTriviaLines('source.ts', source, counts)).deep.equals({
      3: 2,
      4: 3,
      5: 4,
      6: 5
    })
  })
  it('keeps nested template and regex contents while dropping surrounding trivia', () => {
    const source = [
      // eslint-disable-next-line no-template-curly-in-string -- source fixture
      'const value = `outer ${`inner ${name}`} ${',
      '  /* comment inside interpolation */',
      '  name',
      '}`',
      '// after template',
      '',
      'const pattern = /[/*]/',
      '/** documentation */',
      'const divided = amount / count',
      '// after division',
      'finish()'
    ].join('\n')
    const counts = Object.fromEntries(
      source.split('\n').map((_line, i) => [i + 1, i])
    )
    expect(withoutTriviaLines('source.ts', source, counts)).deep.equals({
      1: 0,
      3: 2,
      4: 3,
      7: 6,
      9: 8,
      11: 10
    })
  })
})

describe('native mapped V8 coverage evidence', () => {
  const source = 'first()\nsecond()'
  const map = {
    version: 3,
    sources: ['/src/native-a.ts', '/src/native-b.ts'],
    names: [],
    mappings: 'AAAA;ACAA',
    sourcesContent: ['first()', 'second()']
  }
  const required = {
    '/src/native-a.ts': new Set([1]),
    '/src/native-b.ts': new Set([1])
  }
  const scripts = [
    {
      functions: [
        { ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }
      ]
    }
  ]

  it('requires mappings and real counters for every scored native line', () => {
    expect(mappedV8LineCounts(source, map, scripts, required)).deep.equals({
      '/src/native-a.ts': { 1: 1 },
      '/src/native-b.ts': { 1: 1 }
    })
    expect(() => mappedV8LineCounts(source, map, [], required)).throws(
      'counter missing'
    )
    expect(() =>
      mappedV8LineCounts(
        source,
        { ...map, mappings: 'AAAA;A' },
        scripts,
        required
      )
    ).throws('native-b.ts:1')
  })

  it('rejects partial mapping loss within an otherwise measured source', () => {
    const sameSource = {
      ...map,
      sources: ['/src/native-a.ts'],
      sourcesContent: [source],
      mappings: 'AAAA;AACA'
    }
    const lines = { '/src/native-a.ts': new Set([1, 2]) }
    expect(mappedV8LineCounts(source, sameSource, scripts, lines)).deep.equals({
      '/src/native-a.ts': { 1: 1, 2: 1 }
    })
    expect(() =>
      mappedV8LineCounts(
        source,
        { ...sameSource, mappings: 'AAAA;A' },
        scripts,
        lines
      )
    ).throws('native-a.ts:2')
  })

  it('ignores whitespace boundary mappings from a following executed statement', () => {
    const generated = 'first()\n  second()'
    const boundaryMap = { ...map, mappings: 'AAAA;AAAA,ECAA' }
    const ranges = [
      {
        functions: [
          {
            ranges: [
              { startOffset: 0, endOffset: generated.length, count: 1 },
              { startOffset: 0, endOffset: 7, count: 0 }
            ]
          }
        ]
      }
    ]
    expect(
      mappedV8LineCounts(generated, boundaryMap, ranges, required)
    ).deep.equals({
      '/src/native-a.ts': { 1: 0 },
      '/src/native-b.ts': { 1: 1 }
    })
    expect(() =>
      mappedV8LineCounts(
        generated,
        {
          ...boundaryMap,
          mappings: ';AAAA,ECAA'
        },
        ranges,
        required
      )
    ).throws('native-a.ts:1')
  })

  it('does not borrow an outer count from an original end-of-expression mapping', () => {
    const generated = 'first();second()'
    const boundaryMap = {
      ...map,
      sources: ['/src/native-a.ts'],
      sourcesContent: ['first()'],
      mappings: 'AAAA,QAAO'
    }
    const ranges = [
      {
        functions: [
          {
            ranges: [
              { startOffset: 0, endOffset: generated.length, count: 1 },
              { startOffset: 0, endOffset: 7, count: 0 }
            ]
          }
        ]
      }
    ]
    expect(
      mappedV8LineCounts(generated, boundaryMap, ranges, {
        '/src/native-a.ts': new Set([1])
      })
    ).deep.equals({ '/src/native-a.ts': { 1: 0 } })
  })

  it('uses recorded generated tokens when a line-preserving compiler has imprecise columns', () => {
    const generated = '  throw error'
    const columnMap = {
      ...map,
      sources: ['/src/native-a.ts'],
      sourcesContent: [generated],
      mappings: 'AAAiB'
    }
    const ranges = [
      {
        functions: [
          {
            ranges: [{ startOffset: 0, endOffset: generated.length, count: 0 }]
          }
        ]
      }
    ]
    const lines = { '/src/native-a.ts': new Set([1]) }
    expect(
      mappedV8LineCounts(generated, columnMap, ranges, lines, {
        linePreserving: true
      })
    ).deep.equals({ '/src/native-a.ts': { 1: 0 } })
    expect(() =>
      mappedV8LineCounts(
        generated,
        {
          ...columnMap,
          sourcesContent: ['before()\n  throw error'],
          mappings: 'AACA'
        },
        ranges,
        { '/src/native-a.ts': new Set([2]) },
        {
          linePreserving: true
        }
      )
    ).throws('native-a.ts:2')
  })

  it('rejects a missing owning-function counter instead of borrowing the module count', () => {
    const generated = 'function hidden() { return 1 }\nhidden()'
    const end = generated.indexOf('\n')
    const functionMap = {
      ...map,
      sources: ['/src/native-a.ts'],
      sourcesContent: [generated],
      mappings: 'AAAA;AACA'
    }
    const moduleCounter = {
      ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }]
    }
    const functionCounter = {
      ranges: [{ startOffset: 0, endOffset: end, count: 0 }]
    }
    const lines = { '/src/native-a.ts': new Set([1, 2]) }
    expect(
      mappedV8LineCounts(
        generated,
        functionMap,
        [
          {
            functions: [moduleCounter, functionCounter]
          }
        ],
        lines
      )
    ).deep.equals({ '/src/native-a.ts': { 1: 0, 2: 1 } })
    expect(() =>
      mappedV8LineCounts(
        generated,
        functionMap,
        [
          {
            functions: [moduleCounter]
          }
        ],
        lines
      )
    ).throws('native-a.ts:1')
    // An unexecuted enclosing range is actual evidence of zero; V8 need not
    // instantiate a nested function that its containing code never reached.
    expect(
      mappedV8LineCounts(
        generated,
        functionMap,
        [
          {
            functions: [
              {
                ranges: [
                  { startOffset: 0, endOffset: generated.length, count: 0 }
                ]
              }
            ]
          }
        ],
        lines
      )
    ).deep.equals({ '/src/native-a.ts': { 1: 0, 2: 0 } })
  })

  it('rejects a missing parent function even when its nested callback shares a covered source line', () => {
    const generated = 'function hidden() { return (() => 1)() }\nhidden()'
    const functionMap = {
      ...map,
      sources: ['/src/native-a.ts'],
      sourcesContent: [generated],
      mappings: 'AAAA;AACA'
    }
    expect(() =>
      mappedV8LineCounts(
        generated,
        functionMap,
        [
          {
            functions: [
              {
                ranges: [
                  { startOffset: 0, endOffset: generated.length, count: 1 }
                ]
              },
              {
                ranges: [
                  {
                    startOffset: generated.indexOf('() =>'),
                    endOffset: generated.indexOf('1') + 1,
                    count: 1
                  }
                ]
              }
            ]
          }
        ],
        { '/src/native-a.ts': new Set([1]) }
      )
    ).throws('owning-function counter missing')
  })

  it('preserves an unexecuted block range as zero, not its enclosing count', () => {
    const withUncalled = [
      {
        functions: [
          {
            ranges: [
              ...scripts[0].functions[0].ranges,
              { startOffset: 8, endOffset: source.length, count: 0 }
            ]
          }
        ]
      }
    ]
    const counts = mappedV8LineCounts(source, map, withUncalled, required)
    expect(counts['/src/native-b.ts']).deep.equals({ 1: 0 })
    expect(
      lineReportFromCounts(required, counts, () => true, {
        min: 95,
        perFileMin: 95
      }).pass
    ).equals(false)
    expect(
      mappedV8LineCounts(source, map, [...withUncalled, ...scripts], required)[
        '/src/native-b.ts'
      ]
    ).deep.equals({ 1: 1 })
  })
})

describe('changed-line counts from every report', function () {
  it('keeps unit coverage at 90 while requiring 95 for combined coverage', () => {
    const lines = new Set(Array.from({ length: 100 }, (_, i) => i + 1))
    const counts = (
      covered: number
    ): Record<string, Record<number, number>> => ({
      'source.ts': Object.fromEntries(
        [...lines].map(line => [line, line <= covered ? 1 : 0])
      )
    })
    expect(
      lineReportFromCounts({ 'source.ts': lines }, counts(90), () => true).pass
    ).equals(true)
    expect(
      lineReportFromCounts({ 'source.ts': lines }, counts(94), () => true, {
        min: 95
      }).pass
    ).equals(false)
    expect(
      lineReportFromCounts({ 'source.ts': lines }, counts(95), () => true, {
        min: 95
      }).pass
    ).equals(true)
  })

  const fixture = (name: string): string =>
    readFileSync(`src/test/fixtures/coverage/${name}`, 'utf8')

  it('computes the percent, and fails under 90 overall or for a new file alone', function () {
    const changes = {
      'old.ts': new Set(Array.from({ length: 20 }, (_, i) => i + 1)),
      'new.ts': new Set([1, 2, 3, 4])
    }
    const counts: Record<string, Record<number, number>> = {
      'old.ts': Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [i + 1, 1])
      ),
      'new.ts': { 1: 1, 2: 1, 3: 0, 4: 1 }
    }
    const passing = lineReportFromCounts(changes, counts, () => true)
    expect(passing).includes({ covered: 23, total: 24, pass: true })
    expect(passing.percent).closeTo(95.83, 0.01)
    // The same numbers, with new.ts added on this branch: 75% alone fails.
    const added = lineReportFromCounts(changes, counts, () => true, {
      newFiles: ['new.ts']
    })
    expect(added.percent).closeTo(95.83, 0.01)
    expect(added.newFiles).deep.equals({ 'new.ts': 75 })
    expect(added.shortNewFiles).deep.equals(['new.ts'])
    expect(added.pass).equals(false)
    counts['old.ts'] = { 1: 0, 2: 0, 3: 0 }
    const under = lineReportFromCounts(changes, counts, () => true)
    expect(under.percent).closeTo(100 * (3 / 7), 0.01)
    expect(under.pass).equals(false)
  })

  it('lists a changed file with no record as missing, and ignores lines with no code', function () {
    const report = lineReportFromCounts(
      { 'a.ts': new Set([1, 2, 9]), 'b.ts': new Set([1]), 'c.ts': new Set() },
      { 'a.ts': { 1: 3, 2: 0 } },
      (path: string) => path === 'b.ts'
    )
    expect(report.missing).deep.equals(['b.ts'])
    expect(report.files['a.ts']).deep.equals({ covered: [1], uncovered: [2] })
    expect(report).includes({ covered: 1, total: 2, pass: false })
  })

  it('reads Istanbul as lineReport always has', function () {
    const entry = {
      statementMap: {
        a: { start: { line: 1 }, end: { line: 2 } },
        b: { start: { line: 2 }, end: { line: 2 } },
        c: { start: { line: 5 }, end: { line: 5 } }
      },
      s: { a: 0, b: 4, c: 0 }
    }
    expect(istanbulCounts(entry)).deep.equals({ 1: 0, 2: 4, 5: 0 })
    const changes = { 'x.ts': new Set([1, 2, 3, 5]) }
    const byEntry = lineReport(changes, { 'x.ts': entry }, () => true)
    const byCounts = lineReportFromCounts(
      changes,
      { 'x.ts': istanbulCounts(entry) },
      () => true
    )
    expect(byCounts).deep.equals(byEntry)
    expect(byEntry).includes({ covered: 1, total: 3 })
  })

  it('reads a recorded xccov file report and a recorded lcov report', function () {
    const source = '/repo/Tally/Sources/Tally/Tally.swift'
    const executable = {
      2: 1,
      3: 1,
      5: 1,
      6: 1,
      7: 1,
      8: 1,
      9: 0,
      10: 0,
      11: 1
    }
    expect(xccovCounts(JSON.parse(fixture('tally.xccov.json')))).deep.equals({
      [source]: executable
    })
    const lcov = lcovCounts(fixture('tally.lcov'))
    expect(lcov[source]).deep.equals(executable)
    expect(Object.keys(lcov)).has.length(3)
    expect(lcov['/repo/Tally/Tests/TallyTests/TallyTests.swift'][5]).equals(1)
  })

  it('reads a JaCoCo XML report by package directory, a line counting its covered instructions', function () {
    expect(jacocoCounts(fixture('tally.jacoco.xml'))).deep.equals({
      'app/example/tally/Tally.kt': { 5: 3, 6: 4, 7: 0, 9: 2 },
      'app/example/tally/Empty.kt': {},
      'Root.kt': { 1: 5 }
    })
    expect(jacocoCounts('<report></report>')).deep.equals({})
  })

  it('resolves pathspecs to the top level from anywhere inside it', function () {
    const top = '/repo'
    expect(resolveSpecs(top, ['mobile/apps/tsDirector'], top)).deep.equals([
      'mobile/apps/tsDirector'
    ])
    expect(
      resolveSpecs(top, ['.'], `${top}/mobile/apps/tsDirector`)
    ).deep.equals(['mobile/apps/tsDirector'])
    expect(
      resolveSpecs(
        top,
        ['../../common/DirectorCore'],
        `${top}/mobile/apps/tsDirector`
      )
    ).deep.equals(['mobile/common/DirectorCore'])
    expect(resolveSpecs(top, ['.'], top)).deep.equals(['.'])
  })
})
