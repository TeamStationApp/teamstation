import type { Migration } from '../runner'
export const migration099TvLogin: Migration = {
  name: '099tvLogin',
  up: `create table tv_login_requests (
    id text primary key, code_hash text not null unique, qr_hash text not null unique,
    secret_hash text not null, platform text not null check (platform in ('Apple TV','Google TV')),
    location text, user_id text references users(id), approved_at timestamptz,
    consumed_at timestamptz, expires_at timestamptz not null, created_at timestamptz not null default now()
  ); create index tv_login_expiry on tv_login_requests(expires_at);`,
  down: 'drop table tv_login_requests;'
}
