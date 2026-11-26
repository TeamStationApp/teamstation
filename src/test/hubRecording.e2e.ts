import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

export interface RecordingDevice {
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: () => Promise<{ data?: unknown }>
  artifact: (path: string) => Promise<Uint8Array>
}

/** The leased device records its screen. The finalized MP4 lives on its hub. */
export async function recordHubDevice(
  device: RecordingDevice,
  path: string,
  run: () => Promise<void>
): Promise<void> {
  await device.startRecording({ path: basename(path) })
  try {
    await run()
  } finally {
    const { data } = await device.stopRecording()
    assert(typeof data === 'string' && data.startsWith('recordings/'))
    await writeFile(path, await device.artifact(data))
  }
}
