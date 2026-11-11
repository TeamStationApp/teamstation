import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertButtonIconCenters } from './buttonIconPixels'
import { capture, maestro, type MaestroHandle } from './refinementsMaestro.e2e'

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

async function captureGeometry(
  m: MaestroHandle,
  directory: string,
  file: string
): Promise<Buffer> {
  await m.tapOn({ text: 'Hide artwork', timeout: 10000 })
  await m.assertVisible({ text: 'Show artwork', timeout: 10000 })
  await capture(m, directory, `${file}-geometry.png`)
  await m.tapOn({ text: 'Show artwork', timeout: 10000 })
  await m.assertVisible({ text: 'Hide artwork', timeout: 10000 })
  return await readFile(join(directory, `${file}-geometry.png`))
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
      const fontOnly = process.env.TS_ICON_FONT_ONLY === '1'
      if (!fontOnly) {
        for (const example of ['left', 'right', 'plus', 'styled'])
          await m.assertVisible({
            text: `Width kept: ${example}`,
            timeout: 10000
          })
        log.push(
          'PASS original text advances and styled box dimensions preserved'
        )
        await capture(m, directory, `${surface}-glyph-gallery-after.png`)
        const offsets = assertButtonIconCenters(
          await readFile(join(directory, `${surface}-glyph-gallery-after.png`)),
          await captureGeometry(m, directory, `${surface}-glyph-gallery-after`)
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
      }
      await m.tapOn({ text: 'Font glyphs', timeout: 10000 })
      await m.assertVisible({ text: 'Font glyph gallery', timeout: 10000 })
      const hierarchy = JSON.stringify(await m.hierarchy())
      const fontScale = Number(/Font scale: ([0-9.]+)/.exec(hierarchy)?.[1])
      assert(Number.isFinite(fontScale), 'Native font scale is reported')
      if (fontOnly)
        assert(
          fontScale >= 1.8,
          `Large system font scale required: ${fontScale}`
        )
      const phase = fontOnly ? 'scaled' : 'default'
      const file = `${surface}-font-gallery-${phase}`
      await capture(m, directory, `${file}.png`)
      const measurements = assertButtonIconCenters(
        await readFile(join(directory, `${file}.png`)),
        await captureGeometry(m, directory, file),
        {
          targets: 12,
          measured: 12,
          diameter: 64,
          dimensions: true
        }
      )
      if (fontOnly) {
        const baseline = JSON.parse(
          await readFile(
            join(directory, `${surface}-font-gallery-default.json`),
            'utf8'
          )
        ) as { fontScale: number; measurements: number[][] }
        for (let index = 0; index < measurements.length; index++) {
          const expected =
            index === 11
              ? 1
              : index === 10
                ? Math.min(fontScale, 1.5)
                : fontScale
          const oldScale =
            index === 11
              ? 1
              : index === 10
                ? Math.min(baseline.fontScale, 1.5)
                : baseline.fontScale
          for (const dimension of [2, 3])
            assert(
              Math.abs(
                measurements[index][dimension] -
                  (baseline.measurements[index][dimension] * expected) /
                    oldScale
              ) <= 1.5,
              `Glyph ${index} scales its ink dimension ${dimension} once (including cap/opt-out)`
            )
        }
      }
      await writeFile(
        join(directory, `${file}.json`),
        JSON.stringify({ fontScale, measurements }, null, 2)
      )
      log.push(
        `PASS font glyphs at scale ${fontScale}: ${JSON.stringify(measurements)}`
      )
    } finally {
      await m.detach()
    }
  } finally {
    await daemon.shutdown()
    await writeFile(
      join(
        directory,
        `${surface}-gallery-actions${process.env.TS_ICON_FONT_ONLY === '1' ? '-scaled' : ''}.log`
      ),
      log.join('\n') + '\n'
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
