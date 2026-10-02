import { writeFile } from 'node:fs/promises'

import { makeDatabase } from '../db/database'
import { camerasFromTiles } from '../media/cameras'
import { videoFrameSource } from '../media/locations'
import { ensureStill } from '../media/stills'
import { serverConfig } from '../serverConfig'

/**
 * Which of the recordings we already hold are multi-angle, and of how many.
 *
 * The `raw` and `combined` suffixes mark a multi-angle recording, but the name
 * alone cannot say how many cameras: some of those hold two and some three.
 * Only the picture knows, so this is a script with a look-at-it step rather
 * than a single UPDATE.
 *
 *   npm run camera-sweep              cut a frame each and write the CSV
 *   npm run camera-sweep -- --apply   apply a reviewed CSV
 *
 * The first pass writes nothing to the database. Somebody reads the frames,
 * fills in the tile count, and the second pass applies it — a wrong count
 * mislabels a recording permanently and there are not many to look at.
 *
 * Tiles are not cameras: one tile is always the program output, so four
 * tiles is three cameras and three tiles is two.
 */
const CSV = '/tmp/tsCameraSweep.csv'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    const candidates = await db
      .selectFrom('videos')
      .select(['id', 'title', 'storage', 'num_cameras', 'duration_sec'])
      .where(eb =>
        eb.or([eb('title', 'like', '%raw'), eb('title', 'like', '%combined')])
      )
      .orderBy('title')
      .execute()

    if (!apply) {
      const lines = ['videoId,title,tiles,numCameras,stillPath']
      for (const video of candidates) {
        // A little way in, not frame zero: the mosaic is not populated until
        // every camera has sent something.
        const atSec = Math.min(120, (video.duration_sec ?? 600) / 4)
        let still = ''
        try {
          const source = await videoFrameSource({
            mediaRoot: serverConfig.mediaDir,
            space: serverConfig.space,
            storage: video.storage,
            videoId: video.id
          })
          if (source != null) {
            still = await ensureStill({
              ffmpegPath: serverConfig.ffmpegPath,
              source,
              space: serverConfig.space,
              videoId: video.id,
              atSec,
              width: 960
            })
          }
        } catch (error) {
          still = `(no frame: ${
            error instanceof Error ? error.message : String(error)
          })`
        }
        lines.push(
          `${video.id},"${video.title.replace(/"/g, '""')}",,,${still}`
        )
        console.log(`${video.title}\n  ${still}`)
      }
      await writeFile(CSV, lines.join('\n') + '\n')
      console.log(
        `\n${candidates.length} to look at. Fill in the tiles column of ${CSV},` +
          ' then run again with --apply. Nothing has been written.'
      )
      return
    }

    const { readFile } = await import('node:fs/promises')
    const rows = (await readFile(CSV, 'utf8')).split('\n').slice(1)
    let applied = 0
    const unclear: string[] = []
    for (const row of rows) {
      if (row.trim() === '') continue
      const [videoId, , tilesText] = row.split(',')
      const cameras = camerasFromTiles(Number(tilesText))
      if (videoId == null || cameras == null) {
        if (videoId != null) unclear.push(videoId)
        continue
      }
      await db
        .updateTable('videos')
        .set({ num_cameras: cameras })
        .where('id', '=', videoId)
        .execute()
      applied += 1
    }
    console.log(`set the camera count on ${applied}`)
    for (const id of unclear) console.log(`  left alone, no tile count: ${id}`)
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
