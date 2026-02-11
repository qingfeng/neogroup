-- Index to speed up API key lookups by provider_type + access_token hash
CREATE INDEX IF NOT EXISTS idx_auth_provider_type_token
  ON auth_provider(provider_type, access_token);
