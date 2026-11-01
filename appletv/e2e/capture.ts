import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

/** Visual evidence is opt-in and belongs to a verified real-data session. */
export function captureAllowed(): boolean {
  if (process.env.TV_CAPTURE_MODE === 'none') return false
  if (process.env.TV_CAPTURE_MODE !== 'production-copy')
    throw new Error(
      'Set TV_CAPTURE_MODE=none for fixtures or production-copy for verified real data'
    )
  const file = process.env.TV_EVIDENCE_MANIFEST
  if (file === undefined)
    throw new Error('A private verified evidence manifest is required')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (
    manifest.productionCopy !== true ||
    manifest.accountVerified !== true ||
    manifest.realRecordings !== true
  )
    throw new Error(
      'Visual capture requires verified production-copy data and real recordings'
    )
  return true
}

export async function captureScreenshot(
  tv: { screenshot: () => Promise<Uint8Array> },
  file: string
): Promise<void> {
  if (captureAllowed()) await writeFile(file, await tv.screenshot())
}
