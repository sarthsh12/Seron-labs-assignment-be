-- citext: case-insensitive text, used for emails so "A@x.com" and "a@x.com" are the same account.
-- pg_trgm: trigram indexes, used to make "search by name" fast on large tables.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
