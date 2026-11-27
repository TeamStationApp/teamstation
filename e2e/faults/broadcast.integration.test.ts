import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { liveVideoDir } from '../../src/server/live/controller'
import { BROADCASTERS, stackBroadcasts } from './broadcast'

const URL = 'rtmp://e2e.example.test:1936/live/key-1.a'

describe('the stack’s broadcasts', function () {
  const checkout = mkdtempSync(join(tmpdir(), 'e2e-broadcast-test-'))
  after(function () {
    rmSync(checkout, { recursive: true, force: true })
  })

  it('runs the checkout’s broadcaster and reads its own disk', async function () {
    const script = join(checkout, BROADCASTERS.scoreboard)
    mkdirSync(join(script, '..'), { recursive: true })
    writeFileSync(
      script,
      `console.log(JSON.stringify({ at: 1, event: 'planned', t0: 42, args: process.argv.slice(2) }))\n`
    )
    const media = join(checkout, 'media')
    const dir = liveVideoDir(media, 'vid_9')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n')
    const actions = stackBroadcasts(checkout, () => ({
      mediaDir: media,
      live: { port: 1936 }
    }))
    const made = (await actions.broadcast({ url: URL, duration: 5 })) as any
    expect(made.t0).equals(42)
    expect(made.id).match(/^bc[a-z0-9]+$/)
    expect(made.events[0].args.slice(0, 2)).deep.equals([
      '--url',
      'rtmp://127.0.0.1:1936/live/key-1.a'
    ])
    const files = (await actions['ingest-files']({ videoId: 'vid_9' })) as any
    expect(files.names).deep.equals(['master.m3u8'])
    expect(files.master).equals('#EXTM3U\n')
  })
})
