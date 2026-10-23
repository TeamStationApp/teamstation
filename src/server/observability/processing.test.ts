import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { sql } from 'kysely'

import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { directorUploadRoutes } from '../routes/directorUploads'

describe('Server-confirmed video analytics', function () {
  this.timeout(60000)
  let h: AccountHarness, directory: string
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'observability-video-'))
    h = await accountHarness(undefined, (app, { db, media, space }) => {
      app.use(
        '/api/v1',
        directorUploadRoutes(db, {
          uploadsDir: directory,
          ffmpegPath: media.ffmpegPath,
          space
        })
      )
    })
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    await h.db
      .insertInto('games')
      .values({
        id: 'gam_outcome',
        home_team_id: 'tem_account',
        away_team_id: 'tem_account',
        start_at: new Date()
      })
      .execute()
    await promisify(execFile)(process.env.TS_FFMPEG ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:r=24',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(directory, 'synthetic.mp4')
    ])
  })
  after(async () => {
    await h?.close()
    if (directory != null) await rm(directory, { recursive: true, force: true })
  })
  it('records a committed ready video, its creator, and a failed conversion without raw content', async () => {
    const ask = async (
      path: string,
      method: string,
      body: string | Buffer,
      binary = false
    ): Promise<Response> =>
      await fetch(h.origin + '/api/v1' + path, {
        method,
        headers: {
          authorization: 'Bearer ' + h.tokens.get(101)!,
          'x-teamstation-app': 'TS',
          'content-type': binary
            ? 'application/octet-stream'
            : 'application/json'
        },
        body
      })
    for (const valid of [true, false]) {
      const file = valid
        ? await readFile(join(directory, 'synthetic.mp4'))
        : Buffer.from('private-canary')
      const opened = await ask(
        '/director/uploads',
        'POST',
        JSON.stringify({
          gameId: 'gam_outcome',
          title: 'private-canary',
          filename: 'private-canary.mp4',
          sizeBytes: file.length
        })
      )
      expect(opened.status).equals(201)
      const { uploadId } = (await opened.json()) as { uploadId: string }
      expect(
        (await ask(`/director/uploads/${uploadId}/parts/0`, 'PUT', file, true))
          .status
      ).equals(200)
      expect(
        (await ask(`/director/uploads/${uploadId}/finish`, 'POST', '{}')).status
      ).equals(202)
      const deadline = Date.now() + 30000
      let rows: Array<{
        event_name: string
        user_id: string
        properties: object
      }> = []
      do {
        rows = (
          await sql<{
            event_name: string
            user_id: string
            properties: object
          }>`SELECT event_name,user_id,properties FROM analytics.events WHERE event_name=${valid ? 'processing_ready' : 'processing_failed'}`.execute(
            h.db
          )
        ).rows
        if (rows.length > 0) break
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      expect(rows).length(1)
      expect(rows[0].user_id).equals(userIdOfGumbo(101))
      expect(JSON.stringify(rows)).not.includes('canary')
      if (valid) {
        const video = await h.db
          .selectFrom('director_uploads')
          .select('video_id')
          .where('id', '=', uploadId)
          .executeTakeFirstOrThrow()
        expect(rows[0].properties).includes({
          vi: video.video_id,
          bytes: file.length
        })
      }
    }
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    client.analyticsApp = 'TS'
    await client.signOut()
    const rows =
      await sql`SELECT user_id FROM analytics.events WHERE event_name='logout'`.execute(
        h.db
      )
    expect(rows.rows).deep.equals([{ user_id: userIdOfGumbo(101) }])
  })
})
