import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Device {
  launchApp: (value: Record<string, unknown>) => Promise<unknown>
  tapOn: (value: Record<string, unknown>) => Promise<unknown>
  assertVisible: (value: Record<string, unknown>) => Promise<unknown>
  evalBrowserScript: (
    value: Record<string, unknown>
  ) => Promise<{ data?: unknown }>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<unknown>
  detach: () => Promise<void>
}
interface Daemon {
  attach: (value: Record<string, unknown>) => Promise<Device>
  shutdown: () => Promise<void>
}
interface Client {
  connect: (value: Record<string, unknown>) => Promise<Daemon>
}

async function main(): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name]
    assert(value != null && value !== '', `Set ${name}`)
    return value
  }
  const platform = required('CARD_SPACING_PLATFORM')
  assert(['ios', 'android', 'web'].includes(platform))
  const directory = resolve(required('CARD_SPACING_ARTIFACTS'))
  await mkdir(directory, { recursive: true })
  const { MaestroD } = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )('maestro-d') as { MaestroD: Client }
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  let device: Device | undefined
  const measurements: unknown[] = []
  try {
    const appId =
      platform === 'web'
        ? required('CARD_SPACING_URL')
        : required('CARD_SPACING_APP_ID')
    device = await daemon.attach({
      device: required('CARD_SPACING_DEVICE'),
      platform,
      appId,
      artifacts: 'on-failure',
      commandTimeout: 30000,
      ...(platform === 'web'
        ? {
            extra: {
              browser: 'chromium',
              windowSize: required('CARD_SPACING_WINDOW')
            }
          }
        : {})
    })
    const m = device
    if (platform !== 'web') {
      await m.launchApp({ appId })
    }
    await m.tapOn({ text: '^Evidence$', timeout: 15000 })
    for (const [button, filename, rows, title] of [
      ['Single line', 'single-line', 1, 'One row, one text line'],
      ['Two lines', 'two-lines', 1, 'One row, two text lines'],
      [
        'One-line list',
        'multi-row-single-line',
        4,
        'Four rows, one text line each'
      ],
      [
        'Two-line list',
        'multi-row-two-lines',
        4,
        'Four rows, two text lines each'
      ]
    ] as const) {
      await m.tapOn({ text: `^${button}$`, timeout: 10000 })
      await m.assertVisible({ text: title, timeout: 10000 })
      await m.assertVisible({
        text:
          rows === 1
            ? '^Single row(, Second text line)?$'
            : '^First row(, Second text line)?$',
        timeout: 10000
      })
      if (rows > 1)
        await m.assertVisible({
          text: '^Final row(, Second text line)?$',
          timeout: 10000
        })
      if (platform === 'web') {
        const result = await m.evalBrowserScript({
          script: `
          await document.fonts.ready;
          const card = document.querySelector('[data-testid="spacing-evidence-card"]').firstElementChild;
          const bounds = card.getBoundingClientRect();
          if (bounds.top < 0 || bounds.bottom > window.innerHeight) throw new Error('Card is clipped');
          const rows = Array.from(card.children).filter(node => node.getAttribute('role') === 'button');
          if (rows.length !== ${rows}) throw new Error('Wrong row count');
          const measured = rows.map(row => {
            const box = row.getBoundingClientRect();
            const children = Array.from(row.children).map(child => child.getBoundingClientRect());
            const insets = [Math.min(...children.map(b => b.top)) - box.top,
              box.bottom - Math.max(...children.map(b => b.bottom)),
              Math.min(...children.map(b => b.left)) - box.left,
              box.right - Math.max(...children.map(b => b.right))];
            if (insets.some(n => Math.abs(n - 16) > 0.6)) throw new Error('Unequal row insets: ' + insets);
            return { row: row.getAttribute('aria-label'), insets };
          });
          return JSON.stringify({ case: ${JSON.stringify(filename)}, card: { top: bounds.top, bottom: bounds.bottom }, measured });
        `
        })
        measurements.push(result.data)
      }
      await writeFile(join(directory, `${filename}.png`), await m.screenshot())
      await writeFile(
        join(directory, `${filename}.json`),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      await m.tapOn({
        text:
          rows === 1
            ? '^Single row(, Second text line)?$'
            : '^Final row(, Second text line)?$',
        timeout: 10000
      })
      await m.assertVisible({
        text: `${rows === 1 ? 'Single row' : 'Final row'} opened`,
        timeout: 10000
      })
    }
    await writeFile(
      join(directory, 'measurements.json'),
      JSON.stringify(measurements, null, 2)
    )
    console.log(
      `${platform}: four screenshot cases passed; first/final rows visible and tappable`
    )
  } finally {
    await device?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
