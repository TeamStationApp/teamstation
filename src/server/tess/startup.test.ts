import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { sql } from 'kysely'
import { it } from 'mocha'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { accountHarness } from '../../test/accountHarness'

type Block = Record<string, any>

/** A free port on the loopback interface. */
async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (address == null || typeof address === 'string')
    throw new Error('No test port')
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  return address.port
}

it('answers Tess’s tool calls through the production server’s own port', async function () {
  this.timeout(60000)
  const h = await accountHarness()
  const folder = await mkdtemp(join(tmpdir(), 'tess-startup-'))
  // The Messages API: the first answer reads the person's roles, the next
  // one, sent with that read's result, replies.
  const requests: Block[] = []
  const model = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Block
      requests.push(body)
      const content =
        requests.length === 1
          ? [
              {
                type: 'tool_use',
                id: 'toolu_startup',
                name: 'api_get',
                input: { path: '/me/roles' }
              }
            ]
          : [{ type: 'text', text: 'You hold no team roles yet.' }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `msg_startup_${requests.length}`,
          type: 'message',
          role: 'assistant',
          content,
          stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 20 }
        })
      )
    })
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelAddress = model.address()
  if (modelAddress == null || typeof modelAddress === 'string')
    throw new Error('No model port')
  const dbName = (
    await sql<{ name: string }>`select current_database() as name`.execute(h.db)
  ).rows[0].name
  const databaseUrl = new URL(testDatabaseUrl)
  databaseUrl.pathname = '/' + dbName
  const port = await freePort()
  await writeFile(
    join(folder, 'serverConfig.json'),
    JSON.stringify({
      databaseUrl: databaseUrl.toString(),
      // The wildcard address: Tess's tools still call back on 127.0.0.1.
      listenHost: '0.0.0.0',
      listenPort: port,
      clusterWorkers: 1,
      statsBuilder: false,
      live: { enabled: false },
      workDir: folder,
      mediaDir: folder,
      sessionSecret: 'synthetic-session-fixture',
      mediaSecret: 'synthetic-media-fixture',
      logRequests: false,
      tess: {
        apiKey: 'test-key-placeholder',
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`
      }
    })
  )
  const child = spawn(
    process.execPath,
    [
      '-r',
      resolve('node_modules/sucrase/register'),
      resolve('src/server/index.ts')
    ],
    {
      cwd: folder,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let logs = ''
  child.stdout.on('data', b => {
    logs += String(b)
  })
  child.stderr.on('data', b => {
    logs += String(b)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('Server startup timed out'))
      }, 30000)
      const timer = setInterval(() => {
        if (logs.includes('listening on')) {
          clearTimeout(timeout)
          clearInterval(timer)
          resolve()
        } else if (child.exitCode != null) {
          clearTimeout(timeout)
          clearInterval(timer)
          reject(new Error('Server startup failed'))
        }
      }, 25)
    })
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/me/tess/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.tokens.get(101)!}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text: 'What are my roles?' })
      }
    )
    expect(response.status).equals(200)
    const { messages } = (await response.json()) as {
      messages: Array<{ role: string; text?: string }>
    }
    expect(messages.at(-1)?.text).equals('You hold no team roles yet.')

    // The read went to this same server, as user 101.
    expect(requests).length(2)
    const result = (requests[1].messages as Block[])
      .flatMap(message =>
        Array.isArray(message.content) ? (message.content as Block[]) : []
      )
      .find(block => block.type === 'tool_result')
    expect(result?.tool_use_id).equals('toolu_startup')
    expect(result?.is_error).equals(undefined)
    // Signed in: without user 101's session the read answers 401.
    expect(result?.content).equals('HTTP 200\n{"teams":{},"guardianOf":[]}')
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode == null) await once(child, 'exit')
    model.close()
    await h.close()
    await rm(folder, { recursive: true, force: true })
  }
})
