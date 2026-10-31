import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

const HOLD = 'teamstation.event_children_held'

/**
 * Runs writes to many events with the row-by-row `events_sync_children`
 * trigger held back, in a transaction that rebuilds those events' children
 * itself with `rebuildEventChildren` afterwards. The hold ends with `work`,
 * so the rest of the transaction fires as usual.
 */
export async function holdingEventChildren<T>(
  trx: Kysely<Database>,
  work: () => Promise<T>
): Promise<T> {
  if (!trx.isTransaction)
    throw new Error('An event children hold lasts for a transaction')
  await sql`select set_config(${HOLD}, 'on', true)`.execute(trx)
  const result = await work()
  await sql`select set_config(${HOLD}, 'off', true)`.execute(trx)
  return result
}

/**
 * Leaves many events' children as `events_sync_children` would, in two
 * statements however many events: the credits and the batter, pitcher and
 * runners as they read from each event's record, with the pitcher's team read
 * from the game's teams as they stand now. Rows that already read so are not
 * written, so they keep their ids; nothing refers to those ids. A test holds
 * this and the trigger to the same rows.
 */
export async function rebuildEventChildren(
  trx: Kysely<Database>,
  eventIds: readonly string[]
): Promise<void> {
  if (eventIds.length === 0) return
  const ids = [...eventIds]
  // An event's credits have no key of their own and may repeat, so an event
  // whose whole list differs has its whole list replaced.
  await sql`
    with wanted as materialized (
      select
        e.id as event_id,
        coalesce(credit->>'eventType', '') as event_type,
        credit->>'teamId' as team_id,
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end as credit_gumbo_id,
        credit #>> '{credit,role}' as role,
        credit #>> '{credit,position}' as position,
        coalesce(credit->>'head', '') as head,
        credit->>'suffix' as suffix,
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'gumboId',
              case
                when jsonb_typeof(assist->'creditUserId') = 'number'
                  then assist->'creditUserId'
                else 'null'::jsonb
              end,
              'position',
              case
                when jsonb_typeof(assist->'position') = 'string'
                  then assist->'position'
                else 'null'::jsonb
              end
            ) || case
              when jsonb_typeof(assist->'creditUserId') <> 'number'
                   and jsonb_typeof(assist->'name') = 'string'
                then jsonb_build_object('name', assist->'name')
              else '{}'::jsonb
            end
            order by ordinal
          )
          from jsonb_array_elements(
            case
              when jsonb_typeof(credit->'assists') = 'array'
                then credit->'assists'
              else '[]'::jsonb
            end
          ) with ordinality as listed(assist, ordinal)
          where jsonb_typeof(assist) = 'object'
        ), '[]'::jsonb) as assists,
        credit->>'assistWord' as assist_word,
        case
          when jsonb_typeof(credit->'creditUserId') = 'number' then null
          when jsonb_typeof(credit #> '{credit,name}') = 'string'
            then nullif(credit #>> '{credit,name}', '')
          else null
        end as typed_name,
        credit->'positionShown' is distinct from 'false'::jsonb as position_shown
      from events e
      cross join lateral (select e.gumbo->'credits' offset 0) as one(credits)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(one.credits) = 'array' then one.credits
          else '[]'::jsonb
        end
      ) as listed(credit)
      where e.id = any(${ids}::text[])
    ),
    wanted_lists as (
      select event_id, array_agg(w::text order by w::text) as list
      from wanted w group by event_id
    ),
    held_lists as (
      select event_id, array_agg(h::text order by h::text) as list
      from (
        select "eventId" as event_id, "eventType", "teamId", "creditGumboId",
          role, position, head, suffix, assists, "assistWord", "typedName",
          "positionShown"
        from "eventCredits" where "eventId" = any(${ids}::text[])
      ) h group by event_id
    ),
    stale as (
      select event_id from wanted_lists w
      full join held_lists h using (event_id)
      where w.list is distinct from h.list
    ),
    removed as (
      delete from "eventCredits"
      where "eventId" in (select event_id from stale)
    )
    insert into "eventCredits" (
      id, "eventId", "eventType", "teamId", "creditGumboId",
      role, position, head, suffix, assists, "assistWord", "typedName",
      "positionShown"
    )
    select ts_make_id('evc'), w.event_id, w.event_type, w.team_id,
      w.credit_gumbo_id, w.role, w.position, w.head, w.suffix, w.assists,
      w.assist_word, w.typed_name, w.position_shown
    from wanted w
    where w.event_id in (select event_id from stale)
  `.execute(trx)
  // Casts sit inside a case: a where beside them may run after them.
  await sql`
    with stored as (
      select
        e.id,
        e."gameId" as game_id,
        e."battingTeamId" as batting,
        one.gumbo #> '{matchup,batter,id}' as batter,
        one.gumbo #> '{matchup,pitcher,id}' as pitcher,
        one.gumbo->'runners' as runners,
        one.gumbo ? 'matchup' or one.gumbo ? 'runners' or one.gumbo ? 'playEvents' as applies
      from events e
      cross join lateral (select jsonb_build_array(e.gumbo)->0 offset 0) as one(gumbo)
      where e.id = any(${ids}::text[])
    ),
    source as materialized (
      select
        s.id,
        s.batting,
        s.runners,
        case
          when s.batting is null then null
          when s.batting = g.home_team_id then g.away_team_id
          when s.batting = g.away_team_id then g.home_team_id
          else null
        end as pitching,
        case
          when jsonb_typeof(s.batter) = 'number' and s.batter::text ~ '^[0-9]+$'
            then s.batter::text::bigint
        end as batter,
        case
          when jsonb_typeof(s.pitcher) = 'number' and s.pitcher::text ~ '^[0-9]+$'
            then s.pitcher::text::bigint
        end as pitcher
      from stored s
      left join games g on g.id = s.game_id
      where s.applies
    ),
    runners as (
      select distinct s.id, s.batting, s.batter, on_base.runner
      from source s
      cross join lateral (
        select case
          when jsonb_typeof(value #> '{details,runner,id}') = 'number'
            and (value #>> '{details,runner,id}') ~ '^[0-9]+$'
            then (value #>> '{details,runner,id}')::bigint
        end as runner
        from jsonb_array_elements(
          case
            when jsonb_typeof(s.runners) = 'array' then s.runners
            else '[]'::jsonb
          end
        )
      ) as on_base
      where on_base.runner is not null
    ),
    wanted as materialized (
      select id as event_id, batter as gumbo_id, batting as team_id, 'batter' as role
      from source where batter is not null
      union all
      select id, pitcher, pitching, 'pitcher' from source where pitcher is not null
      union all
      select id, runner, batting, 'runner' from runners
      where runner is distinct from batter
    ),
    changed as (
      update event_players p set team_id = w.team_id, position = null
      from wanted w
      where p.event_id = any(${ids}::text[])
        and p.event_id = w.event_id and p.gumbo_id = w.gumbo_id and p.role = w.role
        and (p.team_id is distinct from w.team_id or p.position is not null)
    ),
    removed as (
      delete from event_players p
      where p.event_id = any(${ids}::text[])
        and p.event_id in (select id from source)
        and p.role in ('batter', 'pitcher', 'runner')
        and not exists (
          select 1 from wanted w
          where w.event_id = p.event_id and w.gumbo_id = p.gumbo_id and w.role = p.role
        )
    )
    insert into event_players (id, event_id, gumbo_id, team_id, role)
    select ts_make_id('evp'), w.event_id, w.gumbo_id, w.team_id, w.role
    from wanted w
    where not exists (
      select 1 from event_players p
      where p.event_id = any(${ids}::text[])
        and p.event_id = w.event_id and p.gumbo_id = w.gumbo_id and p.role = w.role
    )
  `.execute(trx)
}
