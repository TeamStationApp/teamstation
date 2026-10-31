import type { Migration } from '../runner'

/** Declining a request never revokes a device or a decision made elsewhere. */
export const migration099ChatLinkDecisions: Migration = {
  name: '099ChatLinkDecisions',
  up: `
alter table chat_links add column declined_at timestamptz;
alter table chat_links add constraint chat_link_one_decision
  check (box is null or declined_at is null);
insert into notification_events
  (id, source_type, source_id, revision, actor_id, metadata, recorded_recipients, created_at)
select 'aud_' || md5('chatDeviceApproval:' || l.id), 'chatDeviceApproval', l.id, 1,
  l.user_id, jsonb_build_object('title', 'Approve chat device',
    'description', d.name || ' (' || d.platform || ') asks to read your chats.'),
  array[l.user_id], l.created_at
from chat_links l join chat_devices d on d.id = l.new_device_id
on conflict (source_type, source_id, revision) do nothing;
`,
  down: `
delete from notification_events where source_type = 'chatDeviceApproval';
alter table chat_links drop constraint chat_link_one_decision;
alter table chat_links drop column declined_at;
`
}
