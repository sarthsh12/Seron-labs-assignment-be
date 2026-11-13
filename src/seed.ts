import type pg from 'pg';
import { pool } from './db.js';
import { hashPassword } from './lib/password.js';
import { runMigrations } from './migrate.js';

// Loads data at the scale in the brief. All rows are generated inside Postgres with generate_series,
// so nothing large travels over the connection. Every rule the API enforces holds for this data too:
// no dependency cycles, Blocked counters match, stock never negative, in-transit totals match.
//
// Usage: node dist/seed.js [--reset]     (--reset is required if the database already has data)

const USERS = 5_000;
const PROJECTS = 2_000;
const BIG_PROJECTS = 20; // these get 3,000 tasks each; the rest share the remaining 440,000
const MATERIALS = 20_000;
const DELIVERIES = 400_000;
const PALETTE = 150; // materials each project works with
const PASSWORD = 'password123';

const FIRST = ['Aisha', 'Omar', 'Priya', 'Rahul', 'Sara', 'Yusuf', 'Fatima', 'Arjun', 'Layla', 'Hamad', 'Neha', 'Khalid',
  'Maya', 'Ravi', 'Noor', 'Sami', 'Anita', 'Faisal', 'Zara', 'Vikram', 'Huda', 'Imran', 'Leena', 'Tariq', 'Divya',
  'Salim', 'Mariam', 'Karan', 'Reem', 'Nasser', 'Pooja', 'Adel', 'Dana', 'Rohan', 'Hessa', 'Ali', 'Meera', 'Ziad',
  'Asha', 'Bilal'];
const LAST = ['Al Balushi', 'Sharma', 'Al Harthy', 'Patel', 'Al Rawahi', 'Nair', 'Al Hinai', 'Khan', 'Al Said', 'Iyer',
  'Al Lawati', 'Mehta', 'Al Busaidi', 'Reddy', 'Al Zadjali', 'Gupta', 'Al Maskari', 'Das', 'Al Amri', 'Joshi',
  'Al Kindi', 'Singh', 'Al Abri', 'Menon', 'Al Riyami', 'Rao', 'Al Shukaili', 'Pillai', 'Al Wahaibi', 'Kapoor',
  'Al Mahrouqi', 'Verma', 'Al Siyabi', 'Bose', 'Al Hashmi', 'Kumar', 'Al Jabri', 'Chopra', 'Al Farsi', 'Malik'];
const PLACES = ['Muscat', 'Seeb', 'Sohar', 'Nizwa', 'Sur', 'Salalah', 'Barka', 'Ibri', 'Rustaq', 'Bahla', 'Duqm',
  'Khasab', 'Ibra', 'Bidbid', 'Qurayyat', 'Samail', 'Adam', 'Saham', 'Shinas', 'Liwa', 'Bawshar', 'Amerat', 'Mutrah',
  'Qurum', 'Azaiba'];
const KINDS = ['Office Tower', 'Residential Block', 'Hospital Wing', 'School Campus', 'Shopping Mall', 'Warehouse',
  'Hotel', 'Villa Compound', 'Metro Station', 'Bridge', 'Data Centre', 'Sports Complex', 'Mosque', 'Clinic',
  'Parking Structure', 'Water Treatment Plant'];
const VERBS = ['Excavate', 'Pour', 'Install', 'Inspect', 'Frame', 'Wire', 'Plaster', 'Paint', 'Tile', 'Survey',
  'Waterproof', 'Commission'];
const ELEMENTS = ['foundations', 'ground slab', 'columns', 'beams', 'floor slab', 'stairs', 'external walls',
  'partition walls', 'roof structure', 'roof membrane', 'windows', 'doors', 'plumbing', 'electrical', 'HVAC',
  'fire safety'];
const CATEGORIES: { name: string; unit: string; items: string[] }[] = [
  { name: 'Binders', unit: 'bag', items: ['Portland Cement', 'White Cement', 'Lime', 'Gypsum Plaster', 'Tile Adhesive'] },
  { name: 'Metals', unit: 'tonne', items: ['Rebar', 'Steel I-Beam', 'Steel Angle', 'Mesh Sheet', 'Steel Plate'] },
  { name: 'Aggregates', unit: 'm3', items: ['Sand', 'Gravel', 'Crushed Stone', 'Ready-Mix Concrete', 'Fill Soil'] },
  { name: 'Masonry', unit: 'piece', items: ['Concrete Block', 'Clay Brick', 'AAC Block', 'Paving Stone', 'Kerb Stone'] },
  { name: 'Timber', unit: 'm3', items: ['Plywood Sheet', 'Pine Batten', 'Formwork Panel', 'MDF Board', 'Hardwood Beam'] },
  { name: 'Plumbing', unit: 'piece', items: ['PVC Pipe', 'PPR Pipe', 'Gate Valve', 'Floor Drain', 'Water Heater'] },
  { name: 'Electrical', unit: 'piece', items: ['Copper Cable', 'Conduit', 'Distribution Board', 'Socket Outlet', 'LED Panel'] },
  { name: 'Finishes', unit: 'litre', items: ['Emulsion Paint', 'Primer', 'Epoxy Coating', 'Wall Putty', 'Sealant'] },
  { name: 'Flooring', unit: 'm2', items: ['Ceramic Tile', 'Porcelain Tile', 'Marble Slab', 'Vinyl Plank', 'Granite Tile'] },
  { name: 'Insulation', unit: 'm2', items: ['Rock Wool', 'XPS Board', 'Bitumen Membrane', 'Foam Sheet', 'Vapour Barrier'] },
];
const SPECS = ['Standard', 'Grade A', 'Grade B', 'Heavy Duty', 'Premium', 'Type I', 'Type II', 'Fire Rated'];

async function step(client: pg.PoolClient, label: string, sql: string, params: unknown[] = []) {
  const started = Date.now();
  const result = await client.query(sql, params);
  const rows = result.rowCount ? ` (${result.rowCount.toLocaleString()} rows)` : '';
  console.log(`${label}${rows} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function seed(client: pg.PoolClient) {
  const passwordHash = await hashPassword(PASSWORD);

  // Fast bulk load: these settings only affect this connection.
  await client.query(`SET synchronous_commit = off; SET work_mem = '256MB'; SELECT setseed(0.42)`);

  await step(client, 'clear tables', `
    TRUNCATE users, sessions, projects, project_members, invitations, tasks, task_dependencies,
             materials, stores, store_stock, deliveries, delivery_lines RESTART IDENTITY CASCADE;
    INSERT INTO stores (kind) VALUES ('company')`);

  // Demo logins: admin@ (SuperAdmin), manager@ (store manager), user@ (admin of PRJ-0001, 3,000 tasks).
  // About 1% of the rest are store managers and 0.1% SuperAdmins.
  await step(client, 'users', `
    INSERT INTO users (id, name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
    SELECT i,
           ($2::text[])[1 + i % 40] || ' ' || ($3::text[])[1 + (i / 40) % 40],
           CASE i WHEN 1 THEN 'admin@sitetrack.test' WHEN 2 THEN 'manager@sitetrack.test'
                  WHEN 3 THEN 'user@sitetrack.test' ELSE 'user' || i || '@sitetrack.test' END,
           $4,
           CASE WHEN i = 1 OR i % 1000 = 999 THEN 'super_admin'
                WHEN i = 2 OR i % 100 = 50 THEN 'store_manager' ELSE 'user' END,
           now() - (i % 700) * interval '1 day'
      FROM generate_series(1, $1::int) i`, [USERS, FIRST, LAST, passwordHash]);

  await step(client, 'projects', `
    INSERT INTO projects (id, name, planned_start, planned_end, next_task_no, created_by, created_at)
    OVERRIDING SYSTEM VALUE
    SELECT p,
           ($3::text[])[1 + (p - 1) % 25] || ' ' || ($4::text[])[1 + ((p - 1) / 25) % 16]
             || ' Phase ' || (1 + (p - 1) / 400),
           x.start, x.start + x.days,
           CASE WHEN p <= $2 THEN 3000 WHEN p <= $2 + 440 THEN 223 ELSE 222 END,
           3 + ((p - 1) * 97) % 4998,
           x.start - interval '30 days'
      FROM generate_series(1, $1::int) p,
           LATERAL (SELECT DATE '2024-01-01' + (random() * 1100)::int + 0 * p AS start,
                           180 + (random() * 720)::int AS days) x`,
    [PROJECTS, BIG_PROJECTS, PLACES, KINDS]);

  await step(client, 'project stores', `
    INSERT INTO stores (id, kind, project_id) OVERRIDING SYSTEM VALUE
    SELECT id + 1, 'project', id FROM projects`);

  // People slots per project: k = 0 creates the project, k 1..14 joined through accepted invitations,
  // k 15..25 have other invitations. 331 shares no factor with 4998, so the 26 users are distinct.
  await step(client, 'people per project', `
    CREATE TEMP TABLE seed_people ON COMMIT DROP AS
    SELECT p.id AS project_id, k, 3 + ((p.id - 1) * 97 + k * 331) % 4998 AS user_id, p.created_at
      FROM projects p, generate_series(0, 25) k`);

  await step(client, 'members', `
    INSERT INTO project_members (project_id, user_id, is_admin, joined_at)
    SELECT project_id, user_id, k <= 1, created_at + k * interval '1 day'
      FROM seed_people WHERE k <= 14`);

  await step(client, 'invitations', `
    INSERT INTO invitations (project_id, invitee_id, invited_by, status, created_at, responded_at, read_at)
    SELECT s.project_id, s.user_id, c.user_id, v.status, v.sent, v.answered,
           CASE WHEN v.status = 'pending' AND s.k <= 17 THEN NULL ELSE v.sent + interval '2 hours' END
      FROM seed_people s
      JOIN seed_people c ON c.project_id = s.project_id AND c.k = 0
      CROSS JOIN LATERAL (
        SELECT CASE WHEN s.k <= 14 THEN 'accepted' WHEN s.k <= 20 THEN 'pending'
                    WHEN s.k <= 23 THEN 'rejected' ELSE 'withdrawn' END AS status,
               CASE WHEN s.k BETWEEN 15 AND 20 THEN now() - random() * interval '60 days'
                    ELSE s.created_at + s.k * interval '1 day' - interval '1 hour' END AS sent) v0
      CROSS JOIN LATERAL (
        SELECT v0.status, v0.sent,
               CASE WHEN v0.status IN ('accepted', 'rejected') THEN v0.sent + interval '1 hour' END AS answered) v
     WHERE s.k >= 1`);

  // How far along each project is, from today's date with some noise. Tasks numbered up to done_upto are done.
  await step(client, 'project progress', `
    CREATE TEMP TABLE seed_progress ON COMMIT DROP AS
    SELECT id AS project_id,
           floor(next_task_no * LEAST(1, GREATEST(0, (CURRENT_DATE - planned_start)::numeric
                 / (planned_end - planned_start)) * (0.6 + random() * 0.45 + 0 * id)))::int AS done_upto
      FROM projects`);

  // Tasks are spread evenly across their project's planned period.
  await step(client, 'tasks', `
    INSERT INTO tasks (project_id, task_no, code, name, planned_start, planned_end, status, created_at)
    SELECT p.id, n, p.code || '-T-' || lpad(n::text, 4, '0'),
           ($1::text[])[1 + (n * 7) % 12] || ' ' || ($2::text[])[1 + n % 16] || ' - Level ' || (1 + ((n - 1) / 16) % 40),
           d.start, LEAST(p.planned_end, d.start + (1 + random() * 30)::int),
           CASE WHEN n <= g.done_upto THEN 'done' ELSE 'not_started' END,
           p.created_at
      FROM projects p
      JOIN seed_progress g ON g.project_id = p.id
      CROSS JOIN LATERAL generate_series(1, p.next_task_no) n
      CROSS JOIN LATERAL (SELECT p.planned_start
               + ((n - 1)::numeric * (p.planned_end - p.planned_start) / p.next_task_no)::int AS start) d`,
    [VERBS, ELEMENTS]);

  // A task only depends on lower-numbered tasks, so cycles are impossible.
  // Two distinct prerequisites from the previous 30 tasks, plus task 1 for every 60th task:
  // about 2 per task, roughly 1M in total.
  await step(client, 'task dependencies', `
    INSERT INTO task_dependencies (project_id, task_id, depends_on_id)
    SELECT t.project_id, t.id, d.id
      FROM tasks t
      CROSS JOIN LATERAL (SELECT LEAST(t.task_no - 1, 30) AS w) w
      CROSS JOIN LATERAL (SELECT 1 + floor(random() * w.w)::int AS a,
                                 floor(random() * GREATEST(w.w - 1, 1))::int AS r) x
      CROSS JOIN LATERAL (VALUES (t.task_no - x.a),
                                 (CASE WHEN w.w >= 2 THEN t.task_no - (1 + (x.a + x.r) % w.w) END),
                                 (CASE WHEN t.task_no % 60 = 0 THEN 1 END)) o(no)
      JOIN tasks d ON d.project_id = t.project_id AND d.task_no = o.no
     WHERE t.task_no >= 2`);

  // Some tasks just past the done ones are in progress; only tasks whose prerequisites are all done qualify.
  await step(client, 'tasks in progress', `
    UPDATE tasks t SET status = 'in_progress'
      FROM seed_progress g
     WHERE g.project_id = t.project_id
       AND t.task_no > g.done_upto AND t.task_no <= g.done_upto + 40
       AND random() < 0.7
       AND NOT EXISTS (SELECT 1 FROM task_dependencies dep JOIN tasks pre ON pre.id = dep.depends_on_id
                        WHERE dep.task_id = t.id AND pre.status <> 'done')`);

  await step(client, 'blocked counters', `
    UPDATE tasks t SET open_prereq_count = c.n
      FROM (SELECT dep.task_id, count(*)::int AS n
              FROM task_dependencies dep JOIN tasks pre ON pre.id = dep.depends_on_id
             WHERE pre.status <> 'done' GROUP BY dep.task_id) c
     WHERE t.id = c.task_id`);

  const materials = Array.from({ length: MATERIALS }, (_, idx) => {
    const i = idx + 1;
    const category = CATEGORIES[i % CATEGORIES.length];
    const item = category.items[Math.floor(i / CATEGORIES.length) % category.items.length];
    const spec = SPECS[Math.floor(i / 50) % SPECS.length];
    return { name: `${item} ${spec} #${String(i).padStart(5, '0')}`, category: category.name, unit: category.unit };
  });
  await step(client, 'materials', `
    INSERT INTO materials (id, name, category, unit) OVERRIDING SYSTEM VALUE
    SELECT ord, name, category, unit
      FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS m(name, category, unit, ord)`,
    [materials.map((m) => m.name), materials.map((m) => m.category), materials.map((m) => m.unit)]);

  // 85% go to projects. Recent ones are still in transit; the rest are mostly delivered.
  // Store managers send to projects; project members send back and record what arrives.
  await step(client, 'deliveries', `
    INSERT INTO deliveries (id, project_id, direction, status, sent_by, sent_at, resolved_by, resolved_at)
    OVERRIDING SYSTEM VALUE
    SELECT x.i, x.project_id, x.direction, x.status,
           CASE WHEN x.direction = 'to_project' THEN x.manager ELSE x.member END,
           x.sent_at,
           CASE WHEN x.status = 'in_transit' THEN NULL
                WHEN (x.status = 'cancelled') = (x.direction = 'to_project') THEN x.manager
                ELSE x.member END,
           CASE WHEN x.status <> 'in_transit'
                THEN LEAST(now(), x.sent_at + interval '1 hour' + random() * interval '3 days') END
      FROM (
        SELECT i, p.id AS project_id,
               CASE WHEN r.d < 0.15 THEN 'to_company' ELSE 'to_project' END AS direction,
               CASE WHEN r.s < 0.02 THEN 'in_transit' WHEN r.s < 0.04 THEN 'rejected'
                    WHEN r.s < 0.05 THEN 'cancelled' ELSE 'delivered' END AS status,
               50 + 100 * floor(r.m * 50)::int AS manager,
               sp.user_id AS member,
               CASE WHEN r.s < 0.02 THEN now() - r.t * interval '5 days'
                    ELSE b.base + r.t * (now() - b.base) END AS sent_at
          FROM generate_series(1, $1::int) i
          JOIN projects p ON p.id = 1 + (i - 1) % $2
          CROSS JOIN LATERAL (SELECT random() + 0 * i AS d, random() AS s, random() AS m, random() AS t,
                                     floor(random() * 15)::int AS k) r
          JOIN seed_people sp ON sp.project_id = p.id AND sp.k = r.k
          CROSS JOIN LATERAL (SELECT LEAST(p.planned_start - 30, CURRENT_DATE - 7)::timestamptz AS base) b
      ) x`, [DELIVERIES, PROJECTS]);

  // 1 to 14 lines each (about 3M in total), from the project's own set of 150 materials.
  // Consecutive slots in that set are distinct materials, so a delivery never repeats one.
  await step(client, 'delivery lines', `
    INSERT INTO delivery_lines (delivery_id, material_id, quantity)
    SELECT d.id, 1 + (d.project_id * 7919 + ((x.s + j) % $1::int) * 13) % $2::int,
           CASE WHEN d.direction = 'to_project' THEN round((10 + random() * 490)::numeric)
                ELSE 1 + floor(random() * 5) END
      FROM deliveries d
      CROSS JOIN LATERAL (SELECT floor(random() * $1::int)::int + 0 * d.id AS s,
                                 1 + floor(random() * 14)::int AS k) x
      CROSS JOIN LATERAL generate_series(0, x.k - 1) j`, [PALETTE, MATERIALS]);

  // A project can only send back what it received. Rare returns of something never received are
  // marked cancelled, which keeps every project's stock at zero or above.
  // Found once into a small table, then joined; a per-delivery lookup into the totals was far too slow.
  await step(client, 'find impossible returns', `
    CREATE TEMP TABLE seed_bad_returns ON COMMIT DROP AS
    SELECT DISTINCT l.delivery_id
      FROM (SELECT d.project_id, l.material_id
              FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
             GROUP BY 1, 2
            HAVING COALESCE(sum(l.quantity) FILTER (WHERE d.direction = 'to_company'
                                                    AND d.status IN ('delivered', 'in_transit')), 0)
                 > COALESCE(sum(l.quantity) FILTER (WHERE d.direction = 'to_project' AND d.status = 'delivered'), 0)) bad
      JOIN deliveries d ON d.project_id = bad.project_id AND d.direction = 'to_company'
                       AND d.status IN ('delivered', 'in_transit')
      JOIN delivery_lines l ON l.delivery_id = d.id AND l.material_id = bad.material_id`);

  await step(client, 'cancel impossible returns', `
    UPDATE deliveries d
       SET status = 'cancelled', resolved_by = d.sent_by, resolved_at = LEAST(now(), d.sent_at + interval '1 hour')
      FROM seed_bad_returns b
     WHERE d.id = b.delivery_id`);

  // Project stock is exactly what the delivery history says it should be.
  await step(client, 'project stock', `
    INSERT INTO store_stock (store_id, material_id, quantity, in_transit_out, last_movement_at)
    SELECT d.project_id + 1, l.material_id,
           COALESCE(sum(l.quantity) FILTER (WHERE d.direction = 'to_project' AND d.status = 'delivered'), 0)
           - COALESCE(sum(l.quantity) FILTER (WHERE d.direction = 'to_company'
                                              AND d.status IN ('delivered', 'in_transit')), 0),
           COALESCE(sum(l.quantity) FILTER (WHERE d.direction = 'to_company' AND d.status = 'in_transit'), 0),
           max(CASE WHEN d.direction = 'to_project' AND d.status = 'delivered' THEN d.resolved_at
                    WHEN d.direction = 'to_company' THEN d.sent_at END)
      FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
     GROUP BY d.project_id, l.material_id
    HAVING bool_or((d.direction = 'to_project' AND d.status = 'delivered') OR d.direction = 'to_company')`);

  // Company quantities stand for supplier stock (not part of delivery history); in-transit totals are exact.
  await step(client, 'company stock', `
    INSERT INTO store_stock (store_id, material_id, quantity, in_transit_out, reorder_point, last_movement_at)
    SELECT 1, m.id,
           CASE WHEN random() < 0.05 THEN 0 ELSE round((random() * 5000)::numeric) END,
           COALESCE(f.in_transit, 0),
           round((random() * 800)::numeric),
           f.last_movement
      FROM materials m
      LEFT JOIN (
        SELECT l.material_id,
               sum(l.quantity) FILTER (WHERE d.direction = 'to_project' AND d.status = 'in_transit') AS in_transit,
               max(CASE WHEN d.direction = 'to_project' THEN d.sent_at
                        WHEN d.status = 'delivered' THEN d.resolved_at END) AS last_movement
          FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
         GROUP BY l.material_id) f ON f.material_id = m.id`);

  // Rows were inserted with explicit ids, so move the id counters past them.
  await step(client, 'id counters', `
    SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users)),
           setval(pg_get_serial_sequence('projects', 'id'), (SELECT max(id) FROM projects)),
           setval(pg_get_serial_sequence('stores', 'id'), (SELECT max(id) FROM stores)),
           setval(pg_get_serial_sequence('materials', 'id'), (SELECT max(id) FROM materials)),
           setval(pg_get_serial_sequence('deliveries', 'id'), (SELECT max(id) FROM deliveries))`);
}

async function main() {
  const reset = process.argv.includes('--reset');
  await runMigrations();
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT EXISTS (SELECT 1 FROM users) AS has_data');
    if (rows[0].has_data && !reset) {
      console.error('The database already has data. Run again with --reset to replace all of it.');
      process.exitCode = 1;
      return;
    }
    const started = Date.now();
    await client.query('BEGIN');
    try {
      await seed(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    // Fresh statistics so the query planner knows the real table sizes.
    await step(client, 'analyze', 'ANALYZE');

    const counts = await client.query(`
      SELECT 'users' AS t, count(*) FROM users UNION ALL SELECT 'projects', count(*) FROM projects
      UNION ALL SELECT 'project members', count(*) FROM project_members
      UNION ALL SELECT 'invitations', count(*) FROM invitations UNION ALL SELECT 'tasks', count(*) FROM tasks
      UNION ALL SELECT 'task dependencies', count(*) FROM task_dependencies
      UNION ALL SELECT 'materials', count(*) FROM materials UNION ALL SELECT 'deliveries', count(*) FROM deliveries
      UNION ALL SELECT 'delivery lines', count(*) FROM delivery_lines
      UNION ALL SELECT 'stock rows', count(*) FROM store_stock`);
    console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const r of counts.rows) console.log(`  ${r.t.padEnd(18)} ${Number(r.count).toLocaleString()}`);
    console.log(`\nLog in with admin@sitetrack.test, manager@sitetrack.test or user@sitetrack.test / ${PASSWORD}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
