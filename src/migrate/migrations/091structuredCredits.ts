import { withStructuredCredits } from '../../common/scoring/storedNames'
import { type Migration, rewriteJson } from '../runner'

/**
 * Credits stored with their structure. A credit's label is worded from its
 * head, its person and position, a suffix and the fielders who assisted
 * (`creditLabel`), so each `"eventCredits"` row gains those columns: `head`,
 * `suffix`, `assists` (each `{ gumboId, position, name? }`, the name only for
 * a fielder with no id), `"assistWord"` (`from` or `to`) and `"typedName"`,
 * which only a credit naming nobody by id may hold.
 *
 * `events_sync_children` copies the structure out of each stored credit as
 * well as its label and name. The step gives every stored credit its
 * structure (`withStructuredCredits`: an engine credit has it already, and
 * one sent with only a label is read from it), keeping its label and name,
 * so the trigger refires on each play it changed; a play whose credits were
 * structured already is refired by the SQL.
 *
 * Rolling back drops the columns and puts the trigger function back as 068
 * left it.
 */

/** `events_sync_children` as 068 left it, between its dollar quotes. */
const SYNC_CHILDREN_068 = `
declare
  credit jsonb;
  runner jsonb;
  runner_id bigint;
  home_id text;
  away_id text;
  pitcher_team text;
begin
  delete from "eventCredits" where "eventId" = new.id;
  if jsonb_typeof(new.gumbo -> 'credits') = 'array' then
    for credit in
      select value from jsonb_array_elements(new.gumbo -> 'credits')
    loop
      insert into "eventCredits" (
        id, "eventId", "eventType", label, "teamId", "creditGumboId",
        name, role, position
      ) values (
        ts_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        coalesce(credit->>'label', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        coalesce(credit #>> '{credit,name}', ''),
        credit #>> '{credit,role}',
        credit #>> '{credit,position}'
      );
    end loop;
  end if;

  if new.gumbo ? 'matchup'
     or new.gumbo ? 'runners'
     or new.gumbo ? 'playEvents' then
    delete from event_players
    where event_id = new.id
      and role in ('batter', 'pitcher', 'runner');

    if jsonb_typeof(new.gumbo #> '{matchup,batter,id}') = 'number'
       and (new.gumbo #>> '{matchup,batter,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, gumbo_id, team_id, role)
      values (
        ts_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,batter,id}')::bigint,
        new."battingTeamId",
        'batter'
      );
    end if;

    select g.home_team_id, g.away_team_id into home_id, away_id
    from games g
    where g.id = new."gameId";

    pitcher_team := case
      when new."battingTeamId" is null then null
      when new."battingTeamId" = home_id then away_id
      when new."battingTeamId" = away_id then home_id
      else null
    end;

    if jsonb_typeof(new.gumbo #> '{matchup,pitcher,id}') = 'number'
       and (new.gumbo #>> '{matchup,pitcher,id}') ~ '^[0-9]+$' then
      insert into event_players (id, event_id, gumbo_id, team_id, role)
      values (
        ts_make_id('evp'),
        new.id,
        (new.gumbo #>> '{matchup,pitcher,id}')::bigint,
        pitcher_team,
        'pitcher'
      );
    end if;

    if jsonb_typeof(new.gumbo -> 'runners') = 'array' then
      for runner in
        select value from jsonb_array_elements(new.gumbo -> 'runners')
      loop
        if jsonb_typeof(runner #> '{details,runner,id}') = 'number'
           and (runner #>> '{details,runner,id}') ~ '^[0-9]+$' then
          runner_id := (runner #>> '{details,runner,id}')::bigint;
          if jsonb_typeof(new.gumbo #> '{matchup,batter,id}') = 'number'
             and (new.gumbo #>> '{matchup,batter,id}') ~ '^[0-9]+$'
             and runner_id = (new.gumbo #>> '{matchup,batter,id}')::bigint then
            continue;
          end if;
          if not exists (
            select 1 from event_players
            where event_id = new.id
              and gumbo_id = runner_id
              and role = 'runner'
          ) then
            insert into event_players (id, event_id, gumbo_id, team_id, role)
            values (
              ts_make_id('evp'),
              new.id,
              runner_id,
              new."battingTeamId",
              'runner'
            );
          end if;
        end if;
      end loop;
    end if;
  end if;
  return null;
end
`

/** 068's insert of one credit. */
const CREDIT_068 = `      insert into "eventCredits" (
        id, "eventId", "eventType", label, "teamId", "creditGumboId",
        name, role, position
      ) values (
        ts_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        coalesce(credit->>'label', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        coalesce(credit #>> '{credit,name}', ''),
        credit #>> '{credit,role}',
        credit #>> '{credit,position}'
      );
`

/** One credit's row, its structure copied as well as its label and name. */
const CREDIT_091 = `      insert into "eventCredits" (
        id, "eventId", "eventType", label, "teamId", "creditGumboId",
        name, role, position, head, suffix, assists, "assistWord"
      ) values (
        ts_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        coalesce(credit->>'label', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        coalesce(credit #>> '{credit,name}', ''),
        credit #>> '{credit,role}',
        credit #>> '{credit,position}',
        coalesce(credit->>'head', ''),
        credit->>'suffix',
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
        ), '[]'::jsonb),
        credit->>'assistWord'
      );
`

function syncChildren(body: string): string {
  return `create or replace function events_sync_children()
returns trigger language plpgsql as $fn$${body}$fn$;`
}

const SYNC_CHILDREN_091 = SYNC_CHILDREN_068.replace(CREDIT_068, CREDIT_091)
if (SYNC_CHILDREN_091 === SYNC_CHILDREN_068)
  throw new Error('091structuredCredits: no credit insert to replace')

export const migration091StructuredCredits: Migration = {
  name: '091structuredCredits',
  up: `
alter table "eventCredits"
  add column head text not null default '',
  add column suffix text,
  add column assists jsonb not null default '[]',
  add column "assistWord" text,
  add column "typedName" text,
  add constraint "eventCredits_typedName_check"
    check ("creditGumboId" is null or "typedName" is null);
alter table "eventCredits" alter column head drop default;

${syncChildren(SYNC_CHILDREN_091)}

-- Plays whose credits carry their structure already; the step rewrites
-- the rest, which refires the trigger on them.
update events set gumbo = gumbo
where jsonb_typeof(gumbo -> 'credits') = 'array'
  and exists (
    select 1 from jsonb_array_elements(gumbo -> 'credits') as listed(credit)
    where jsonb_typeof(credit) = 'object' and credit ? 'head'
  );
`,
  steps: async client => {
    await rewriteJson(
      client,
      {
        table: 'events',
        column: 'gumbo',
        where: `jsonb_typeof(gumbo -> 'credits') = 'array'`
      },
      withStructuredCredits
    )
  },
  down: `
${syncChildren(SYNC_CHILDREN_068)}

alter table "eventCredits"
  drop constraint "eventCredits_typedName_check",
  drop column head,
  drop column suffix,
  drop column assists,
  drop column "assistWord",
  drop column "typedName";
`
}
