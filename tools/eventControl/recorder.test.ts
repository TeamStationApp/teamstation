import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { WebSocketServer } from 'ws'

import {
  fetchCredentials,
  parseArgs,
  parseEndpoint,
  printLog,
  readToken,
  redacted,
  required,
  serverBase
} from './cli'
import { fixtureCredentials } from './fixtures'
import { main as recorderMain, scoreboardSocketUrl } from './recorder'
import { main as signInMain, readLine } from './signIn'

describe('the scoreboard recorder', function () {
  it('logs every board the server sends, with the token it was given', async function () {
    const server = createServer()
    const sockets = new WebSocketServer({ server })
    const seen: string[] = []
    sockets.on('connection', (socket, request) => {
      seen.push(`${request.url} ${request.headers.authorization}`)
      socket.send(JSON.stringify({ homeScore: 1 }))
      socket.send('not json')
      setTimeout(() => {
        socket.send(JSON.stringify({ homeScore: 2 }))
      }, 10)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const dir = mkdtempSync(join(tmpdir(), 'recorder-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok_one\n')
    const lines: Array<Record<string, unknown>> = []
    const recording = recorderMain(
      [
        '--server',
        `http://127.0.0.1:${port}/`,
        '--token-file',
        tokenFile,
        '--game',
        'gam/demoA',
        '--seconds',
        '0.1'
      ],
      line => lines.push(line)
    )
    expect(await recording.closed).equals(1005)
    expect(seen).deep.equals(['/api/v1/scoreboard/gam%2FdemoA/socket Bearer tok_one'])
    expect(lines.map(line => line.event)).deep.equals([
      'subscribed',
      'scoreboard',
      'unreadable',
      'scoreboard',
      'closed'
    ])
    expect(lines[1].state).deep.equals({ homeScore: 1 })
    sockets.close()
    server.close()
  })

  it('reports a socket that cannot connect', async function () {
    const lines: Array<Record<string, unknown>> = []
    const dir = mkdtempSync(join(tmpdir(), 'recorder-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok_one')
    const recording = recorderMain(
      ['--server', 'http://127.0.0.1:1', '--token-file', tokenFile, '--game', 'g'],
      line => lines.push(line)
    )
    await recording.closed
    expect(lines.map(line => line.event)).deep.equals(['socketError', 'closed'])
    recording.stop()
  })

  it('builds the socket URL from any form of the server address', function () {
    expect(scoreboardSocketUrl('https://app.example.test/api/v1', 'g1')).equals(
      'wss://app.example.test/api/v1/scoreboard/g1/socket'
    )
  })
})

describe('signing in for the tools', function () {
  const fakeServer = (
    verifyStatus = 200
  ): { fetcher: typeof fetch; asked: string[] } => {
    const asked: string[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${String(init?.body)}`)
      if (url.endsWith('/auth/email-code'))
        return new Response('{}', { status: 202 })
      return new Response(
        JSON.stringify({ token: 'tok_signed', user: { id: 1001 } }),
        { status: verifyStatus }
      )
    }) as typeof fetch
    return { fetcher, asked }
  }

  it('asks for a code, reads it, and keeps the token in a private file', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'signin-'))
    const out = join(dir, 'keys', 'one.token')
    const { fetcher, asked } = fakeServer()
    const lines: Array<Record<string, unknown>> = []
    const made = await signInMain(
      ['--server', 'http://127.0.0.1:9', '--email', 'one@example.test', '--out', out],
      Readable.from(['123456\n']),
      line => lines.push(line),
      fetcher
    )
    expect(made.userId).equals('1001')
    expect(asked).deep.equals([
      'http://127.0.0.1:9/api/v1/auth/email-code {"email":"one@example.test"}',
      'http://127.0.0.1:9/api/v1/auth/email-code/verify {"email":"one@example.test","code":"123456","deviceName":"event-control tool"}'
    ])
    expect(readFileSync(out, 'utf8')).equals('tok_signed\n')
    expect(statSync(out).mode & 0o777).equals(0o600)
    expect(JSON.stringify(lines)).not.includes('tok_signed')
    expect(readToken(out)).equals('tok_signed')
  })

  it('stops on a refused code, a refused request and no code at all', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'signin-'))
    const out = join(dir, 'token')
    const args = ['--server', 'http://127.0.0.1:9', '--email', 'one@example.test', '--out', out]
    const failure = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run()
      } catch (error) {
        return String(error)
      }
      return 'no error'
    }
    expect(
      await failure(async () => await signInMain(args, Readable.from(['1\n']), () => undefined, fakeServer(401).fetcher))
    ).matches(/verifying the code answered 401/)
    const refusing = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    expect(
      await failure(async () => await signInMain(args, Readable.from(['1\n']), () => undefined, refusing))
    ).matches(/asking for a code answered 429/)
    expect(await failure(async () => await readLine(Readable.from([])))).matches(/no code/)
  })
})

describe('the tools’ shared helpers', function () {
  it('parses arguments, endpoints and server addresses', function () {
    const args = parseArgs(['--peer', '[fe80::1]:47615', '--tamper'], ['tamper'])
    expect(args.get('tamper')).equals(true)
    expect(parseEndpoint(required(args, 'peer'))).deep.equals({ host: 'fe80::1', port: 47615 })
    expect(parseEndpoint('192.0.2.4:47614')).deep.equals({ host: '192.0.2.4', port: 47614 })
    expect(() => parseEndpoint('nope')).throws(/host:port/)
    expect(() => parseArgs(['stray'], [])).throws(/unexpected/)
    expect(() => parseArgs(['--peer'], [])).throws(/needs a value/)
    expect(() => required(args, 'game')).throws(/--game is required/)
    expect(serverBase('https://app.example.test/api/v1/')).equals('https://app.example.test')
  })

  it('refuses an empty token file and never shows a key', function () {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'))
    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n')
    expect(() => readToken(empty)).throws(/holds no token/)
    const one = fixtureCredentials('one')
    expect(JSON.stringify(redacted(one))).not.includes(one.key)
  })

  it('fetches a key, and says why when it cannot', async function () {
    const one = fixtureCredentials('one')
    const answering = (async () => new Response(JSON.stringify(one))) as unknown as typeof fetch
    expect(await fetchCredentials('http://127.0.0.1:9', 'tok', answering)).deep.equals(one)
    const unreadable = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    let failed: unknown
    try {
      await fetchCredentials('http://127.0.0.1:9', 'tok', unreadable)
    } catch (error) {
      failed = error
    }
    expect(String(failed)).matches(/answered 500: $/)
    const said = (async () =>
      new Response(JSON.stringify({ message: 'Sign in to continue' }), { status: 401 })) as unknown as typeof fetch
    try {
      await fetchCredentials('http://127.0.0.1:9', 'tok', said)
    } catch (error) {
      failed = error
    }
    expect(String(failed)).matches(/401: Sign in to continue/)
  })

  it('prints one stamped JSON line', function () {
    const original = console.log
    const printed: string[] = []
    console.log = (line: string) => printed.push(line)
    try {
      printLog({ event: 'x' })
    } finally {
      console.log = original
    }
    expect(JSON.parse(printed[0])).includes({ event: 'x' })
    expect(JSON.parse(printed[0]).at).matches(/^\d{4}-/)
  })
})
