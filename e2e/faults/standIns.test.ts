import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import WebSocket from 'ws'

import { text } from '../../src/test/fakeAnthropic'
import {
  parseStackConfigArgs,
  rewriteConfigFile,
  standInConfig
} from './stackConfig'
import {
  beaconRoute,
  DEFAULT_HEARD,
  delayFor,
  fromWire,
  logForwarded,
  standInRoute,
  type StandIns,
  startStandIns,
  toWire
} from './standIns'

/** A server answering only the stand-ins' routes, as the fault server mounts them. */
async function host(
  standIns: StandIns
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (beaconRoute(standIns, req, res)) return
    const url = new URL(req.url ?? '/', 'http://faults')
    const route = url.pathname.slice('/__e2e/'.length)
    if (!standInRoute(standIns, route, req, res, url)) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
}

async function call(
  url: string,
  method: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({
          status: res.statusCode ?? 0,
          body: text === '' ? undefined : JSON.parse(text)
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

describe('the stack stand-ins', function () {
  let standIns: StandIns
  let served: { server: Server; url: string }
  before(async function () {
    standIns = await startStandIns({ modelPort: 0, speechPort: 0 })
    served = await host(standIns)
  })
  after(async function () {
    served.server.close()
    await standIns.close()
  })

  it('sends a script as patterns and answers, and refuses a function answer', function () {
    const wire = toWire([{ match: /settings/i, rounds: [text('Here.')] }])
    expect(wire[0].match).deep.equals({ source: 'settings', flags: 'i' })
    const back = fromWire(JSON.parse(JSON.stringify(wire)))
    expect(back[0].match.test('Team SETTINGS')).equals(true)
    expect(
      toWire([{ match: /x/, rounds: [() => text('known by now')] }])[0].rounds
    ).deep.equals([text('known by now')])
    expect(() =>
      toWire([{ match: /x/, rounds: [request => text(request.said)] }])
    ).throws(/from the request/)
    expect(() => fromWire({})).throws(/not a list/)
    expect(() => fromWire([{ match: 'x' }])).throws(/entry 0/)
  })

  it('answers the model from the script it was given, and reports its calls', async function () {
    const script = toWire([{ match: /hello/i, rounds: [text('Hi there.')] }])
    expect(
      (await call(`${served.url}/__e2e/model/script`, 'PUT', script)).body
    ).deep.equals({ entries: 1 })
    const answer = await call(`${standIns.model.baseUrl}/messages`, 'POST', {
      model: 'claude-sonnet-5-5',
      max_tokens: 100,
      tools: [{ name: 'lookup' }],
      messages: [{ role: 'user', content: 'Hello' }]
    })
    expect(JSON.stringify(answer.body)).includes('Hi there.')
    const calls = await call(`${served.url}/__e2e/model/calls`, 'GET')
    expect(calls.body.calls.length).greaterThan(0)
    expect(calls.body.totals.requests).greaterThan(0)
    expect(
      (await call(`${served.url}/__e2e/model/script`, 'PUT', { no: 1 })).status
    ).equals(400)
  })

  it('hears its sentence for each utterance, and counts each one begun', async function () {
    expect(
      (await call(`${served.url}/__e2e/speech`, 'PUT', { heard: 'Ball one.' }))
        .body
    ).deep.equals({ heard: 'Ball one.' })
    expect(
      (await call(`${served.url}/__e2e/speech`, 'PUT', { heard: 3 })).status
    ).equals(400)
    const socket = new WebSocket(standIns.speechUrl)
    const messages: any[] = []
    socket.on('message', data =>
      messages.push(JSON.parse((data as Buffer).toString()))
    )
    await new Promise<void>(resolve =>
      socket.once('open', () => {
        resolve()
      })
    )
    socket.send(Buffer.from([1, 2, 3, 4]))
    socket.send(Buffer.from([5, 6]))
    socket.send('not json')
    socket.send(JSON.stringify({ type: 'finalize' }))
    socket.send(Buffer.from([7, 8]))
    socket.send(JSON.stringify({ type: 'finalize' }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(messages[0]).deep.equals({ type: 'transcript.created' })
    expect(messages.slice(1)).deep.equals([
      { type: 'transcript.partial', text: 'Ball one.', speech_final: true },
      { type: 'transcript.partial', text: 'Ball one.', speech_final: true }
    ])
    const closed = new Promise(resolve => socket.once('close', resolve))
    socket.send(JSON.stringify({ type: 'audio.done' }))
    await closed
    const heard = (await call(`${served.url}/__e2e/speech`, 'GET')).body
    expect(heard).deep.equals({
      heard: 'Ball one.',
      begun: 2,
      said: ['Ball one.', 'Ball one.']
    })
    standIns.speech.heard = DEFAULT_HEARD
  })

  it('holds only the reads under its prefix, and clears', async function () {
    expect(delayFor(standIns, '/api/v1/teams/t1')).equals(0)
    await call(`${served.url}/__e2e/delay`, 'PUT', {
      prefix: '/api/v1/teams',
      ms: 700
    })
    expect(delayFor(standIns, '/api/v1/teams/t1')).equals(700)
    expect(delayFor(standIns, '/api/v1/games/g1')).equals(0)
    expect(
      (await call(`${served.url}/__e2e/delay`, 'PUT', { prefix: 'x', ms: 1 }))
        .status
    ).equals(400)
    expect(
      (await call(`${served.url}/__e2e/delay`, 'PUT', null)).body
    ).deep.equals({ delay: null })
    expect(delayFor(standIns, '/api/v1/teams/t1')).equals(0)
  })

  it('counts the beacon and lists the requests it forwarded', async function () {
    expect((await call(`${served.url}/__tess/beacon`, 'GET')).status).equals(
      204
    )
    expect((await call(`${served.url}/__e2e/beacon`, 'GET')).body).deep.equals({
      hits: 1
    })
    logForwarded(standIns, 'GET', '/api/v1/teams/t1', 1000)
    logForwarded(standIns, 'GET', '/api/v1/games/g1', 2000)
    const rows = (
      await call(
        `${served.url}/__e2e/requests?since=1500&path=/api/v1/games`,
        'GET'
      )
    ).body.requests
    expect(rows).deep.equals([
      { at: 2000, method: 'GET', path: '/api/v1/games/g1' }
    ])
    for (let i = 0; i < 5001; i++) logForwarded(standIns, 'GET', '/x', 3000)
    expect(standIns.forwarded.length).equals(5000)
    expect((await call(`${served.url}/__e2e/elsewhere`, 'GET')).status).equals(
      404
    )
  })
})

describe('the stack config', function () {
  it('points Places, Tess and dictation at the stand-ins, and keeps the rest', function () {
    const config = standInConfig(
      {
        sessionSecret: 's',
        tess: { model: 'claude-sonnet-5-5' },
        dictation: { model: 'grok-4.3' }
      },
      '127.0.0.1:9300'
    )
    expect(config.sessionSecret).equals('s')
    expect(config.googlePlaces).deep.equals({
      apiKey: 'stub',
      baseUrl: 'http://127.0.0.1:9300'
    })
    expect(config.tess).deep.equals({
      model: 'claude-sonnet-5-5',
      apiKey: 'stub',
      baseUrl: 'http://127.0.0.1:9301/v1'
    })
    expect(config.dictation).deep.include({
      model: 'grok-4.3',
      sttUrl: 'ws://127.0.0.1:9302/v1/stt',
      baseUrl: 'http://127.0.0.1:9301/v1'
    })
    expect(standInConfig({}, 'h:1').dictation).deep.include({ apiKey: 'stub' })
  })

  it('rewrites the server config file in place', function () {
    const file = join(mkdtempSync(join(tmpdir(), 'stack-config-')), 'c.json')
    writeFileSync(file, JSON.stringify({ sessionSecret: 's' }))
    rewriteConfigFile(file, '127.0.0.1:9300')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written.sessionSecret).equals('s')
    expect(written.tess.baseUrl).equals('http://127.0.0.1:9301/v1')
  })

  it('reads the file and the Places address, and refuses anything else', function () {
    expect(
      parseStackConfigArgs(['serverConfig.json', '--places', '127.0.0.1:9300'])
    ).deep.equals({ file: 'serverConfig.json', places: '127.0.0.1:9300' })
    expect(parseStackConfigArgs(['--places', 'h:1', 'c.json'])).deep.equals({
      file: 'c.json',
      places: 'h:1'
    })
    expect(() => parseStackConfigArgs(['c.json'])).throws(/usage/)
    expect(() => parseStackConfigArgs(['c.json', '--places', 'nope'])).throws(
      /usage/
    )
  })
})
