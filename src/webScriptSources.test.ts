import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import ts from 'typescript'

import { cspFor, originsFor } from './buildCsp.mjs'

/**
 * The web page's policy runs scripts only from `'self'` (`buildCsp.mjs`), and
 * a browser refuses a script, worklet or worker from a URL scheme the policy
 * does not name without firing `securitypolicyviolation` or logging anything:
 * the web dictation microphone once built its AudioWorklet from a `blob:` URL
 * and simply stopped working under the policy. This reads every web source
 * file and fails when one loads code from `blob:` or `data:` while the
 * directive that governs that load forbids the scheme.
 */

/** Where each kind of code load is checked, and what it is called. */
const SINKS: Array<{
  what: string
  directive: 'script-src' | 'worker-src'
  matches: (node: ts.Node) => boolean
}> = [
  {
    what: 'an AudioWorklet module (addModule)',
    directive: 'script-src',
    matches: node => isCallTo(node, 'addModule')
  },
  {
    what: 'importScripts',
    directive: 'script-src',
    matches: node => isCallTo(node, 'importScripts')
  },
  {
    what: 'a <script> element',
    directive: 'script-src',
    matches: node =>
      isCallTo(node, 'createElement') &&
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.toLowerCase() === 'script'
  },
  {
    what: 'a dynamic import of a computed URL',
    directive: 'script-src',
    matches: node =>
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      !ts.isStringLiteralLike(node.arguments[0])
  },
  {
    what: 'a worker',
    directive: 'worker-src',
    matches: node =>
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Worker', 'SharedWorker'].includes(node.expression.text)
  },
  {
    what: 'a service worker',
    directive: 'worker-src',
    matches: node =>
      isCallTo(node, 'register') &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText().endsWith('serviceWorker')
  }
]

/** `x.name(…)` or `name(…)`. */
function isCallTo(node: ts.Node, name: string): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === name
  return ts.isPropertyAccessExpression(callee) && callee.name.text === name
}

/** The URL schemes a node makes code from, if any. */
function schemesOf(node: ts.Node): Array<'blob:' | 'data:'> {
  if (isCallTo(node, 'createObjectURL')) return ['blob:']
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
    const text = node.text.toLowerCase()
    if (text.startsWith('blob:')) return ['blob:']
    if (/^data:[^,]*(java|ecma)script/.test(text)) return ['data:']
  }
  return []
}

/** The sources a policy allows for a directive, with CSP's fallbacks. */
function sourcesFor(policy: string, directive: string): string[] {
  const all = new Map(
    policy.split(';').map(part => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values] as const
    })
  )
  const order =
    directive === 'worker-src'
      ? ['worker-src', 'script-src', 'default-src']
      : [directive, 'default-src']
  for (const name of order) {
    const values = all.get(name)
    if (values != null) return values
  }
  return ['*']
}

/**
 * What a file loads from a scheme the policy forbids: one line per kind of
 * load, for a file that both makes a `blob:`/`data:` code URL and loads code.
 */
function blockedCodeLoads(
  policy: string,
  fileName: string,
  source: string
): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const schemes = new Set<'blob:' | 'data:'>()
  const sinks = new Set<(typeof SINKS)[number]>()
  const visit = (node: ts.Node): void => {
    for (const scheme of schemesOf(node)) schemes.add(scheme)
    for (const sink of SINKS) if (sink.matches(node)) sinks.add(sink)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const found: string[] = []
  for (const sink of sinks) {
    const allowed = sourcesFor(policy, sink.directive)
    for (const scheme of schemes) {
      if (allowed.includes(scheme) || allowed.includes('*')) continue
      found.push(
        `${fileName}: ${sink.what} from a ${scheme} URL, which ${sink.directive} ${allowed.join(' ')} forbids`
      )
    }
  }
  return found
}

/** Every file the web bundle can take code from: not native, not tests. */
function webSources(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...webSources(path))
    } else if (
      /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
      !/\.(native|ios|android|test|e2e)\./.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path)
    }
  }
  return files
}

/** The policy a production build writes (`build.mjs`). */
const policy = cspFor(
  originsFor('/api/v1', 'https://app.teamstation.app https://*.mzstatic.com')
)

/** The microphone's old way of loading its worklet. */
const BLOB_WORKLET = `
const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }))
export async function open(context: AudioContext) {
  await context.audioWorklet.addModule(url)
}
`

describe('the web code under its Content-Security-Policy', function () {
  it('finds a worklet, script or worker loaded from a scheme the policy forbids', function () {
    expect(blockedCodeLoads(policy, 'mic.ts', BLOB_WORKLET)).deep.equals([
      "mic.ts: an AudioWorklet module (addModule) from a blob: URL, which script-src 'self' forbids"
    ])
    expect(
      blockedCodeLoads(
        policy,
        'data.ts',
        // The source under test holds a template literal of its own.
        // eslint-disable-next-line no-template-curly-in-string
        'ctx.audioWorklet.addModule(`data:text/javascript;base64,${code}`)'
      )
    ).deep.equals([
      "data.ts: an AudioWorklet module (addModule) from a data: URL, which script-src 'self' forbids"
    ])
    expect(
      blockedCodeLoads(
        policy,
        'tag.tsx',
        "const s = document.createElement('script'); s.src = 'blob:x'"
      )
    ).to.have.length(1)
    expect(
      blockedCodeLoads(
        policy,
        'imp.ts',
        'await import(URL.createObjectURL(blob))'
      )
    ).to.have.length(1)
    // Workers may come from `blob:` (hls.js builds one), but only while
    // worker-src says so; without it the fallback is script-src.
    const worker = 'new Worker(URL.createObjectURL(blob))'
    expect(blockedCodeLoads(policy, 'w.ts', worker)).deep.equals([])
    expect(
      blockedCodeLoads("default-src 'self'; script-src 'self'", 'w.ts', worker)
    ).to.have.length(1)
    expect(
      blockedCodeLoads(
        "script-src 'self'; worker-src 'self'",
        'sw.ts',
        "navigator.serviceWorker.register('blob:x')"
      )
    ).to.have.length(1)
  })

  it('lets a policy that names the scheme through, and ignores comments and pictures', function () {
    expect(
      blockedCodeLoads("script-src 'self' blob:", 'mic.ts', BLOB_WORKLET)
    ).deep.equals([])
    expect(
      blockedCodeLoads('img-src blob:', 'mic.ts', BLOB_WORKLET)
    ).deep.equals([])
    // A `blob:` picture is not code.
    expect(
      blockedCodeLoads(
        policy,
        'picture.ts',
        "img.src = URL.createObjectURL(picture); new Image().src = 'blob:x'"
      )
    ).deep.equals([])
    expect(
      blockedCodeLoads(
        policy,
        'ok.ts',
        `/* addModule(URL.createObjectURL(x)) */
        await context.audioWorklet.addModule('/pcm16kWorklet.js')
        await import('./lazy')`
      )
    ).deep.equals([])
  })

  it('loads no code from a scheme the built policy forbids', function () {
    // Parses every web source file: seconds on a loaded machine.
    this.timeout(30000)
    const root = process.cwd()
    const files = [
      ...webSources(join(root, 'src/app')),
      ...webSources(join(root, 'src/common'))
    ]
    expect(files.length).greaterThan(100)
    const found = files.flatMap(path =>
      blockedCodeLoads(policy, relative(root, path), readFileSync(path, 'utf8'))
    )
    expect(found).deep.equals([])
  })
})
