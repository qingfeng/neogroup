-- NIP-72: Nostr Moderated Communities for Groups
ALTER TABLE "group" ADD COLUMN "nostr_pubkey" TEXT;
ALTER TABLE "group" ADD COLUMN "nostr_priv_encrypted" TEXT;
ALTER TABLE "group" ADD COLUMN "nostr_priv_iv" TEXT;
ALTER TABLE "group" ADD COLUMN "nostr_sync_enabled" INTEGER DEFAULT 0;
ALTER TABLE "group" ADD COLUMN "nostr_community_event_id" TEXT;
ALTER TABLE "group" ADD COLUMN "nostr_last_poll_at" INTEGER;
ALTER TABLE "topic" ADD COLUMN "nostr_author_pubkey" TEXT;
