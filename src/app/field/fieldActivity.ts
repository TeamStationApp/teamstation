import type { FieldPlayer } from './fieldModel'

/**
 * What the field is showing, in strings a browser test can read off the
 * field's element: the picture playing — `none`, or its kind and stage, such
 * as `hit:flight` — that picture's own id, so two pitches in a row are two,
 * and the ids of the players it is moving, in order.
 */
export function fieldActivity(
  presentation: { id: string; kind: string; stage: string } | null | undefined,
  players: readonly FieldPlayer[]
): { presentation: string; id: string; moving: string } {
  return {
    id: presentation?.id ?? '',
    presentation:
      presentation == null
        ? 'none'
        : `${presentation.kind}:${presentation.stage}`,
    moving: players
      .filter(player => player.motion != null && player.playerId != null)
      .map(player => player.playerId!)
      .sort((a, b) => a - b)
      .join(',')
  }
}
