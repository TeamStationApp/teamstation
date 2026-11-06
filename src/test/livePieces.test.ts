import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { startFakeSpace } from '../server/dev/fakeSpace'
import { putObject } from '../server/media/images'
import type { SpaceSettings } from '../server/media/spacesHls'
import { videoKey } from '../server/media/videoPrefix'
import { livePieceReader, type LivePieceSpace } from './livePieces'

describe('livePieceReader', function () {
  const secret = '0123456789abcdef0123456789abcdef'
  let folder: string
  let dir: string
  let space: SpaceSettings
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  let gets: string[]
  let source: LivePieceSpace
  let asked: number
  const where = async (): Promise<LivePieceSpace> => {
    asked += 1
    return source
  }

  beforeEach(async function () {
    folder = await mkdtemp(join(tmpdir(), 'tsLivePieces-'))
    dir = join(folder, 'local')
    await mkdir(dir)
    space = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    store = await startFakeSpace({ space, dir: join(folder, 'space') })
    space.endpoint = store.url
    gets = []
    store.server.on('request', req => {
      if (req.method === 'GET') gets.push(req.url!)
    })
    source = { space, video: { id: 'vid_pieces', spaceSecret: secret } }
    asked = 0
  })

  afterEach(async function () {
    await new Promise(resolve => store.server.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })

  it('reads a piece on disk from disk, without asking for the Space', async function () {
    await writeFile(join(dir, 'seg000001.m4s'), 'on disk')
    await putObject({
      space,
      key: videoKey(source.video, 'seg000001.m4s'),
      body: Buffer.from('in the space'),
      contentType: 'video/iso.segment'
    })
    const read = livePieceReader(where)
    expect(
      Buffer.from(await read(join(dir, 'seg000001.m4s'))).toString()
    ).equals('on disk')
    expect(asked).equals(0)
    expect(gets).deep.equals([])
  })

  it('reads a piece the disk tail deleted from the Space, under the secret path', async function () {
    for (const name of ['seg000001.m4s', 'seg000002.m4s'])
      await putObject({
        space,
        key: videoKey(source.video, name),
        body: Buffer.from(`${name} in the space`),
        contentType: 'video/iso.segment'
      })
    const read = livePieceReader(where)
    expect(
      Buffer.from(await read(join(dir, 'seg000001.m4s'))).toString()
    ).equals('seg000001.m4s in the space')
    expect(
      Buffer.from(await read(join(dir, 'seg000002.m4s'))).toString()
    ).equals('seg000002.m4s in the space')
    expect(asked).equals(1)
    expect(gets.map(url => new URL(url, store.url).pathname)).deep.equals([
      `/test/videos/vid_pieces-${secret}/seg000001.m4s`,
      `/test/videos/vid_pieces-${secret}/seg000002.m4s`
    ])
  })

  it('fails a missing piece with the disk error when there is no Space', async function () {
    const read = livePieceReader(async () => undefined)
    const error = await read(join(dir, 'seg000001.m4s')).then(
      () => undefined,
      (failure: unknown) => failure as NodeJS.ErrnoException
    )
    expect(error?.code).equals('ENOENT')
  })

  it('fails a piece the Space does not hold either', async function () {
    const read = livePieceReader(where)
    const error = await read(join(dir, 'seg000009.m4s')).then(
      () => undefined,
      (failure: unknown) => failure as Error
    )
    expect(error?.message).matches(/seg000009\.m4s from the Space answered 4/)
  })

  it('passes through a disk error other than a missing file', async function () {
    const read = livePieceReader(where)
    const error = await read(dir).then(
      () => undefined,
      (failure: unknown) => failure as NodeJS.ErrnoException
    )
    expect(error?.code).equals('EISDIR')
    expect(asked).equals(0)
  })
})
