import type { Migration } from '../runner'

/**
 * The replay's announcer, spoken once per sentence. A row is keyed by the
 * digest of the voice, the speed, the emphasis and the words, so a sentence
 * every game says ("Ball two, two and oh.") is spoken once and served to
 * every game after. Nothing refers to a row; down drops the table.
 */
export const migration072NarrationAudio: Migration = {
  name: '072narrationAudio',
  up: `
create table narration_audio (
  digest text primary key,
  text text not null,
  voice text not null,
  audio bytea not null,
  created_at timestamptz not null default now()
);
`,
  down: `
drop table narration_audio;
`
}
