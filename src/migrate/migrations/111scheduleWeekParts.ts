import type { Migration } from '../runner'

export const migration111ScheduleWeekParts: Migration = {
  name: '111scheduleWeekParts',
  up: `alter table season_schedule_settings
    add column max_games_on_weekdays integer not null default 1 check (max_games_on_weekdays between 0 and 200),
    add column max_games_on_weekend integer not null default 1 check (max_games_on_weekend between 0 and 200),
    add column prefer_game_on text not null default 'weekend' check (prefer_game_on in ('weekend', 'weekdays'));`,
  down: `alter table season_schedule_settings
    drop column max_games_on_weekdays,
    drop column max_games_on_weekend,
    drop column prefer_game_on;`
}
