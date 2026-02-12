-- 账本事件 Nostr 关联
ALTER TABLE ledger_entry ADD COLUMN nostr_event_id TEXT;
