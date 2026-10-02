import { relative, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import ts from 'typescript'

/**
 * The phone's player, type-checked as Metro builds it.
 *
 * `tsconfig.native.json` resolves `.native` files first, as Metro does, and
 * has no DOM types. So `document`, `window.addEventListener`,
 * `getBoundingClientRect` or a `<video>` element reaching the phone's player —
 * which is what crashed All Angles on a phone, the web's grid rendering into
 * `document.body` — is a type error here, caught without a phone or a server.
 */
const ROOT = resolve(__dirname, '../../..')
const GUARDED = [
  /^src2\/app\/player\//,
  /^src2\/app\/screens\/GameScreen\.tsx$/
]

describe('the phone player', function () {
  it('type-checks as Metro builds it, with no browser in it', function () {
    this.timeout(300_000)
    const configPath = resolve(ROOT, 'tsconfig.native.json')
    const read = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      ROOT,
      undefined,
      configPath
    )
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const problems = ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.file != null)
      .map(diagnostic => ({
        file: relative(ROOT, diagnostic.file?.fileName ?? ''),
        text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      }))
      .filter(problem => GUARDED.some(pattern => pattern.test(problem.file)))
    expect(
      problems.map(problem => `${problem.file}: ${problem.text}`)
    ).deep.equals([])
    // And the program really is the phone's: it reaches the native grid.
    expect(
      program
        .getSourceFiles()
        .some(file => file.fileName.endsWith('MultiCamView.native.tsx'))
    ).equals(true)
  })
})
