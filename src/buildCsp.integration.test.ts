import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import vm from 'node:vm'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  cspFor,
  integrityOf,
  originOf,
  originsFor,
  socketOriginOf,
  withCsp,
  withIntegrity
} from './buildCsp.mjs'
import { input as engineInput } from './common/autoScheduler/fixtures.test'
import { readResult, wireRequest } from './common/scheduler/wire'

const run = promisify(execFile)

/** The directives of a policy, by name. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map(part => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values]
    })
  )
}

/** The policy in a page's `<meta http-equiv>`. */
function policyOf(html: string): string {
  const found =
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)
  if (found == null) throw new Error('no CSP meta')
  return found[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

describe('the web page’s Content-Security-Policy and integrity', function () {
  it('reads origins from the API URL and the media list', function () {
    expect(originOf('/api/v1')).equals(undefined)
    expect(originOf(undefined)).equals(undefined)
    expect(originOf('http://127.0.0.1:9120/api/v1')).equals(
      'http://127.0.0.1:9120'
    )
    expect(socketOriginOf('https://devhost1.example-ts.test')).equals(
      'wss://devhost1.example-ts.test'
    )
    expect(
      originsFor(
        'https://devhost1.example-ts.test/api/v1',
        ' https://devhost1.example-ts.test  https://*.mzstatic.com\n'
      )
    ).deep.equals({
      api: 'https://devhost1.example-ts.test',
      socket: 'wss://devhost1.example-ts.test',
      media: ['https://devhost1.example-ts.test', 'https://*.mzstatic.com'],
      logs: undefined
    })
    expect(originsFor('/api/v1')).deep.equals({
      api: undefined,
      socket: undefined,
      media: [],
      logs: undefined
    })
  })

  it('lets the page post its logs to the collector its DSN names, and nowhere else', function () {
    expect(
      originsFor(
        '/api/v1',
        '',
        'https://0123abcd@develop-logs.example-ts.test/102'
      ).logs
    ).equals('https://develop-logs.example-ts.test')
    for (const dsn of [
      '',
      'not a url',
      'http://0123abcd@logs.example-ts.test/102',
      'https://0123abcd:secret@logs.example-ts.test/102',
      'https://logs.example-ts.test/102',
      'https://0123abcd@logs.example-ts.test/ingest/102',
      'https://0123abcd@logs.example-ts.test/102?x=1',
      'https://0123abcd@logs.example-ts.test/102#x'
    ])
      expect(originsFor('/api/v1', '', dsn).logs, dsn).equals(undefined)
    const policy = directives(
      cspFor(
        originsFor(
          '/api/v1',
          'https://media.example-ts.test',
          'https://0123abcd@develop-logs.example-ts.test/102'
        )
      )
    )
    expect(policy['connect-src']).deep.equals([
      "'self'",
      'https://media.example-ts.test',
      'https://develop-logs.example-ts.test'
    ])
    // The collector is only talked to: images and video never come from it.
    expect(policy['img-src']).deep.equals([
      "'self'",
      'data:',
      'blob:',
      'https://media.example-ts.test'
    ])
    expect(policy['media-src']).deep.equals([
      "'self'",
      'blob:',
      'https://media.example-ts.test'
    ])
  })

  it('writes exactly the planned policy', function () {
    const policy = cspFor(
      originsFor(
        'http://127.0.0.1:9120/api/v1',
        'http://127.0.0.1:9120 http://127.0.0.1:9197'
      )
    )
    expect(policy).equals(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: blob: http://127.0.0.1:9120 http://127.0.0.1:9197; " +
        "media-src 'self' blob: http://127.0.0.1:9120 http://127.0.0.1:9197; " +
        "connect-src 'self' http://127.0.0.1:9120 ws://127.0.0.1:9120 http://127.0.0.1:9197; " +
        "worker-src 'self' blob:; frame-src 'self' blob:; " +
        "object-src 'none'; base-uri 'none'"
    )
    // A `<meta>` cannot refuse framing; the reverse proxy's headers do.
    expect(policy).not.contains('frame-ancestors')
    // Relative API, no media: only the page itself.
    expect(
      directives(cspFor(originsFor('/api/v1')))['connect-src']
    ).deep.equals(["'self'"])
  })

  it('puts the meta right after the charset, and refuses a page without one', function () {
    const html = withCsp(
      '<html><head><meta charset="utf-8" /><title>x</title></head></html>',
      `a 'b' "c" & d`
    )
    expect(html).contains(
      '<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="a \'b\' &quot;c&quot; &amp; d" />'
    )
    expect(policyOf(html)).equals(`a 'b' "c" & d`)
    expect(() => withCsp('<html></html>', 'x')).throws(/charset/)
  })

  it('hashes every script it is given, and leaves a hashed one alone', function () {
    const bytes = Buffer.from('console.log(1)')
    const digest = createHash('sha384').update(bytes).digest('base64')
    expect(integrityOf(bytes)).equals(`sha384-${digest}`)
    expect(
      withIntegrity('<script src="/app-X.js"></script>', {
        '/app-X.js': bytes
      })
    ).equals(`<script src="/app-X.js" integrity="sha384-${digest}"></script>`)
    const already = '<script src="/a.js" integrity="sha384-y"></script>'
    expect(withIntegrity(already, {})).equals(already)
    expect(() => withIntegrity('<script src="/b.js"></script>', {})).throws(
      /b\.js/
    )
  })

  describe('a real build', function () {
    // A host's first build fetches Emscripten and builds HiGHS with it.
    this.timeout(900000)
    const root = process.cwd()
    let once: string
    let served: string
    let server: ChildProcess | undefined

    before(async function () {
      once = mkdtempSync(join(tmpdir(), 'ts-web-once-'))
      served = mkdtempSync(join(tmpdir(), 'ts-web-serve-'))
      // A module an earlier deploy left, which this build must prune.
      writeFileSync(join(once, 'chat-crypto-0123456789abcdef.wasm'), 'old')
      // And the HiGHS module and worker the scheduler's replace.
      writeFileSync(join(once, 'highs-0123456789abcdef.wasm'), 'old')
      writeFileSync(join(once, 'highs-worker-ABCDEFGH.js'), 'old')
      // An earlier deploy's SQLite module, with its encoded copies.
      writeFileSync(join(once, 'sqlite3-0123456789abcdef.wasm'), 'old')
      writeFileSync(join(once, 'sqlite3-0123456789abcdef.wasm.br'), 'old')
      writeFileSync(join(once, 'sqlite3-0123456789abcdef.wasm.gz'), 'old')
      await run(process.execPath, ['src/build.mjs'], {
        cwd: root,
        env: {
          ...process.env,
          TS_WEB_OUT_DIR: once,
          TS_API_BASE_URL: 'https://devhost1.example-ts.test/api/v1',
          TS_MEDIA_ORIGINS:
            'https://devhost1.example-ts.test https://dev-media-bucket.sfo3.digitaloceanspaces.com https://*.mzstatic.com',
          TS_SENTRY_DSN: 'https://0123abcd@logs.example-ts.test/102'
        },
        maxBuffer: 1 << 24
      })
    })

    after(function () {
      server?.kill('SIGKILL')
      rmSync(once, { recursive: true, force: true })
      rmSync(served, { recursive: true, force: true })
    })

    it('carries the API, socket and media origins, fonts and the worker rule', function () {
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      const policy = directives(policyOf(html))
      expect(policy['connect-src']).deep.equals([
        "'self'",
        'https://devhost1.example-ts.test',
        'wss://devhost1.example-ts.test',
        'https://dev-media-bucket.sfo3.digitaloceanspaces.com',
        'https://*.mzstatic.com',
        'https://logs.example-ts.test'
      ])
      expect(policy['style-src']).includes('https://fonts.googleapis.com')
      expect(policy['font-src']).deep.equals([
        "'self'",
        'https://fonts.gstatic.com'
      ])
      expect(policy['worker-src']).deep.equals(["'self'", 'blob:'])
      // The Plan tab prints its PDF from a frame of a blob: URL.
      expect(policy['frame-src']).deep.equals(["'self'", 'blob:'])
      expect(policy['media-src']).includes('blob:')
      expect(policy['img-src']).includes(
        'https://dev-media-bucket.sfo3.digitaloceanspaces.com'
      )
    })

    it('describes TeamStation before any script runs, the policy still right after the charset', function () {
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      const sentence =
        'TeamStation is where a team keeps its games, scores, and video.'
      expect(html).contains(`<meta name="description" content="${sentence}" />`)
      // In the body: in the head a <noscript> may hold only link, style and meta.
      const body = html.slice(html.indexOf('<body>')).replace(/\s+/g, ' ')
      expect(body).contains(
        `<body> <noscript>${sentence}</noscript> <div id="root"></div>`
      )
      expect(html).matches(
        /<meta charset="utf-8" \/>\n\s*<meta http-equiv="Content-Security-Policy" /
      )
    })

    it('hashes every script tag with its file’s sha384', function () {
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      const tags = [
        ...html.matchAll(/<script src="\/([^"]+)" integrity="([^"]+)"/g)
      ]
      expect(tags.length).equals(
        [...html.matchAll(/<script\b/g)].length,
        'every script tag has integrity'
      )
      expect(tags.length).greaterThan(0)
      for (const [, file, integrity] of tags) {
        const digest = createHash('sha384')
          .update(readFileSync(join(once, file)))
          .digest('base64')
        expect(integrity).equals(`sha384-${digest}`)
      }
    })

    it('serves the microphone worklet as a file of its own', function () {
      // `script-src 'self'` refuses a worklet from `blob:`, so the build
      // ships the processor beside the bundle, at the URL the app loads.
      expect(readFileSync(join(once, 'pcm16kWorklet.js'), 'utf8')).equals(
        readFileSync('src/app/scoring/pcm16kWorklet.js', 'utf8')
      )
      expect(readFileSync('src/app/scoring/microphone.ts', 'utf8')).contains(
        `WORKLET_URL = '/pcm16kWorklet.js'`
      )
    })

    it('ships the scheduler as a worker and a module of their own that build with no network', async function () {
      const files = readdirSync(once)
      const worker = files.find(name =>
        /^scheduler-worker-[A-Z0-9]+\.js$/i.test(name)
      )
      const module = files.find(name =>
        /^scheduler-[0-9a-f]{16}\.wasm$/.test(name)
      )
      expect(worker, 'the worker').not.equals(undefined)
      expect(module, 'the module').not.equals(undefined)
      // One of each: no HiGHS module or worker of an earlier build is left.
      expect(files.filter(name => name.startsWith('highs-'))).deep.equals([])
      const bytes = readFileSync(join(once, String(module)))
      expect(module).equals(
        `scheduler-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.wasm`
      )
      const app = files.find(name => /^app-[A-Z0-9]+\.js$/i.test(name))
      const bundle = readFileSync(join(once, String(app)), 'utf8')
      // The bundle names both and the module's integrity, and holds no glue.
      expect(bundle).includes(`/${worker}`)
      expect(bundle).includes(`/${module}`)
      expect(bundle).includes(integrityOf(bytes))
      expect(bundle).not.includes('createSchedulerModule')
      const workerText = readFileSync(join(once, String(worker)), 'utf8')
      expect(workerText).includes('createSchedulerModule')
      // No build-host path in either.
      for (const text of [bytes.toString('latin1'), workerText])
        for (const needle of ['/Users/', '/root/'])
          expect(text).not.includes(needle)
      // The built worker, in a worker-like context with no network and no
      // process, loads the module from posted bytes and builds a request.
      const replies: Array<{ type: string; id?: number; result?: string }> = []
      let requests = 0
      const scope: Record<string, unknown> = {
        WorkerGlobalScope: function WorkerGlobalScope() {},
        location: { href: 'https://example.test/scheduler-worker.js' },
        console,
        setTimeout,
        clearTimeout,
        WebAssembly,
        TextDecoder,
        TextEncoder,
        performance,
        URL,
        fetch: () => {
          requests++
          throw new Error('no network')
        },
        XMLHttpRequest: function XMLHttpRequest() {
          requests++
          throw new Error('no network')
        },
        postMessage: (reply: (typeof replies)[number]) => replies.push(reply)
      }
      scope.self = scope
      scope.globalThis = scope
      vm.createContext(scope)
      vm.runInContext(workerText, scope)
      const post = (data: unknown): void => {
        ;(scope.onmessage as (event: { data: unknown }) => void)({ data })
      }
      const settle = async (count: number): Promise<void> => {
        for (let i = 0; i < 400 && replies.length < count; i++)
          await new Promise(resolve => setTimeout(resolve, 25))
      }
      const resulted = async (): Promise<(typeof replies)[number]> => {
        for (let i = 0; i < 400; i++) {
          const found = replies.find(reply => reply.type === 'result')
          if (found != null) return found
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return expect.fail('no result')
      }
      post({ type: 'init', bytes: new Uint8Array(bytes).buffer })
      await settle(1)
      expect(replies[0]).deep.equals({ type: 'ready' })
      const run = engineInput()
      post({
        type: 'build',
        id: 1,
        request: JSON.stringify(wireRequest({ input: run }))
      })
      const result = await resulted()
      expect(result).include({ type: 'result', id: 1 })
      // The engine's phases come first, as the build reaches each.
      const phases = replies
        .filter(reply => reply.type === 'progress')
        .map(
          reply =>
            (
              JSON.parse(String((reply as { event?: string }).event)) as {
                phase?: string
              }
            ).phase
        )
      expect(phases[0]).equals('context')
      expect(phases.at(-1)).equals('options')
      const built = readResult(String(result.result), run)
      if (built.kind !== 'options') expect.fail(built.message)
      expect(built.options.length).greaterThan(0)
      expect(built.options[0].games.length).greaterThan(0)
      expect(requests).equals(0)
    })

    it('serves the map frame as a page of its own, with no policy', function () {
      const page = readFileSync(join(once, 'mapFrame.html'), 'utf8')
      expect(page).equals(readFileSync('src/app/web/mapFrame.html', 'utf8'))
      expect(page).not.contains('Content-Security-Policy')
    })

    it('ships one chat crypto module, named by its hash, that the bundle checks', function () {
      const modules = readdirSync(once).filter(name =>
        /^chat-crypto-.*\.wasm$/.test(name)
      )
      expect(modules).lengthOf(1)
      const [module] = modules
      const bytes = readFileSync(join(once, module))
      expect(module).equals(
        `chat-crypto-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.wasm`
      )
      // WebAssembly's magic number: the real module, not the stale one.
      expect(bytes.subarray(0, 4).toString('hex')).equals('0061736d')
      const bundle = readdirSync(once).find(name => /^app-.*\.js$/.test(name))
      const code = readFileSync(join(once, bundle!), 'utf8')
      expect(code).contains(`/${module}`)
      expect(code).contains(integrityOf(bytes))
      // The policy lets the page compile it, and nothing more.
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      expect(directives(policyOf(html))['script-src']).deep.equals([
        "'self'",
        "'wasm-unsafe-eval'"
      ])
    })

    it('writes the crowd’s sounds beside the bundle, which names them from the root', function () {
      const sounds = readdirSync(once).filter(name => name.endsWith('.m4a'))
      expect(
        sounds.map(name => name.replace(/-[A-Z0-9]+\.m4a$/, '')).sort()
      ).deep.equals([
        'cheer-huge',
        'cheer-large',
        'cheer-medium',
        'cheer-small',
        'crowd-idle'
      ])
      const bundle = readdirSync(once).find(name => /^app-.*\.js$/.test(name))
      const code = readFileSync(join(once, bundle!), 'utf8')
      // Root-relative, so they load from `/games/:id/replay` too.
      for (const sound of sounds) expect(code).contains(`"/${sound}"`)
      // The page may play them: its media come from itself.
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      expect(directives(policyOf(html))['media-src']).includes("'self'")
      // The bundle's own script is still named from the root, with its hash.
      expect(html).contains(`src="/${bundle}"`)
    })

    it('ships the SQLite module under its hash, the bundle naming it, and prunes an earlier one', function () {
      const files = readdirSync(once)
      const modules = files.filter(name =>
        /^sqlite3-[0-9a-f]{16}\.wasm$/.test(name)
      )
      expect(modules).has.length(1)
      const bytes = readFileSync(join(once, modules[0]))
      expect(modules[0]).equals(
        `sqlite3-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.wasm`
      )
      const app = files.find(name => /^app-[A-Z0-9]+\.js$/i.test(name))
      expect(readFileSync(join(once, String(app)), 'utf8')).includes(
        `/${modules[0]}`
      )
      expect(
        files.filter(name => name.startsWith('sqlite3-0123456789abcdef'))
      ).deep.equals([])
    })

    it('writes a brotli and a gzip copy of every JS, CSS and WASM file, each its original’s bytes', function () {
      const files = readdirSync(once)
      const originals = files.filter(name => /\.(?:js|css|wasm)$/.test(name))
      expect(originals.length).greaterThan(5)
      for (const name of originals) {
        const bytes = readFileSync(join(once, name))
        expect(
          brotliDecompressSync(readFileSync(join(once, `${name}.br`))).equals(
            bytes
          ),
          `${name}.br`
        ).equals(true)
        expect(
          gunzipSync(readFileSync(join(once, `${name}.gz`))).equals(bytes),
          `${name}.gz`
        ).equals(true)
      }
      // No copy of anything else, and none left of a file that is gone.
      for (const name of files.filter(name => /\.(?:br|gz)$/.test(name)))
        expect(originals, name).includes(name.replace(/\.(?:br|gz)$/, ''))
    })

    it('ships the notifications’ service worker under its own name, with the bundle’s module', function () {
      // A service worker is registered by its URL, so `sw.js` is never hashed.
      const worker = readFileSync(join(once, 'sw.js'), 'utf8')
      const [module] = readdirSync(once).filter(name =>
        /^chat-crypto-.*\.wasm$/.test(name)
      )
      expect(worker).contains(`/${module}`)
      expect(worker).contains(integrityOf(readFileSync(join(once, module))))
      expect(readdirSync(once).filter(name => /^sw\b/.test(name))).deep.equals([
        'sw.js',
        'sw.js.br',
        'sw.js.gz',
        'sw.js.map'
      ])
      // `pushDevice.ts` registers it from the page, which the policy allows.
      const html = readFileSync(join(once, 'index.html'), 'utf8')
      expect(directives(policyOf(html))['worker-src']).includes("'self'")
    })

    it('has no chat bench route in the web bundle', function () {
      const bundle = readdirSync(once).find(name => /^app-.*\.js$/.test(name))
      expect(bundle).not.equals(undefined)
      const code = readFileSync(join(once, bundle!), 'utf8')
      expect(code).not.contains('chat-bench')
      expect(code).not.contains('TS_CHAT_BENCH')
    })

    it('writes the policy and no integrity when serving', async function () {
      server = spawn(
        process.execPath,
        ['-r', './src/test/exitOnTerm.cjs', 'src/build.mjs', '--serve'],
        {
          cwd: root,
          env: {
            ...process.env,
            TS_WEB_OUT_DIR: served,
            TS_SERVE_PORT: '0',
            TS_API_BASE_URL: 'http://127.0.0.1:9120/api/v1',
            TS_MEDIA_ORIGINS: 'http://127.0.0.1:9120 http://127.0.0.1:9197'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      const address = await new Promise<string>((resolve, reject) => {
        let said = ''
        const hear = (chunk: Buffer): void => {
          said += chunk.toString()
          const found = /app on (http:\/\/\S+)/.exec(said)
          if (found != null) resolve(found[1])
        }
        server!.stdout!.on('data', hear)
        server!.stderr!.on('data', hear)
        server!.on('exit', code => {
          reject(new Error(`build --serve exited ${code}: ${said}`))
        })
      })
      const html = readFileSync(join(served, 'index.html'), 'utf8')
      expect(html).not.contains('integrity=')
      expect(html).contains('<script src="/app.js"></script>')
      expect(directives(policyOf(html))['connect-src']).deep.equals([
        "'self'",
        'http://127.0.0.1:9120',
        'ws://127.0.0.1:9120',
        'http://127.0.0.1:9197'
      ])
      // The dev server serves the chat crypto module under its plain name.
      const module = await fetch(`${address}/chat-crypto.wasm`)
      expect(module.status).equals(200)
      expect(
        Buffer.from(await module.arrayBuffer())
          .subarray(0, 4)
          .toString('hex')
      ).equals('0061736d')
      // The dev server serves the worklet too, as JavaScript.
      const worklet = await fetch(`${address}/pcm16kWorklet.js`)
      expect(worklet.status).equals(200)
      expect(worklet.headers.get('content-type')).matches(/javascript/)
      expect(await worklet.text()).contains("registerProcessor('pcm16k'")
      // And the service worker, as JavaScript, from the page's origin.
      const worker = await fetch(`${address}/sw.js`)
      expect(worker.status).equals(200)
      expect(worker.headers.get('content-type')).matches(/javascript/)
      expect(await worker.text()).contains('/chat-crypto.wasm')
      // Stopped with SIGTERM, so its coverage is written as it exits.
      const stopped = server
      await new Promise<void>(resolve => {
        stopped.once('exit', () => {
          resolve()
        })
        stopped.kill('SIGTERM')
      })
      server = undefined
    })
  })
})
