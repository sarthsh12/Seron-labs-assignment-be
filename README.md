# SiteTrack API

Backend API for SiteTrack, a construction project and materials tracker.
Built with TypeScript (Node.js 22, Fastify) and PostgreSQL.

## Run it

```bash
docker compose up
```

The API listens on http://localhost:3000. Postgres is exposed on port 5433.
Database migrations run automatically when the API starts.

Check it's working:

```bash
curl localhost:3000/health   # {"status":"ok"}
```

## Decisions

- **TypeScript + Fastify**: fast, well-typed, and widely used.
- **Raw SQL with `pg` (no ORM)**: the hard parts of this app (row locking for stock,
  recursive dependency queries, large-scale reporting) are easiest to get right and
  tune in plain SQL.
- **Plain `.sql` migrations, run on startup**: no extra tool to install, and
  `docker compose up` works with no setup steps. An advisory lock prevents two
  API instances from migrating at once.

### Authentication

- **Short access token + rotating refresh token.** Login returns a JWT access token (15 min) and a
  random refresh token (30 days). Each refresh swaps the refresh token for a new one and pushes the
  expiry forward, so active users are never asked to log in again.
- **Every request checks the session in the database.** The JWT carries only the user id and session
  id. The user's role and the session's status are read fresh on each request, so logout and role
  changes take effect on the very next request. Cost: one indexed lookup per request.
- **Passwords are hashed with scrypt** (built into Node, no native dependencies). Refresh tokens are
  stored only as SHA-256 hashes.
- **Failed logins look identical.** Same message and the same work (a dummy hash check) whether or
  not the email exists.
- **Trade-off:** the brief lets people choose any role at registration, including SuperAdmin. That is
  implemented as specified; in production, elevated roles would be granted by an existing admin.

_More sections (trade-offs, API docs, seeding data) will be added as the project grows._
