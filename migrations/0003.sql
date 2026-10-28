ALTER TABLE intakes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intakes ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS intakes_pending ON intakes(status,claimed_at);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,due_at);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
