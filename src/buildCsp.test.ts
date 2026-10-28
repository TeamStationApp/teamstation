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
      media: ['https://devhost1.example-ts.test', 'https://*.mzstatic.com']
    })
    expect(originsFor('/api/v1')).deep.equals({
      api: undefined,
      socket: undefined,
      media: []
    })
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
        "worker-src 'self' blob:; object-src 'none'; base-uri 'none'"
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
    this.timeout(240000)
    const root = process.cwd()
    let once: string
    let served: string
    let server: ChildProcess | undefined

    before(async function () {
      once = mkdtempSync(join(tmpdir(), 'ts-web-once-'))
      served = mkdtempSync(join(tmpdir(), 'ts-web-serve-'))
      // A module an earlier deploy left, which this build must prune.
      writeFileSync(join(once, 'chat-crypto-0123456789abcdef.wasm'), 'old')
      await run(process.execPath, ['src/build.mjs'], {
        cwd: root,
        env: {
          ...process.env,
          TS_WEB_OUT_DIR: once,
          TS_API_BASE_URL: 'https://devhost1.example-ts.test/api/v1',
          TS_MEDIA_ORIGINS:
            'https://devhost1.example-ts.test https://dev-media-bucket.sfo3.digitaloceanspaces.com https://*.mzstatic.com'
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
        'https://*.mzstatic.com'
      ])
      expect(policy['style-src']).includes('https://fonts.googleapis.com')
      expect(policy['font-src']).deep.equals([
        "'self'",
        'https://fonts.gstatic.com'
      ])
      expect(policy['worker-src']).deep.equals(["'self'", 'blob:'])
      expect(policy['media-src']).includes('blob:')
      expect(policy['img-src']).includes(
        'https://dev-media-bucket.sfo3.digitaloceanspaces.com'
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
