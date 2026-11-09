CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text   NOT NULL,
  email         citext NOT NULL UNIQUE,
  password_hash text   NOT NULL,
  role          text   NOT NULL CHECK (role IN ('user', 'store_manager', 'super_admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per login. Logout sets revoked_at, which kills that session's tokens on the next request.
CREATE TABLE sessions (
  id                 uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text   NOT NULL UNIQUE,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
