import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertButtonIconCenters } from './buttonIconPixels'
import { capture, maestro } from './refinementsMaestro.e2e'

function disabledButtons(value: unknown): string[] {
  if (value == null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(disabledButtons)
  const node = value as Record<string, unknown>
  return [
    ...(node.type === 'Button' &&
    node.enabled === false &&
    typeof node.text === 'string'
      ? [node.text]
      : []),
    ...Object.values(node).flatMap(disabledButtons)
  ]
}

async function main(): Promise<void> {
  const directory = process.env.TS_ICON_ARTIFACTS
  const surface = process.env.TS_ICON_SURFACE
  const device = process.env.MAESTRO_DEVICE
  const appId = process.env.TS_ICON_APP_ID
  assert(
    directory != null && device != null && appId != null,
    'Supply TS_ICON_ARTIFACTS, MAESTRO_DEVICE and TS_ICON_APP_ID'
  )
  assert(
    surface === 'ios' || surface === 'android',
    'Supply native TS_ICON_SURFACE'
  )
  const daemon = await maestro(process.env.MAESTRO_D ?? 'buttonIconGallery')
  const log = ['$ node -r sucrase/register src/test/buttonIcons.gallery.e2e.ts']
  try {
    const m = await daemon.attach({ device, platform: surface, appId })
    try {
      await m.launchApp({ appId })
      await m.assertVisible({ text: 'Icon gallery', timeout: 30000 })
      await capture(m, directory, `${surface}-glyph-gallery-after.png`)
      const offsets = assertButtonIconCenters(
        await readFile(join(directory, `${surface}-glyph-gallery-after.png`))
      )
      log.push(`PASS glyph centers (points): ${JSON.stringify(offsets)}`)
      const names = ['home', 'menu', 'reply', 'more', 'check', 'pin']
      const disabled = disabledButtons(await m.hierarchy())
      for (const name of names) {
        assert(
          disabled.includes(`Disabled ${name}`),
          `${name} remains disabled`
        )
      }
      for (const size of ['Default', 'Large']) {
        for (const name of names) {
          const target = `${size} ${name}`
          await m.tapOn({ text: target, timeout: 10000 })
          await m.assertVisible({ text: `Action: ${target}`, timeout: 10000 })
        }
      }
      await m.tapOn({ text: 'Large vector', timeout: 10000 })
      await m.assertVisible({ text: 'Action: vector', timeout: 10000 })
      log.push(
        `PASS ${surface}: default/large action targets and disabled semantics`
      )
    } finally {
      await m.detach()
    }
  } finally {
    await daemon.shutdown()
    await writeFile(
      join(directory, `${surface}-gallery-actions.log`),
      log.join('\n') + '\n'
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
