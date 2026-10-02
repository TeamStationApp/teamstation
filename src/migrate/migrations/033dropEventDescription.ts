import type { Migration } from '../runner'

/**
 * Every play stored before this migration came from another service, and none
 * keeps the sentence written for it. What the app shows for a play is
 * GameStation's own reading of it — its type, who is credited, the score —
 * drawn when it is shown, so that text is dropped from each stored play and
 * the column that exposed it goes. Nothing is lost that a play's type and
 * credits do not say. A play posted later keeps its sentences only when
 * GameStation or a person wrote them; see `storedGumbo`.
 */
export const migration033DropEventDescription: Migration = {
  name: '033dropEventDescription',
  up: `
alter table events drop column description;

update events
set gumbo = gumbo #- '{result,description}'
where gumbo #> '{result,description}' is not null;
`,
  down: `
alter table events
  add column description text
    generated always as ((gumbo #>> '{result,description}')) virtual;
`
}
