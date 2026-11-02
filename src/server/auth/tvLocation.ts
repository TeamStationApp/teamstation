/** Optional local GeoIP adapter. Location never delays or prevents sign-in. */
export async function tvLocation(
  ip: string | null,
  lookup?: (ip: string) => Promise<string | null>,
  timeoutMs = 250
): Promise<string | null> {
  if (ip == null || lookup == null) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      lookup(ip),
      new Promise<null>(resolve => {
        timer = setTimeout(() => {
          resolve(null)
        }, timeoutMs)
      })
    ])
    return typeof result === 'string' && result.trim() !== ''
      ? result.trim().slice(0, 160)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
