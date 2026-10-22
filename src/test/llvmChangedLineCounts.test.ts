import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  snapshot,
  verifySnapshot,
  measuredCounts,
  convert,
  validateCounts,
  main
} = require('../../scripts/llvm-changed-line-counts.cjs')
const gate = require('../../scripts/changed-line-check.cjs')

function fixture(): {
  root: string
  git: (args: string[]) => string
  manifest: ReturnType<typeof snapshot>
  record: (rows?: string) => string
  lcov: string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'llvm-counts-')))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['init', '--quiet'])
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'Fixture baseline'
  ])
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.rs'), 'fn value() {\n  let x = 1;\n  x\n}\n')
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="example"\n')
  const manifest = snapshot(root, ['src', 'Cargo.toml'])
  const record = (rows = 'DA:1,2\nDA:2,0\nLF:2\nLH:1'): string =>
    `SF:${root}/src/a.rs\n${rows}\nend_of_record\n`
  const lcov = join(root, 'measured.lcov')
  writeFileSync(lcov, record())
  utimesSync(lcov, new Date(), new Date(manifest.capturedAt + 10))
  return { root, git, manifest, record, lcov }
}

describe('measured LLVM changed-line counters', function () {
  it('binds measured zero and positive counts to exact source and report bytes', function () {
    const f = fixture()
    const result = convert(f.manifest, f.lcov)
    expect(result.counts).deep.equals({ 'src/a.rs': { 1: 2, 2: 0 } })
    expect(validateCounts(result, f.root)).deep.equals(result.counts)
    const envelope = join(f.root, 'counts.json')
    writeFileSync(envelope, JSON.stringify(result))
    f.git(['add', 'src/a.rs'])
    const code = gate.main(
      [
        '--base',
        'HEAD',
        '--counts',
        envelope,
        '--min',
        '95',
        '--ext',
        '.rs',
        'src'
      ],
      {
        cwd: f.root,
        run: (_file: string, args: string[]) => f.git(args),
        log: () => {}
      }
    )
    expect(code).equals(1)
    result.counts['src/a.rs'][2] = 10
    expect(() => validateCounts(result, f.root)).throws('counters changed')
  })

  it('combines repeated source records by measured line counts and accepts LLVM metadata', function () {
    const f = fixture()
    const text =
      'TN:\nFN:1,value\nFNDA:2,value\nFNF:1\nFNH:1\nBRF:0\nBRH:0\n' +
      f.record() +
      f.record('DA:1,0\nDA:2,3\nLF:2\nLH:1')
    expect(
      measuredCounts(text.replaceAll('\n', '\r\n'), f.manifest)
    ).deep.equals({ 'src/a.rs': { 1: 2, 2: 3 } })
    expect(
      measuredCounts(f.record('DA:1,1,checksum\nLF:1\nLH:1'), f.manifest)
    ).deep.equals({ 'src/a.rs': { 1: 1 } })
  })

  it('rejects incomplete, inconsistent, negative, nonfinite and duplicate measurements', function () {
    const f = fixture()
    for (const text of [
      '',
      'DA:1,1\n',
      'LF:1\n',
      'end_of_record\n',
      'unknown:1\n',
      f.record().replace('end_of_record\n', ''),
      `SF:${f.root}/src/a.rs\n${f.record()}`,
      f.record('DA:0,1\nLF:1\nLH:1'),
      f.record('DA:1,-1\nLF:1\nLH:0'),
      f.record('DA:1,NaN\nLF:1\nLH:0'),
      f.record('DA:1,9007199254740992\nLF:1\nLH:1'),
      f.record('DA:9007199254740992,1\nLF:1\nLH:1'),
      f.record('DA:99,1\nLF:1\nLH:1'),
      f.record('DA:1,1\nDA:1,1\nLF:1\nLH:1'),
      f.record('DA:1,1\nLF:2\nLH:1'),
      f.record('DA:1,0\nLF:1\nLH:1'),
      f.record('DA:1,1\nLF:1'),
      f.record('DA:1,1\nLH:1'),
      f.record('DA:1,1\nLF:1\nLF:1\nLH:1'),
      f.record('DA:1,1\nLF:1\nLH:1\nLH:1'),
      f.record('DA:1,1\nLF:9007199254740992\nLH:1'),
      f.record('DA:1,1\nLF:NaN\nLH:1'),
      f.record('LF:0\nLH:0')
    ])
      expect(() => measuredCounts(text, f.manifest), text).throws()
  })

  it('rejects stale reports, edited source, newly added source and changed revisions', function () {
    const f = fixture()
    utimesSync(f.lcov, new Date(1), new Date(1))
    expect(() => convert(f.manifest, f.lcov)).throws('predates')
    utimesSync(f.lcov, new Date(), new Date(f.manifest.capturedAt + 10))
    const envelope = convert(f.manifest, f.lcov)
    writeFileSync(f.lcov, f.record('DA:1,3\nDA:2,0\nLF:2\nLH:1'))
    expect(() => validateCounts(envelope, f.root)).throws(
      'report or counters changed'
    )
    const original = readFileSync(join(f.root, 'src/a.rs'))
    writeFileSync(join(f.root, 'src/a.rs'), 'changed')
    expect(() => verifySnapshot(f.manifest, f.root)).throws('source changed')
    writeFileSync(join(f.root, 'src/a.rs'), original)
    writeFileSync(join(f.root, 'src/new.rs'), 'fn added() {}')
    expect(() => verifySnapshot(f.manifest, f.root)).throws('source changed')
    const current = snapshot(f.root, ['src', 'Cargo.toml'])
    f.git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Next fixture revision'
    ])
    expect(() => verifySnapshot(current, f.root)).throws('source changed')
  })

  it('rejects unknown source paths, foreign roots, escaping symlinks and invalid manifests', function () {
    const f = fixture()
    const other = fixture()
    expect(() =>
      measuredCounts(
        `SF:${f.root}/Cargo.toml\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`,
        f.manifest
      )
    ).not.throws()
    writeFileSync(join(f.root, 'not-captured.rs'), 'fn missing() {}')
    expect(() =>
      measuredCounts(
        f.record().replace('src/a.rs', 'not-captured.rs'),
        f.manifest
      )
    ).throws('Unmapped')
    expect(() =>
      measuredCounts(f.record().replace(f.root, other.root), f.manifest)
    ).throws('Unmapped')
    expect(() => verifySnapshot(f.manifest, other.root)).throws(
      'source changed'
    )
    for (const manifest of [undefined, {}, { ...f.manifest, capturedAt: 0 }])
      expect(() => verifySnapshot(manifest, f.root)).throws(
        'Invalid LLVM source manifest'
      )
    expect(() => validateCounts({}, f.root)).throws(
      'Invalid LLVM counts envelope'
    )
    for (const sources of [[], ['../outside'], ['/absolute']])
      expect(() => snapshot(f.root, sources)).throws(
        'Explicit repository-relative'
      )
    expect(() => snapshot(f.root, ['missing'])).throws('No source files')
    symlinkSync(join(other.root, 'src/a.rs'), join(f.root, 'src/foreign.rs'))
    expect(() => snapshot(f.root, ['src'])).throws('Source outside repository')
  })

  it('writes fresh snapshot and count envelopes through its CLI and refuses replacement', function () {
    const f = fixture()
    const manifestPath = join(f.root, 'source.json')
    const out = join(f.root, 'output.json')
    main([
      '--root',
      f.root,
      '--source',
      'src',
      '--source',
      'Cargo.toml',
      '--snapshot',
      manifestPath
    ])
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    utimesSync(f.lcov, new Date(), new Date(manifest.capturedAt + 10))
    main(['--manifest', manifestPath, '--lcov', f.lcov, '--out', out])
    expect(
      validateCounts(JSON.parse(readFileSync(out, 'utf8')), f.root)[
        'src/a.rs'
      ][2]
    ).equals(0)
    expect(() =>
      main(['--manifest', manifestPath, '--lcov', f.lcov, '--out', out])
    ).throws()
    for (const args of [
      [],
      ['--unknown', 'x'],
      ['--root'],
      ['--root', '--out'],
      ['--snapshot', 'x', '--manifest', 'y']
    ])
      expect(() => main(args)).throws()
  })
})
