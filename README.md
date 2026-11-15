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

## Load sample data

With the stack running, fill the database at the scale in the brief (about 4 minutes):

```bash
docker compose exec api node dist/seed.js          # add --reset to replace existing data
```

| Table | Rows |
|---|---|
| users | 5,000 |
| projects | 2,000 (20 with 3,000 tasks, the rest about 222) |
| invitations | 50,000 |
| tasks | 500,000 |
| task dependencies | ~1,000,000 |
| materials | 20,000 |
| deliveries | 400,000 |
| delivery lines | ~3,000,000 |

Every password is `password123`. Useful logins:

- `admin@sitetrack.test`: SuperAdmin
- `manager@sitetrack.test`: company store manager
- `user@sitetrack.test`: admin of PRJ-0001 (3,000 tasks), member of several other projects, with
  pending invitations

The data follows the same rules as the API:

- dependencies only point to earlier tasks, so there are no cycles
- started tasks have all prerequisites done
- Blocked counters match
- project stock is derived from delivery history and is never negative
- in-transit totals match the open deliveries

Rows are generated inside Postgres with `generate_series`, so nothing large is sent over the connection.

## API documentation

[docs/API.md](docs/API.md) lists every endpoint with request and response examples, maps each of the
11 screens in the brief to its endpoints, and explains tokens, IDs, pagination and errors.

## Tests

```bash
npm install
docker compose up -d db   # the tests need Postgres
npm test
```

40 tests send real HTTP requests to the app (in memory, through Fastify's `inject`) against a real
Postgres. They use a separate `sitetrack_test` database, created automatically, so seeded data is
never touched. They cover the rules most likely to break:

- data security: non-members get the same 404 as for a missing project; lists show only what you
  may see
- IDs: unique and gap-free under concurrent creates, never reused
- cycles: rejected directly and through other tasks
- Blocked and Late; allowed status changes; dependency chains with step counts on a diamond graph
- the last project admin; two admins demoting each other at the same moment
- sessions: rotation, logout and removal take effect on the next request
- stock: never negative with 10 concurrent sends; every movement is all or nothing

Concurrency is tested by firing requests at the same moment with `Promise.all`. Breaking the cycle
check or removing the stock row lock makes the matching tests fail.

## Project layout

```
migrations/      numbered .sql files, applied in order on startup
src/
  server.ts      starts the API (runs migrations first)
  app.ts         routes, error handling, authentication hook
  routes/        HTTP layer: validates input with zod, calls a service
  auth/          tokens, sessions, project access checks, roles
  projects/ members/ notifications/ tasks/ materials/ stores/ deliveries/
                 one service per area: the SQL and business rules
  lib/           errors, pagination, password hashing, small helpers
  seed.ts        loads data at the brief's scale
test/            API tests
docs/API.md      API reference
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

### Projects and access control

- **One access check for every project route** (`requireProjectAccess`). A non-member, or a project
  that doesn't exist or was removed, gets the same `404 Project not found`, so guessing IDs reveals
  nothing. Members who are not admins get `403` on admin-only actions, since they already know the
  project exists.
- **Public IDs are the codes** (`PRJ-0042`); internal numeric ids never leave the API.
- **The projects list is one SQL query in three stages**: rank the projects the user can see using
  cheap numbers, take one page, then compute full task stats (counts by status, late, blocked) and
  member counts for just that page. The visibility filter comes from the same membership join, so
  counts can never include projects the user can't see.
- **Late is computed from today's date at read time**, never stored, so it is always current.
- **Blocked uses a stored counter** (`open_prereq_count`, the number of direct prerequisites not
  yet done) kept up to date when tasks change status and when dependencies change. That turns
  "is this task blocked?" into a column check instead of a graph walk over 1M dependencies.
- **Removing a project is a soft delete**, refused while deliveries are still in transit, and it
  withdraws pending invitations. The project's code is never reused.
- **SuperAdmins can see and work in every project** but are project admins only where they've
  been made one, matching "only project admins change members".

### Members, invitations and notifications

- **Invite by email.** Admins type the email of a registered user. An unknown email returns 404;
  this does reveal whether an email is registered, but only to project admins, and the frontend
  needs it to show a useful error. A public user directory was avoided on purpose.
- **Notifications are the invitee's invitations**, newest first, with an unread count. Withdrawn
  invitations are hidden, as if never sent. Answering or withdrawing marks it read.
- **Only the invitee can answer.** Anyone else gets 404 for that invitation id.
- **"At least one project admin" holds under concurrency.** Every membership change first locks
  the project row (`SELECT ... FOR UPDATE`), so changes to one project run one at a time. Two
  admins demoting each other at the same moment can't both succeed; the second sees it is no
  longer an admin.
- **Consistent lock order** (project row, then invitation row) in every path avoids deadlocks
  between, for example, accepting an invitation and removing the project.
- **Removal takes effect on the next request**, because project access is read from
  `project_members` on every request rather than stored in the token.

### Tasks

- **Task numbers come from a counter on the project row** (`UPDATE ... RETURNING`). The row lock
  queues concurrent creates in one project, a failed insert rolls the counter back, and deletes
  never lower it, so numbers are unique, gap-free and never reused.
- **Status changes are explicit actions** (`start`, `complete`, `reopen`); every other transition
  returns 409 with the reason. Task details return `allowedActions` so the frontend shows only
  valid buttons.
- **Reopen checks only direct dependents.** An indirect dependent can only have started if a direct
  one is done, so this is equivalent to "no task that waits on it has started".
- **Per-project task-graph lock.** Status changes and deletions take a transaction-scoped advisory
  lock on the project, so updates to `open_prereq_count` never race or deadlock. Different projects
  never wait on each other.
- **Task list** computes Late and Blocked per row, dependent counts once per project, and the
  "depends on" list only for the rows on the current page.
- **Date range filter** returns tasks whose planned period overlaps the range.

### Task dependencies

- **Cycle check with a recursive query.** Adding "T depends on D" is rejected if D already waits on T,
  directly or indirectly. The query uses `UNION`, which skips tasks already visited, so it stays
  fast on large graphs (6 ms for a worst case across 3,000 tasks and ~9,000 dependencies).
- **Same-project only, enforced twice:** tasks are looked up inside the project in the URL, and the
  composite foreign keys in the schema reject a cross-project row anyway.
- **One extra rule keeps Blocked cheap:** a task that has already started can only gain
  dependencies on tasks that are done. Together with "start only when prerequisites are done",
  this guarantees that if all direct prerequisites are done, all indirect ones are too, so
  `open_prereq_count` (direct, unfinished prerequisites) is enough to decide Blocked.
- **Task details show both chains with distances.** The project's dependency edges are loaded
  once and walked breadth-first in memory, so each task gets its shortest number of steps. A plain
  recursive SQL query would revisit a task once per path, which grows exponentially on
  diamond-shaped graphs. Measured: 55 ms for a task that waits on all 2,999 others.
- **Concurrency:** dependency changes take the same per-project task-graph lock as status changes,
  so two opposite dependencies added at the same moment can't both succeed.

### Materials, stores and deliveries

- **Who does what.** Everyone logged in reads the materials catalogue; company store managers and
  SuperAdmins manage it, add supplier stock, set reorder points and send to projects. Project
  members send back to the company store and record or reject incoming deliveries. The sending side
  cancels; the receiving side records or rejects. Anyone who can see neither side gets 404.
- **Every stock movement is one transaction.** Adding stock, sending, recording, rejecting and
  cancelling either fully happen or not at all; a send with one short line changes nothing.
- **Stock never goes negative, even with concurrent sends.** The sender's stock rows are locked
  (`SELECT ... FOR UPDATE`) before checking quantities, so concurrent sends queue and each sees
  the latest quantity; `CHECK (quantity >= 0)` backs this up in the database. Tested with 10
  simultaneous sends against stock for 6: exactly 6 succeeded.
- **No deadlocks between stock movements.** All stock rows a transaction needs are locked in one
  query ordered by `(store_id, material_id)`, so every transaction takes its locks in the same
  order. As a safety net, `withTransaction` retries a transaction Postgres cancels for a deadlock
  or serialization failure (up to 3 attempts).
- **In-transit quantities are stored**, not summed from 3M delivery lines: `in_transit_out` on the
  sender's stock row changes in the same transaction as the delivery, so the company stock screen
  reads it directly.
- **"Last delivery in or out"** (`last_movement_at`) is set when a store sends or receives.
- **Lists page first, then load lines.** Delivery lists pick the page of deliveries using indexes on
  `sent_at`, then fetch material lines only for those rows.
- **Removing a material is a soft delete**, refused while any store holds it or has it in transit.
- **Quantities are `numeric(14,3)`** (exact, allows 2.5 m³) and are compared in SQL, never as
  JavaScript floats.

## Performance

Measured against the full seed data (median of 5 requests, through the API):

| Screen | Before | After |
|---|---|---|
| Projects list, SuperAdmin (all 2,000 projects) | 201 ms | 10 ms |
| ... sorted by late tasks | 190 ms | 25 ms |
| ... sorted by percent done | 196 ms | 9 ms |
| Company deliveries (400k) | 251 ms | 18 ms |
| Every other screen | 4–90 ms | 4–40 ms |

What changed:

- **Page first, details after.** The projects list used to compute task stats for every visible
  project (reading all 500k tasks) before picking 20. Now only the page's 20 projects get full stats.
- **Stored totals for percent done.** `project_task_stats` holds each project's task and done counts,
  updated in the same transaction as every task create, complete, reopen and delete. It's a separate
  table so these updates don't contend with locks on the project row. Tested with 30 concurrent
  creates and completes: stored totals match a recount.
- **Late counts from partial indexes.** Two indexes contain only tasks that can be late (not
  started, and in progress), so counting late tasks reads only those, never the 320k done tasks.
- **Separate count query for deliveries.** `count(*) OVER ()` next to `LIMIT 20` forced Postgres to
  read and sort all 400k matching rows. The page now walks the `sent_at` index and stops after 20,
  and the total is a separate count; both run at the same time.
- Lists over small sets (a project's tasks, materials, stock) keep `count(*) OVER ()`: they are
  already fast, and one query is simpler.

## Trade-offs

- **Three stored counters.** `open_prereq_count` (Blocked), `in_transit_out` (stock in transit) and
  `project_task_stats` (percent done) make the big screens fast. The cost is that every write that
  affects them must update them in the same transaction. That is handled in one place per counter
  and covered by tests and by the seed checks, but it is code that a "compute on read" design would
  not need.
- **One extra task rule.** A task that has started can only gain dependencies on tasks that are done.
  The brief doesn't ask for it, but without it Blocked could not be answered from direct
  prerequisites alone. It only refuses cases that would make a running task blocked, which is
  unlikely to be wanted.
- **Task details load the project's whole dependency graph.** Up to 3,000 tasks and a few thousand
  edges this takes a few milliseconds and gives exact shortest distances. Much larger projects would
  need a depth limit or a precomputed closure.
- **Page numbers, not cursors.** `page`/`pageSize` is simple for the frontend and supports "jump to
  page 7", but deep pages get slower (page 500 of company deliveries takes about 37 ms) and rows can
  shift between pages while data changes. Cursor pagination would fix both.
- **List totals are counted separately** from the page (deliveries) so the page query can stop after
  20 rows. Under heavy writes the total can be off by a few for a moment.
- **Every request reads the session and membership from the database.** That makes logout, role
  changes and removal take effect immediately, as the brief requires, at the cost of one indexed
  lookup per request.
- **Anyone can register as a SuperAdmin**, because the brief says the role is chosen at
  registration. In production, elevated roles would be granted by an existing admin.
- **Inviting by email confirms to project admins whether an email is registered.** The alternative,
  a user directory, would reveal far more.
- **Supplier stock has no history.** Adding stock updates the quantity; there is no ledger of every
  stock movement beyond deliveries.
- **Tests need Postgres.** Most rules live in SQL (locks, constraints, recursive queries), so testing
  against the real database finds real bugs; the cost is slower tests and a running database.

## With more time

- **Security hardening:** rate-limit login and register; detect refresh-token reuse (a stolen,
  already-rotated token would end all of that user's sessions); add an absolute session lifetime
  and "log out of all devices"; grant elevated roles through an admin instead of at registration.
- **Database timeouts:** `statement_timeout` and `lock_timeout`, so one stuck request can't hold
  locks or connections; return `503` and let the client retry.
- **A stock ledger:** one row per movement (supplier delivery, send, record, reject, cancel), so
  every quantity can be audited and rebuilt.
- **Cursor pagination** for the large lists, and an OpenAPI spec generated from the zod schemas,
  with Swagger UI and typed clients for the frontend.
- **Load testing** with many concurrent users (for example k6), then tune the connection pool and
  add PgBouncer if needed.
- **CI** running type checks and tests on every push, plus metrics and slow-query logging.

