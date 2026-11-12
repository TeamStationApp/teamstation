/** The selected fields' zones, with the same fallback for search and validation. */
export function seasonZones(
  fields: Iterable<{
    id: string
    sizes: readonly string[]
    availability: { timezone: string }
  }>,
  settings: { fieldIds?: string[]; fieldSize: string }
): string[] {
  const all = [...fields]
  const selected = all.filter(
    field =>
      (settings.fieldIds ?? []).includes(field.id) &&
      field.sizes.includes(settings.fieldSize)
  )
  const zones = (selected.length > 0 ? selected : all.slice(0, 1)).map(
    field => field.availability.timezone
  )
  return zones.length > 0 ? [...new Set(zones)] : ['UTC']
}
