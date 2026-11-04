import type { Migration } from '../runner'

/** Additive recovery state; encrypted history and signed boundaries are immutable. */
export const migration105ChatHistoryRecovery: Migration = {
  name: '105chatHistoryRecovery',
  up: `
alter table chat_conversations add column next_box_delivery_seq bigint not null default 1
  check (next_box_delivery_seq > 0);
alter table chat_epoch_boxes add column delivery_seq bigint;
with numbered as (
  select conversation_id, epoch, user_id, identity_id, generation,
    row_number() over (partition by conversation_id order by epoch,user_id,identity_id,generation) as seq
  from chat_epoch_boxes
)
update chat_epoch_boxes b set delivery_seq=n.seq from numbered n
where (b.conversation_id,b.epoch,b.user_id,b.identity_id,b.generation)=
  (n.conversation_id,n.epoch,n.user_id,n.identity_id,n.generation);
update chat_conversations c set next_box_delivery_seq=1+(
  select coalesce(max(b.delivery_seq),0) from chat_epoch_boxes b where b.conversation_id=c.id
);
alter table chat_epoch_boxes alter column delivery_seq set not null;
alter table chat_epoch_boxes add constraint chat_box_delivery_positive check (delivery_seq > 0);
create unique index chat_box_delivery_unique on chat_epoch_boxes(conversation_id,delivery_seq);
create index chat_box_delivery_recipient on chat_epoch_boxes(conversation_id,user_id,identity_id,delivery_seq);
-- Allocation and publication share the conversation transaction. Older writers
-- also acquire this lock, so a delayed insert cannot be skipped by a reader.
create function allocate_chat_box_delivery() returns trigger language plpgsql as $$
begin
  update chat_conversations set next_box_delivery_seq=next_box_delivery_seq+1
    where id=new.conversation_id returning next_box_delivery_seq-1 into new.delivery_seq;
  return new;
end $$;
create trigger chat_box_delivery before insert on chat_epoch_boxes
  for each row execute function allocate_chat_box_delivery();

create table chat_history_access (
  conversation_id text not null references chat_conversations(id) on delete cascade,
  user_id text not null,
  identity_id text not null,
  requires_approval boolean not null,
  approved_by_user_id text references users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(conversation_id,user_id,identity_id),
  foreign key(identity_id,user_id) references chat_identities(id,user_id) on delete cascade,
  check (not requires_approval or approved_at is null)
);
-- Only a grant to this identity establishes approval. Epoch publication and
-- filled/superseded requests alone are deliberately not proof of approval.
insert into chat_history_access(conversation_id,user_id,identity_id,requires_approval)
select m.conversation_id,m.user_id,i.id,
  (exists(select 1 from chat_grant_requests r where r.conversation_id=m.conversation_id
    and r.user_id=m.user_id and r.identity_id=i.id and r.identity_reset)
   or exists(select 1 from chat_membership_log l where l.conversation_id=m.conversation_id
    and l.user_id=m.user_id and l.event='identityReset' and l.at>=i.created_at))
  and not exists(select 1 from chat_epoch_boxes b where b.conversation_id=m.conversation_id
    and b.user_id=m.user_id and b.identity_id=i.id and b.granted_by_user_id is not null
    and b.granted_by_user_id<>m.user_id
        and exists(select 1 from chat_grant_requests approved
          where approved.conversation_id=b.conversation_id and approved.user_id=b.user_id
            and approved.identity_id=b.identity_id and approved.generation=b.generation
            and approved.identity_reset and approved.superseded_at is null
            and approved.filled_at=b.created_at))
from chat_members m join chat_identities i on i.user_id=m.user_id and i.replaced_at is null;

create table chat_history_requests (
  id bigint generated always as identity primary key,
  conversation_id text not null,
  user_id text not null,
  identity_id text not null,
  generation integer not null,
  segment_start_epoch integer not null check(segment_start_epoch>=1),
  target_epoch integer not null,
  covered_through_epoch integer not null,
  opened_at timestamptz not null default now(),
  filled_at timestamptz,
  superseded_at timestamptz,
  foreign key(conversation_id,target_epoch) references chat_epochs(conversation_id,epoch) on delete cascade,
  foreign key(user_id,identity_id,generation) references chat_user_keys(user_id,identity_id,generation) on delete cascade,
  check(segment_start_epoch<=target_epoch),
  check(covered_through_epoch between segment_start_epoch-1 and target_epoch),
  check((filled_at is not null)=(covered_through_epoch=target_epoch))
);
create unique index chat_history_request_active on chat_history_requests
  (conversation_id,user_id,identity_id,generation,target_epoch)
  where filled_at is null and superseded_at is null;
create index chat_history_request_pending on chat_history_requests(conversation_id,id)
  where filled_at is null and superseded_at is null;
`,
  down: `
do $$ begin
  if exists(select 1 from chat_history_requests) or exists(
    select 1 from chat_history_access where approved_at is not null
  ) then raise exception 'Chat recovery is in use; disable fresh publications instead'; end if;
end $$;
drop table chat_history_requests;
drop table chat_history_access;
drop trigger chat_box_delivery on chat_epoch_boxes;
drop function allocate_chat_box_delivery();
alter table chat_epoch_boxes drop column delivery_seq;
alter table chat_conversations drop column next_box_delivery_seq;
`
}
