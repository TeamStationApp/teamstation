import type { Migration } from '../runner'

export const migration077AnalyticsEvents: Migration = {
  name: '077analyticsEvents',
  up: `
CREATE SCHEMA analytics;
REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
CREATE TABLE analytics.events (
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  event_id uuid NOT NULL,
  app text NOT NULL CHECK (app IN ('TS','TS web')),
  event_name text NOT NULL,
  user_id text,
  session_id uuid,
  schema_revision integer NOT NULL CHECK (schema_revision=1),
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties)='object' AND octet_length(properties::text)<=4096),
  PRIMARY KEY (occurred_at,event_id)
);
REVOKE ALL ON analytics.events FROM PUBLIC;
CREATE INDEX analytics_event_time ON analytics.events(event_name,occurred_at);
CREATE INDEX analytics_user_time ON analytics.events(user_id,occurred_at);
CREATE INDEX analytics_video_time ON analytics.events((properties->>'vi'),occurred_at);
`,
  down: 'DROP TABLE analytics.events; DROP SCHEMA analytics;'
}
