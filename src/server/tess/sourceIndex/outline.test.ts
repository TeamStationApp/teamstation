import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sourceSymbols } from './outline'

describe('source declaration outlines', () => {
  it('associates same-file export lists and aliases with their local declarations', () => {
    const content = [
      'export { answer, internal as publicName, Box as PublicBox, Shape as PublicShape, Mode as PublicMode, first as selected }',
      'const answer = 42',
      '/** A named export. */',
      'function internal() {}',
      'class Box {}',
      'interface Shape {}',
      'enum Mode { On }',
      'const [first, hidden] = input',
      'type LocalType = number',
      'export type { LocalType as PublicType }',
      'export const direct = 1',
      'export { direct, direct as alias }',
      'export { remote } from "./elsewhere"',
      'export * from "./elsewhere"',
      'export * as namespace from "./elsewhere"',
      'import { imported } from "./elsewhere"',
      'export { imported }'
    ].join('\n')
    const symbols = sourceSymbols('src/exports.ts', content)
    expect(symbols.map(s => [s.name, s.kind])).deep.equals([
      ['answer', 'const'],
      ['publicName', 'function'],
      ['PublicBox', 'class'],
      ['PublicShape', 'interface'],
      ['PublicMode', 'enum'],
      ['selected', 'const'],
      ['PublicType', 'type'],
      ['direct', 'const'],
      ['alias', 'const']
    ])
    expect(symbols[1]).includes({
      line: 4,
      endLine: 4,
      signature: 'function internal()',
      doc: 'A named export.'
    })
    expect(
      sourceSymbols(
        'src/alias.tsx',
        'const local = () => <div/>; export { local as Card }'
      )[0]
    ).includes({ name: 'Card', kind: 'component' })
    expect(
      sourceSymbols(
        'src/default.ts',
        'function local() {} export { local as default }'
      )[0]
    ).includes({ name: 'default', kind: 'function' })
  })
  it('records exported kinds, bound names, docs and exact line spans without bodies', () => {
    const content =
      '/** Adds a value. */\nexport function add(x: number) {\n return x + 1\n}\nexport class Box { value = 1 }\nexport interface Shape { x: number }\nexport type Size = number\nexport enum Mode { On }\nexport const a: number = 1, b = 2\nexport let mutable = 3\nexport var legacy = f()\nexport const { nested: { leaf }, ...rest } = input\nexport const [first, , last] = input\nconst hidden = 1\nexport default a\n'
    const symbols = sourceSymbols('src/a.ts', content)
    expect(symbols.map(s => [s.name, s.kind])).deep.equals([
      ['add', 'function'],
      ['Box', 'class'],
      ['Shape', 'interface'],
      ['Size', 'type'],
      ['Mode', 'enum'],
      ['a', 'const'],
      ['b', 'const'],
      ['mutable', 'let'],
      ['legacy', 'var'],
      ['leaf', 'const'],
      ['rest', 'const'],
      ['first', 'const'],
      ['last', 'const'],
      ['default', 'default']
    ])
    expect(symbols[0]).deep.equals({
      name: 'add',
      kind: 'function',
      line: 2,
      endLine: 4,
      signature: 'export function add(x: number)',
      doc: 'Adds a value.'
    })
    expect(symbols[1].signature).equals('export class Box')
    expect(symbols[2].signature).equals('export interface Shape')
    expect(symbols[4].signature).equals('export enum Mode')
    // A short literal stays; any other initializer is cut.
    // The first declaration keeps `export const`; a later one starts at its name.
    expect(symbols[5].signature).equals('export const a: number = 1')
    expect(symbols[6].signature).equals('b = 2')
    expect(symbols[8].signature).equals('export var legacy =')
    expect(symbols.every(s => !s.signature.includes('return'))).equals(true)
  })
  it('lists an overloaded function once and keeps short literal constants', () => {
    const overloads = sourceSymbols(
      'src/a.ts',
      'export function f(x: string): string\nexport function f(x: number): number\nexport function f(x: unknown) { return x }\nexport declare function g(x: string): void\nexport declare function g(x: number): void'
    )
    expect(overloads.map(s => [s.name, s.line, s.signature])).deep.equals([
      ['f', 3, 'export function f(x: unknown)'],
      ['g', 4, 'export declare function g(x: string): void']
    ])
    const signatures = sourceSymbols(
      'src/a.ts',
      [
        'export const MAX = 20',
        'export const NAME = "tess"',
        'export const NEGATIVE = -1',
        'export const READY = true as const',
        'export const EMPTY = null',
        'export const TEMPLATE = `plain`',
        'export const LONG = "' + 'x'.repeat(100) + '"',
        'export const CALL = make()'
      ].join('\n')
    ).map(s => s.signature)
    expect(signatures).deep.equals([
      'export const MAX = 20',
      'export const NAME = "tess"',
      'export const NEGATIVE = -1',
      'export const READY = true as const',
      'export const EMPTY = null',
      'export const TEMPLATE = `plain`',
      'export const LONG =',
      'export const CALL ='
    ])
  })
  it("keeps a function value's parameters and return type, and labels only PascalCase components", () => {
    const symbols = sourceSymbols(
      'src/a.tsx',
      [
        'export const useThing = (id: string): Thing => {\n  return find(id)\n}',
        'export const Card = function Card(props: Props) { return null }',
        'export const handler: Handler = async (req, res) => {}',
        'export const wrapped = (async (x: number) => x) as Fn',
        'export const memoized = memo(() => null)',
        'export const MAX_ITEMS = 20',
        'export const UI = 1'
      ].join('\n')
    )
    expect(symbols.map(s => [s.name, s.kind, s.signature])).deep.equals([
      ['useThing', 'const', 'export const useThing = (id: string): Thing =>'],
      ['Card', 'component', 'export const Card = function Card(props: Props)'],
      [
        'handler',
        'const',
        'export const handler: Handler = async (req, res) =>'
      ],
      ['wrapped', 'const', 'export const wrapped = (async (x: number) =>'],
      ['memoized', 'const', 'export const memoized ='],
      ['MAX_ITEMS', 'const', 'export const MAX_ITEMS = 20'],
      ['UI', 'const', 'export const UI = 1']
    ])
  })
  it('covers default declarations, components, recovery and bounded signatures/docs', () => {
    expect(
      sourceSymbols(
        'src/a.tsx',
        'export function Card() { return <div/> }\nexport const View = () => <div/>\nexport const lower = 1'
      ).map(s => s.kind)
    ).deep.equals(['component', 'component', 'const'])
    expect(
      sourceSymbols('src/a.jsx', 'export default function () {}')[0].name
    ).equals('default')
    expect(
      sourceSymbols('src/a.mts', 'export default class {}')[0].name
    ).equals('default')
    expect(sourceSymbols('src/a.cts', 'export = x')).length(0)
    expect(sourceSymbols('src/a.cjs', 'export const x=1')[0].name).equals('x')
    expect(sourceSymbols('src/a.mjs', 'export const x=1')[0].name).equals('x')
    expect(sourceSymbols('src/a.json', 'export const x=1')).length(0)
    expect(
      sourceSymbols(
        'src/a.ts',
        'export function recovered() {}\nexport const broken = ;'
      )[0].name
    ).equals('recovered')
    expect(
      sourceSymbols(
        'src/a.ts',
        '/** ' +
          'x'.repeat(700) +
          ' */\nexport declare function fn(' +
          'parameter: string,'.repeat(50) +
          '): void;'
      )[0]
    ).includes({ doc: 'x'.repeat(500) })
    expect(
      sourceSymbols(
        'src/a.ts',
        'export declare function fn(' +
          'parameter: string,'.repeat(50) +
          '): void;'
      )[0].signature
    ).length(300)
    expect(
      sourceSymbols('src/a.ts', 'export declare const value: string')[0]
        .signature
    ).equals('export declare const value: string')
    expect(
      sourceSymbols(
        'src/a.ts',
        '/** Read {@link Thing} now. */\nexport const x=1'
      )[0].doc
    ).includes('Read')
  })
})
