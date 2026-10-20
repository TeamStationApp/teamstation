import type { Migration } from '../runner'

/** A scoring identity is allocated when a membership becomes a player. */
export const migration070PlayerGumboIds: Migration = {
  name: '070playerGumboIds',
  up: `
create function ts_membership_player_gumbo_id() returns trigger
language plpgsql as $player$
begin
  if new.is_player then
    perform ts_ensure_gumbo_id(new.user_id);
  end if;
  return new;
end
$player$;
create trigger memberships_player_gumbo_id
before insert or update of is_player, user_id on memberships
for each row execute function ts_membership_player_gumbo_id();
`,
  down: `do $restore$ begin
    raise exception 'Restore the verified pre-cutover backup and matching code; player scoring identities cannot be reversed safely';
  end $restore$;`
}
