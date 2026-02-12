-- DVM Lightning payment support: bolt11 invoice and payment_hash fields
ALTER TABLE dvm_job ADD COLUMN bolt11 TEXT;
ALTER TABLE dvm_job ADD COLUMN payment_hash TEXT;
