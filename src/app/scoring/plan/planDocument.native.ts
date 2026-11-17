import ReactNativeBlobUtil from 'react-native-blob-util'
import { fromByteArray } from 'react-native-quick-base64'

import NativePlanDocument from './NativePlanDocument'
import type { PlanDocumentAnchor } from './planDocumentAnchor'

/** The hand-offs before this one whose files stay, for an app still reading. */
const KEPT = 2

/**
 * Writes the PDF to the cache, by its own name, and answers its path. Each
 * hand-off writes into a folder of its own under `plan-documents/`, named
 * for when it was made; the oldest go, all but the last few, so a share
 * still sending an earlier PDF keeps its file and the cache never fills.
 */
async function cached(bytes: Uint8Array, fileName: string): Promise<string> {
  const fs = ReactNativeBlobUtil.fs
  const root = `${fs.dirs.CacheDir}/plan-documents`
  const made = (await fs.exists(root)) ? await fs.ls(root) : []
  const old = made
    .filter(name => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b))
    .slice(0, -KEPT)
  for (const name of old)
    await fs.unlink(`${root}/${name}`).catch(() => undefined)
  const directory = `${root}/${Date.now()}`
  await fs.mkdir(directory)
  const path = `${directory}/${fileName}`
  await fs.writeFile(path, fromByteArray(bytes), 'base64')
  return path
}

function bridge(): NonNullable<typeof NativePlanDocument> {
  if (NativePlanDocument == null)
    throw new Error('This build cannot share or print a game plan')
  return NativePlanDocument
}

/**
 * Offers the game plan PDF to the system's share sheet, which on an iPad
 * points at `anchor`, the pressed control's place in the window.
 */
export async function sharePlanDocument(
  bytes: Uint8Array,
  fileName: string,
  anchor: PlanDocumentAnchor
): Promise<void> {
  const module = bridge()
  await module.share(
    await cached(bytes, fileName),
    anchor.x,
    anchor.y,
    anchor.width,
    anchor.height
  )
}

/**
 * Opens the system's print dialog on the game plan PDF, which on an iPad
 * points at `anchor`.
 */
export async function printPlanDocument(
  bytes: Uint8Array,
  fileName: string,
  anchor: PlanDocumentAnchor
): Promise<void> {
  const module = bridge()
  await module.print(
    await cached(bytes, fileName),
    fileName.replace(/\.pdf$/, ''),
    anchor.x,
    anchor.y,
    anchor.width,
    anchor.height
  )
}
