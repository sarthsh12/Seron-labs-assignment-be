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

_More sections (trade-offs, API docs, seeding data) will be added as the project grows._
