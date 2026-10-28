ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN forward_id TEXT;
ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_events ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE delivery_events ADD COLUMN recipient TEXT NOT NULL DEFAULT '';
ALTER TABLE delivery_events ADD COLUMN status TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS delivery_events_message ON delivery_events(provider_id,created_at);
