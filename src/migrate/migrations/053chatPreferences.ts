import { chatUserIdBootstrap } from '../chatUserIdBootstrap'
import type { Migration } from '../runner'

/** Personal chat metadata contains no message content or encryption keys. */
export const migration053ChatPreferences: Migration = {
  name: '053chatPreferences',
  up: chatUserIdBootstrap(`
create table chat_conversation_preferences (
  user_id __chat_user_id_type__ not null references users (id) on delete cascade,
  conversation_id text not null references chat_conversations (id) on delete cascade,
  pinned boolean not null default false,
  muted boolean not null default false,
  manual_unread boolean not null default false,
  manual_unread_revision bigint not null default 0,
  primary key (user_id, conversation_id)
);
create table chat_message_pins (
  user_id __chat_user_id_type__ not null references users (id) on delete cascade,
  conversation_id text not null references chat_conversations (id) on delete cascade,
  message_id text not null references chat_messages (id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (user_id, conversation_id, message_id)
);
create index chat_message_pins_message on chat_message_pins (message_id);
`),
  down: `drop table chat_message_pins; drop table chat_conversation_preferences;`
}
