# SiteTrack API reference

Base URL: `http://localhost:3000`. Requests and responses are JSON.

- [Basics](#basics): authentication, IDs, pagination, errors
- [Screens to endpoints](#screens-to-endpoints)
- Endpoints: [Accounts](#accounts) · [Notifications](#notifications) · [Projects](#projects) ·
  [Members](#members-and-invitations) · [Tasks](#tasks) · [Dependencies](#task-dependencies) ·
  [Materials](#materials) · [Company store](#company-store) · [Project store](#project-store) ·
  [Deliveries](#deliveries)

Examples below are real responses from the seeded database, with long lists shortened.

---

## Basics

### Authentication

1. `POST /auth/login` (or `/auth/register`) returns an `accessToken` (valid 15 minutes) and a
   `refreshToken` (valid 30 days).
2. Send the access token on every other request: `Authorization: Bearer <accessToken>`.
3. When a request returns `401`, call `POST /auth/refresh` with the refresh token. You get a **new
   pair**; the old refresh token stops working, so always store the new one. Each refresh also
   restarts the 30 days, so active users never have to log in again.
4. `POST /auth/logout` ends that session at once; its tokens stop working on the next request.

Roles and project membership are checked on every request, so a role change or removal from a
project applies immediately, without logging in again.

### App roles

| Role | Value | Reaches |
|---|---|---|
| User | `user` | Projects they are a member of |
| Company store manager | `store_manager` | The above, plus the company store and its deliveries |
| SuperAdmin | `super_admin` | Every project and the company store |

Within a project, members are either project admins (`isAdmin: true`) or not. Only project admins
manage members and invitations. A SuperAdmin can work in every project but is a project admin only
where made one.

### IDs

| Thing | ID format | Example |
|---|---|---|
| Project | `PRJ-` + number | `PRJ-0042` |
| Task | project ID + `-T-` + number | `PRJ-0042-T-0137` |
| User, material, delivery, invitation | number | `57` |

IDs never change and are never reused. Use the codes as given; the API never exposes internal ids
for projects and tasks.

### Dates

- Planned dates (`plannedStart`, `plannedEnd`, date filters `from`/`to`) are `YYYY-MM-DD`.
- Timestamps (`createdAt`, `sentAt`, ...) are ISO 8601 in UTC: `2026-11-13T02:53:01.857Z`.
- Date range filters are inclusive on both ends.

### Lists and pagination

Every list takes `page` (default 1) and `pageSize` (default 20, max 100) and returns:

```json
{ "items": [ ... ], "page": 1, "pageSize": 20, "total": 3000 }
```

`total` counts every match across all pages. Lists that sort take `sort` and `order` (`asc` or
`desc`). Filters that accept several values take a comma list: `?status=not_started,in_progress`.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "Project not found" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body or query is invalid; `details` lists each field problem |
| 400 | `BAD_REQUEST` | Valid shape but not allowed, e.g. a task depending on itself |
| 401 | `UNAUTHORIZED` | Missing, expired or revoked token, or a failed login |
| 403 | `FORBIDDEN` | Logged in, but your role doesn't allow it (e.g. a non-admin inviting) |
| 404 | `NOT_FOUND` | Doesn't exist **or** you can't see it (see below) |
| 409 | `CONFLICT` | Breaks a rule at this moment: a cycle, not enough stock, wrong status, ... |

**Projects you can't access answer `404 Project not found`**, exactly as if they didn't exist. The
same applies to their tasks, store, deliveries and members, and to invitations and deliveries you
can't see. Members who aren't project admins get `403` for admin-only actions, since they already
know the project exists.

Validation error example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [{ "path": ["name"], "code": "too_small", "message": "Too small: expected string to have >=1 characters" }]
  }
}
```

---

## Screens to endpoints

| # | Screen | Endpoints |
|---|---|---|
| 1 | Log in | `POST /auth/login` |
| 2 | Register | `POST /auth/register` |
| 3 | Notifications | `GET /notifications`, `GET /notifications/unread-count` (badge on every page), `POST /invitations/:id/accept` · `reject` |
| 4 | Projects | `GET /projects`, `POST /projects`, `PATCH` · `DELETE /projects/:projectId` |
| 5 | Project: Tasks | `GET /projects/:projectId/tasks`, `POST /projects/:projectId/tasks` |
| 6 | Task details | `GET /projects/:projectId/tasks/:taskId`, `POST .../:taskId/start` · `complete` · `reopen`, dependencies |
| 7 | Project: Store | `GET /projects/:projectId/store` |
| 8 | Project: Deliveries | `GET /projects/:projectId/deliveries`, `POST /projects/:projectId/deliveries`, `POST /deliveries/:id/record` · `reject` · `cancel` |
| 9 | Project: Members | `GET /projects/:projectId/members`, invitations and member endpoints |
| 10 | Company store: Stock | `GET /company-store/stock`, `POST /company-store/stock`, `PUT /company-store/stock/:materialId/reorder-point` |
| 11 | Company store: Deliveries | `GET /company-store/deliveries`, `POST /company-store/deliveries`, `POST /deliveries/:id/record` · `reject` · `cancel` |

---

## Accounts

### `POST /auth/register` (no token)

```json
{ "name": "Sarth Sharma", "email": "sarth@example.com", "password": "secret123", "role": "user" }
```

`password` is at least 8 characters. `role` is `user`, `store_manager` or `super_admin`. Emails are
case-insensitive. Returns `201` with the same body as login. `409` if the email is taken.

### `POST /auth/login` (no token)

```json
{ "email": "user@sitetrack.test", "password": "password123" }
```

`200`:

```json
{
  "user": { "id": 3, "name": "Rahul Al Balushi", "email": "user@sitetrack.test", "role": "user", "createdAt": "2026-11-10T15:12:01.792Z" },
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "_R49xYzLiSff...",
  "expiresIn": 900
}
```

`expiresIn` is the access token's lifetime in seconds. A wrong password and an unknown email both
return the same `401 Invalid email or password`.

### `POST /auth/refresh` (no token)

`{ "refreshToken": "..." }` → `200` with `{ accessToken, refreshToken, expiresIn }`. `401` if the
refresh token is unknown, already used, expired or logged out.

### `POST /auth/logout`

Ends the current session. `204`.

### `GET /me`

Your profile: `{ id, name, email, role, createdAt }`.

---

## Notifications

Notifications are your project invitations. Withdrawn invitations are not shown.

### `GET /notifications`

Newest first. Paginated, plus the unread count:

```json
{
  "items": [
    {
      "id": 36606,
      "type": "project_invitation",
      "status": "pending",
      "read": true,
      "project": { "id": "PRJ-0606", "name": "Salalah Metro Station Phase 2" },
      "invitedBy": { "id": 3710, "name": "Pooja Al Busaidi" },
      "createdAt": "2026-09-24T07:31:37.573Z",
      "respondedAt": null
    }
  ],
  "page": 1, "pageSize": 20, "total": 8,
  "unreadCount": 0
}
```

`status` is `pending`, `accepted` or `rejected`. Show Accept and Reject while it is `pending`.

### `GET /notifications/unread-count`

`{ "unreadCount": 2 }`. Cheap; meant for a badge on every page.

### `POST /notifications/read` · `POST /notifications/:id/read`

Marks all, or one, as read. Returns `{ "unreadCount": 0 }`.

### `POST /invitations/:id/accept` · `POST /invitations/:id/reject`

`204`. Accepting adds you to the project. Only the invited person can answer (anyone else gets
`404`); answering twice, or a withdrawn invitation, gives `409`.

---

## Projects

### `GET /projects`

Every project you can access.

| Query | Values |
|---|---|
| `q` | Search: part of the name, or the start of the ID (`PRJ-004`) |
| `hasLateTasks` | `true` to show only projects with late tasks |
| `sort` | `name` (default), `startDate`, `percentDone`, `lateTasks` |
| `order`, `page`, `pageSize` | See [Lists](#lists-and-pagination) |

```json
{
  "items": [
    {
      "id": "PRJ-0822",
      "name": "Amerat Office Tower Phase 3",
      "plannedStart": "2025-11-30",
      "plannedEnd": "2028-05-01",
      "isAdmin": true,
      "memberCount": 15,
      "taskCounts": { "total": 222, "notStarted": 135, "inProgress": 6, "done": 81 },
      "percentDone": 36.5,
      "lateTasks": 6,
      "blockedTasks": 129,
      "createdAt": "2025-10-31T00:00:00.000Z"
    }
  ],
  "page": 1, "pageSize": 20, "total": 7
}
```

`isAdmin` is whether **you** are its project admin. `percentDone` is done ÷ total × 100, one decimal.

### `POST /projects`

```json
{ "name": "Muscat Office Tower", "plannedStart": "2026-01-01", "plannedEnd": "2027-12-31" }
```

`201` with the project (shape as in the list). You become its project admin, and it gets its own
store. `plannedEnd` must be on or after `plannedStart`.

### `GET /projects/:projectId`

One project, same shape as a list item.

### `PATCH /projects/:projectId` (project admins)

Any of `name`, `plannedStart`, `plannedEnd`. Returns the updated project.

### `DELETE /projects/:projectId` (project admins)

`204`. The project disappears for everyone; its ID is never reused and its delivery history is
kept. Pending invitations are withdrawn. `409` while it has deliveries in transit.

---

## Members and invitations

### `GET /projects/:projectId/members`

Members (admins first) and invitations not yet answered:

```json
{
  "members": [
    { "id": 3, "name": "Rahul Al Balushi", "email": "user@sitetrack.test", "isAdmin": true, "joinedAt": "2026-02-26T00:00:00.000Z" }
  ],
  "pendingInvitations": [
    {
      "id": 38001,
      "user": { "id": 1625, "name": "Salim Al Balushi", "email": "user1625@sitetrack.test" },
      "invitedBy": { "id": 3, "name": "Rahul Al Balushi", "email": "user@sitetrack.test" },
      "createdAt": "2026-11-13T06:13:36.116Z"
    }
  ]
}
```

The endpoints below are for **project admins only** (`403` for other members).

| Endpoint | Body | Result |
|---|---|---|
| `POST /projects/:projectId/invitations` | `{ "email": "priya@example.com" }` | `201` with the pending invitation. `404` if no user has that email, `409` if already a member or already invited |
| `DELETE /projects/:projectId/invitations/:invitationId` | | `204`. Only while not yet answered (`409` otherwise) |
| `PATCH /projects/:projectId/members/:userId` | `{ "isAdmin": true }` | `204`. Make or unmake a project admin |
| `DELETE /projects/:projectId/members/:userId` | | `204`. Removed members lose access on their next request |

A project always keeps at least one project admin: demoting or removing the last one returns `409`.

---

## Tasks

### `GET /projects/:projectId/tasks`

| Query | Values |
|---|---|
| `status` | Comma list of `not_started`, `in_progress`, `done` |
| `late` | `true` or `false` |
| `blocked` | `true` or `false` |
| `from`, `to` | Planned date range; returns tasks whose planned period overlaps it |
| `q` | Search: part of the name or ID |
| `sort` | `id` (default), `name`, `startDate`, `endDate`, `dependents` |
| `order`, `page`, `pageSize` | See [Lists](#lists-and-pagination) |

```json
{
  "items": [
    {
      "id": "PRJ-0001-T-1600",
      "name": "Frame foundations - Level 20",
      "plannedStart": "2026-11-18",
      "plannedEnd": "2026-12-04",
      "status": "not_started",
      "isLate": false,
      "isBlocked": true,
      "dependsOn": ["PRJ-0001-T-1576"],
      "dependentsCount": 0,
      "createdAt": "2026-02-26T00:00:00.000Z",
      "updatedAt": "2026-11-13T15:12:01.792Z"
    }
  ],
  "page": 1, "pageSize": 20, "total": 3000
}
```

- `dependsOn`: tasks this one directly depends on.
- `dependentsCount`: how many tasks directly depend on this one.
- `isLate`: not done and its planned end has passed, or not started and its planned start has passed.
- `isBlocked`: not done and at least one task it waits on (directly or indirectly) is not done.

Late and Blocked are worked out on every request and can't be set.

### `POST /projects/:projectId/tasks`

```json
{ "name": "Pour level 2 slab", "plannedStart": "2026-03-01", "plannedEnd": "2026-03-10" }
```

`201` with the task details (below). New tasks are `not_started`.

### `GET /projects/:projectId/tasks/:taskId`

The task, plus the actions allowed right now and both dependency chains with distances:

```json
{
  "id": "PRJ-0001-T-2161",
  "name": "Paint ground slab - Level 16",
  "plannedStart": "2027-02-09",
  "plannedEnd": "2027-02-11",
  "status": "not_started",
  "isLate": false,
  "isBlocked": true,
  "dependsOn": ["PRJ-0001-T-2133", "PRJ-0001-T-2149"],
  "dependentsCount": 9,
  "createdAt": "2026-02-26T00:00:00.000Z",
  "updatedAt": "2026-11-13T15:12:01.792Z",
  "allowedActions": [],
  "waitsOn": [
    { "id": "PRJ-0001-T-2133", "name": "Inspect stairs - Level 14", "status": "not_started", "steps": 1 },
    { "id": "PRJ-0001-T-2149", "name": "Paint stairs - Level 15", "status": "not_started", "steps": 1 }
  ],
  "waitedOnBy": [
    { "id": "PRJ-0001-T-2162", "name": "Install columns - Level 16", "status": "not_started", "steps": 1 }
  ]
}
```

- `waitsOn`: every task this one waits on, directly or indirectly.
- `waitedOnBy`: every task that waits on this one.
- `steps`: shortest distance, where 1 means a direct dependency.
- `allowedActions`: show only these buttons.

### `PATCH /projects/:projectId/tasks/:taskId`

Any of `name`, `plannedStart`, `plannedEnd`. Status is changed only through actions. Returns the
task details.

### `DELETE /projects/:projectId/tasks/:taskId`

`204`. Its dependencies are removed with it; its ID is never reused.

### `POST /projects/:projectId/tasks/:taskId/start` · `complete` · `reopen`

Returns the updated task details. Any other change returns `409` with the reason.

| Action | From → to | Allowed when |
|---|---|---|
| `start` | not_started → in_progress | Every task it waits on is done |
| `complete` | in_progress → done | Always |
| `reopen` | done → in_progress | No task that waits on it has started |

---

## Task dependencies

"Task depends on X" means the task can't start until X is done.

### `POST /projects/:projectId/tasks/:taskId/dependencies`

```json
{ "dependsOn": "PRJ-0001-T-0003" }
```

`201` with the task details. Rejected when:

- `400`: the task would depend on itself, or `dependsOn` isn't a task in this project (another
  project's task, or no such task).
- `404`: the task in the URL doesn't exist.
- `409`: it would create a loop (A → B → A, directly or through other tasks), it already exists,
  or the task has started and the other task isn't done (a started task can't become blocked).

### `DELETE /projects/:projectId/tasks/:taskId/dependencies/:dependsOnId`

Removes it and returns the task details.

---

## Materials

The shared catalogue. Everyone logged in can read it; company store managers and SuperAdmins change it.

### `GET /materials`

| Query | Values |
|---|---|
| `q` | Part of the name |
| `category` | Exact category |
| `sort` | `name` (default), `category` |

Items: `{ "id": 373, "name": "AAC Block Fire Rated #00373", "category": "Masonry", "unit": "piece", "createdAt": "..." }`

### `GET /materials/categories`

`{ "categories": ["Aggregates", "Binders", "Electrical", ...] }`, for filter dropdowns.

### `GET /materials/:id`

One material.

### `POST /materials` · `PATCH /materials/:id` · `DELETE /materials/:id`

```json
{ "name": "Cement, OPC 50 kg bag", "category": "Binders", "unit": "bag" }
```

`PATCH` takes any of the three fields. Names are unique ignoring case (`409`). `DELETE` is refused
(`409`) while any store holds the material or has it in transit; past deliveries keep showing it.

---

## Company store

Company store managers and SuperAdmins only (`403` for others).

### `GET /company-store/stock`

Every catalogue material, including ones the company store has never held (quantity 0).

| Query | Values |
|---|---|
| `status` | Comma list of `out_of_stock`, `low_stock`, `available` |
| `category`, `q` | Exact category; part of the name |
| `sort` | `name` (default), `quantity`, `status` |

```json
{
  "items": [
    {
      "materialId": 2773,
      "name": "AAC Block Fire Rated #02773",
      "category": "Masonry",
      "unit": "piece",
      "quantity": 95,
      "inTransitToProjects": 1792,
      "reorderPoint": 321,
      "status": "low_stock"
    }
  ],
  "page": 1, "pageSize": 20, "total": 1484
}
```

`status`: `out_of_stock` when quantity is 0, `low_stock` when above 0 and at or below the reorder
point, otherwise `available`.

### `POST /company-store/stock`

Adds stock arriving from a supplier, the only way material enters SiteTrack:

```json
{ "lines": [{ "materialId": 1, "quantity": 100 }, { "materialId": 2, "quantity": 2.5 }] }
```

`201` with the new quantities: `{ "items": [{ "materialId": 1, "quantity": 170 }, ...] }`.
All lines are applied together or not at all. Quantities are positive and may have up to 3 decimals.

### `PUT /company-store/stock/:materialId/reorder-point`

`{ "reorderPoint": 120 }` → `{ "materialId": 1, "reorderPoint": 120 }`.

### `GET /company-store/deliveries`

Deliveries across all projects, newest first. Filters: `project` (`PRJ-0042`), `direction`
(`to_project` or `to_company`), `status` (comma list), `from`/`to` (date sent). Items as in
[Deliveries](#deliveries).

### `POST /company-store/deliveries`

Sends material to a project:

```json
{ "projectId": "PRJ-0042", "lines": [{ "materialId": 1, "quantity": 30 }, { "materialId": 2, "quantity": 10 }] }
```

`201` with the delivery, `in_transit`. `400 Unknown project` if the project doesn't exist or was
removed. The quantities leave the company stock at once. If any line
is short, nothing is sent and you get `409` naming every short line:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Not enough stock",
    "details": { "shortages": [{ "materialId": 2, "available": 4, "requested": 10 }] }
  }
}
```

---

## Project store

### `GET /projects/:projectId/store`

Materials in the project store. Filters: `q` (part of the name) and `category`. `sort`: `name`
(default), `quantity`, `lastDelivery`.

```json
{
  "items": [
    {
      "materialId": 8973,
      "name": "AAC Block Heavy Duty #08973",
      "category": "Masonry",
      "unit": "piece",
      "quantity": 2330,
      "lastDeliveryAt": "2026-11-03T14:08:51.983Z"
    }
  ],
  "page": 1, "pageSize": 20, "total": 150
}
```

`lastDeliveryAt` is the last delivery in or out of this store for that material.

### `GET /projects/:projectId/deliveries`

The project's deliveries in both directions, newest first. Filters: `direction`, `status`,
`from`/`to`.

### `POST /projects/:projectId/deliveries`

Sends material back to the company store. Any project member can do this. Body and errors as for
`POST /company-store/deliveries`, without `projectId`.

---

## Deliveries

A delivery moves materials between the company store and one project store:

- `direction: "to_project"`: the company store sends to the project.
- `direction: "to_company"`: the project sends back.

```json
{
  "id": 268001,
  "direction": "to_project",
  "status": "in_transit",
  "sentAt": "2026-11-13T02:53:01.857Z",
  "resolvedAt": null,
  "project": { "id": "PRJ-0001", "name": "Muscat Office Tower Phase 1" },
  "sentBy": { "id": 1650, "name": "Neha Sharma" },
  "resolvedBy": null,
  "lines": [
    { "materialId": 8479, "name": "Bitumen Membrane Grade A #08479", "unit": "m2", "quantity": 210 },
    { "materialId": 8453, "name": "Concrete Block Grade A #08453", "unit": "piece", "quantity": 469 }
  ],
  "allowedActions": ["record", "reject"]
}
```

- `resolvedAt` and `resolvedBy`: when and by whom it was recorded, rejected or cancelled.
- `allowedActions`: the buttons to show to **you**.

### `GET /deliveries/:id`

One delivery. `404` unless you are on its company side (store manager or SuperAdmin) or a member
of its project.

### `POST /deliveries/:id/record` · `reject` · `cancel`

Returns the updated delivery. Only while `in_transit` (`409` otherwise).

| Action | Who | Result |
|---|---|---|
| `record` | The receiver | `delivered`; quantities join the receiver's stock |
| `reject` | The receiver | `rejected`; quantities return to the sender |
| `cancel` | The sender | `cancelled`; quantities return to the sender |

The receiver of a `to_project` delivery is the project's members; for `to_company` it is store
managers and SuperAdmins. The other side gets `403` for the receiver's actions, and vice versa.
