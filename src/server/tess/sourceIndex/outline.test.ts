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
      '/** Adds a value. */\nexport function add(x: number) {\n return x + 1\n}\nexport class Box { value = 1 }\nexport interface Shape { x: number }\nexport type Size = number\nexport enum Mode { On }\nexport const a: number = 1, b = 2\nexport let mutable = 3\nexport const { nested: { leaf }, ...rest } = input\nexport const [first, , last] = input\nconst hidden = 1\nexport default a\n'
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
    expect(symbols[5].signature).equals('a: number =')
    expect(symbols.every(s => !s.signature.includes('return'))).equals(true)
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
    ).equals('value: string')
    expect(
      sourceSymbols(
        'src/a.ts',
        '/** Read {@link Thing} now. */\nexport const x=1'
      )[0].doc
    ).includes('Read')
  })
})
