import type { Migration } from '../runner'

export const migration074OptionalUmpires: Migration = {
  name: '074optionalUmpires',
  up: `
alter table season_umpire_requirements add column optional_field_count integer not null default 0 check (optional_field_count between 0 and 6);
alter table umpire_assignments drop constraint umpire_assignments_slot_check;
alter table umpire_assignments add constraint umpire_assignments_slot_check check (slot = 'plate' or slot ~ '^field:([1-9]|1[0-2])$');
`,
  down: `
-- Adding the original constraint first refuses rollback if extended slots exist.
alter table umpire_assignments drop constraint umpire_assignments_slot_check;
alter table umpire_assignments add constraint umpire_assignments_slot_check check (slot = 'plate' or slot ~ '^field:[1-6]$');
alter table season_umpire_requirements drop column optional_field_count;
`
}
