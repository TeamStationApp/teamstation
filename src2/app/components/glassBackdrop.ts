/**
 * The web's `backdrop-filter`, read for Android: `blur(24px) saturate(200%)`
 * is a 24 point radius and twice the saturation.
 */
export function backdropOf(filter: string): {
  radius: number
  saturation: number
} {
  const radius = /blur\(\s*([\d.]+)px\s*\)/.exec(filter)
  const saturation = /saturate\(\s*([\d.]+)%\s*\)/.exec(filter)
  return {
    radius: radius == null ? 0 : Number(radius[1]),
    saturation: saturation == null ? 1 : Number(saturation[1]) / 100
  }
}
