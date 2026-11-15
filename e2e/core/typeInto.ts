/**
 * Typing on a phone. WebDriverAgent drops or swaps a key when a field redraws
 * under a whole string, so a value that can be read back is checked, and a
 * miss is typed one character at a time.
 */

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The driver's raw hierarchy, as text, or nothing when this device has none. */
async function hierarchyText(device: any): Promise<string | undefined> {
  if (typeof device.hierarchyRaw !== 'function') return undefined
  try {
    const raw = await device.hierarchyRaw()
    return typeof raw === 'string'
      ? raw
      : Buffer.from(raw as Uint8Array).toString('utf8')
  } catch {
    return undefined
  }
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The value a field reports in a raw hierarchy, when the driver includes one. */
export function valueFromHierarchy(
  raw: string,
  name: string
): string | undefined {
  if (raw.trimStart().startsWith('{')) {
    let flat: { nodes?: Array<{ identifier?: string; value?: string }> }
    try {
      flat = JSON.parse(raw)
    } catch {
      return undefined
    }
    return flat.nodes?.find(node => node.identifier === name)?.value
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const element = new RegExp(`<[^>]*\\bname="${escaped}"[^>]*>`).exec(raw)?.[0]
  if (element == null) return undefined
  const value = /\bvalue="([^"]*)"/.exec(element)?.[1]
  return value == null ? undefined : decode(value)
}

async function readField(
  device: any,
  name: string
): Promise<string | undefined> {
  const raw = await hierarchyText(device)
  if (raw == null || raw.trim() === '') return undefined
  return valueFromHierarchy(raw, name)
}

/** A secure field reports a bullet for each character instead of the text. */
function holds(actual: string, expected: string): boolean {
  if (actual === expected) return true
  return actual.length === expected.length && /^[•●*]+$/u.test(actual)
}

async function write(
  device: any,
  name: string,
  text: string,
  slowly: boolean
): Promise<void> {
  await device.tapOn({ text: name })
  if (typeof device.eraseText === 'function') {
    await device.eraseText({ characters: Math.max(text.length + 8, 80) })
  }
  if (!slowly) {
    await device.inputText({ text })
    return
  }
  for (const character of text) {
    await device.inputText({ text: character })
    await wait(150)
  }
}

/**
 * Replaces whatever `name` holds with `text`. When the driver reports the
 * field's value and the first try is short, types one character at a time.
 */
export async function typeInto(
  device: any,
  name: string,
  text: string
): Promise<void> {
  await write(device, name, text, false)
  const actual = await readField(device, name)
  if (actual == null || holds(actual, text)) return
  await write(device, name, text, true)
}
