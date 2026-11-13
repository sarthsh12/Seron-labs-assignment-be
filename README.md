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

### Projects and access control

- **One access check for every project route** (`requireProjectAccess`). A non-member, or a project
  that doesn't exist or was removed, gets the same `404 Project not found`, so guessing IDs reveals
  nothing. Members who are not admins get `403` on admin-only actions, since they already know the
  project exists.
- **Public IDs are the codes** (`PRJ-0042`); internal numeric ids never leave the API.
- **The projects list is one SQL query**: visible projects, member counts and task stats (counts by
  status, percent done, late, blocked) are computed together, and the list filter comes from the
  same membership join, so counts can never include projects the user can't see.
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

_More sections (trade-offs, API docs, seeding data) will be added as the project grows._
