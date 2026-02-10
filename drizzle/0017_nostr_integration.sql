-- Nostr integration fields for user table
ALTER TABLE "user" ADD COLUMN "nostr_pubkey" TEXT;
ALTER TABLE "user" ADD COLUMN "nostr_priv_encrypted" TEXT;
ALTER TABLE "user" ADD COLUMN "nostr_priv_iv" TEXT;
ALTER TABLE "user" ADD COLUMN "nostr_key_version" INTEGER DEFAULT 1;
ALTER TABLE "user" ADD COLUMN "nostr_sync_enabled" INTEGER DEFAULT 0;

-- Nostr event ID mapping for thread linking
ALTER TABLE "topic" ADD COLUMN "nostr_event_id" TEXT;
ALTER TABLE "comment" ADD COLUMN "nostr_event_id" TEXT;
