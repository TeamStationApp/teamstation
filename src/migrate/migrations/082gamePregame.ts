import type { Migration } from '../runner'

/**
 * The lineups a game is saved with before its first pitch, kept as a
 * team-keyed record of its own rather than as a Gumbo play: no play is
 * written until a pitch is thrown. A game that has not begun (no stored
 * play, not under way or final, and an at-bat record of lineup changes only)
 * moves its record here. Down gives every game holding only such a record a
 * play at the top of the 1st that carries it again. Records written since
 * are version 3, which code from before this release cannot read: the
 * release is forward-only, and going back means restoring the database.
 */
export const migration082GamePregame: Migration = {
  name: '082gamePregame',
  up: `alter table games add column pregame jsonb;
    update games g set pregame = g."currentPlay"->'teamStation', "currentPlay" = null
      where jsonb_typeof(g."currentPlay"->'teamStation') = 'object'
        and g.status not in ('inProgress', 'final')
        and not exists (select 1 from events e where e."gameId" = g.id)
        and coalesce(jsonb_array_length(case when jsonb_typeof(g."currentPlay"->'playEvents') = 'array'
          then g."currentPlay"->'playEvents' end), 0) = 0
        and not exists (
          select 1 from jsonb_array_elements(case when jsonb_typeof(g."currentPlay"->'teamStation'->'actions') = 'array'
            then g."currentPlay"->'teamStation'->'actions' else '[]'::jsonb end) action
          where action->>'type' is distinct from 'lineup');`,
  down: `update games g set "currentPlay" = jsonb_build_object(
        'about', '{"atBatIndex":0,"inning":1,"halfInning":"top","isTopInning":true,"isComplete":false,"hasOut":false,"hasReview":false}'::jsonb,
        'teamStation', g.pregame)
      where g.pregame is not null and g."currentPlay" is null
        and not exists (select 1 from events e where e."gameId" = g.id);
    alter table games drop column pregame;`
}
