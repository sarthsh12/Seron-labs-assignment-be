import type pg from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { projectIdFromCode, requireProjectAccess } from '../auth/access.js';
import { canUseCompanyStore, requireCompanyStore } from '../auth/roles.js';
import { pool, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';
import { assertActiveMaterials, companyStoreId, projectStoreId, type StockLine } from '../stores/service.js';

export type Direction = 'to_project' | 'to_company';
export type DeliveryStatus = 'in_transit' | 'delivered' | 'rejected' | 'cancelled';
export type DeliveryAction = 'record' | 'reject' | 'cancel';

export interface Delivery {
  id: number;
  project: { id: string; name: string };
  direction: Direction;
  status: DeliveryStatus;
  lines: { materialId: number; name: string; unit: string; quantity: number }[];
  sentAt: string;
  sentBy: { id: number; name: string };
  resolvedAt: string | null;
  resolvedBy: { id: number; name: string } | null;
  allowedActions: DeliveryAction[];
}

// Which side of a delivery the viewer can act for: the company store side, the project side, or both.
interface Sides {
  company: boolean;
  project: boolean;
}

function allowedActions(d: { direction: Direction; status: DeliveryStatus }, sides: Sides): DeliveryAction[] {
  if (d.status !== 'in_transit') return [];
  const sender = d.direction === 'to_project' ? sides.company : sides.project;
  const receiver = d.direction === 'to_project' ? sides.project : sides.company;
  return [...(receiver ? (['record', 'reject'] as const) : []), ...(sender ? (['cancel'] as const) : [])];
}

// ---------- Stock movements ----------
// Every movement locks the stock rows it touches with one ORDER BY store_id, material_id query, so two
// transactions always take their locks in the same order and can't deadlock each other.

async function lockStock(client: pg.PoolClient, storeIds: number[], materialIds: number[]): Promise<void> {
  await client.query(
    `SELECT 1 FROM store_stock
      WHERE store_id = ANY($1) AND material_id = ANY($2)
      ORDER BY store_id, material_id
      FOR UPDATE`,
    [storeIds, materialIds],
  );
}

// Takes the quantities out of the sender's stock and marks them as in transit. Fails as a whole if any
// line is short. The CHECK (quantity >= 0) constraint backs this up at the database level.
async function takeFromSender(client: pg.PoolClient, storeId: number, lines: StockLine[]): Promise<void> {
  const ids = lines.map((l) => l.materialId);
  const qtys = lines.map((l) => l.quantity);
  await lockStock(client, [storeId], ids);
  const { rows: short } = await client.query<{ materialId: number; available: number; requested: number }>(
    `SELECT v.material_id AS "materialId", COALESCE(s.quantity, 0)::float8 AS available, v.qty::float8 AS requested
       FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)
       LEFT JOIN store_stock s ON s.store_id = $1 AND s.material_id = v.material_id
      WHERE COALESCE(s.quantity, 0) < v.qty`,
    [storeId, ids, qtys],
  );
  if (short.length) throw conflict('Not enough stock', { shortages: short });
  await client.query(
    `UPDATE store_stock s
        SET quantity = s.quantity - v.qty, in_transit_out = s.in_transit_out + v.qty, last_movement_at = now()
       FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)
      WHERE s.store_id = $1 AND s.material_id = v.material_id`,
    [storeId, ids, qtys],
  );
}

async function createDelivery(
  client: pg.PoolClient,
  projectId: number,
  direction: Direction,
  user: AuthUser,
  lines: StockLine[],
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    'INSERT INTO deliveries (project_id, direction, sent_by) VALUES ($1, $2, $3) RETURNING id',
    [projectId, direction, user.id],
  );
  await client.query(
    `INSERT INTO delivery_lines (delivery_id, material_id, quantity)
     SELECT $1, v.material_id, v.qty FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)`,
    [rows[0].id, lines.map((l) => l.materialId), lines.map((l) => l.quantity)],
  );
  return rows[0].id;
}

// The project row is share-locked so the project can't be removed while a delivery is being sent to or from it.
async function lockActiveProject(client: pg.PoolClient, projectId: number): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL FOR SHARE',
    [projectId],
  );
  if (!rowCount) throw notFound('Project not found');
}

// Company store -> project store.
export async function sendToProject(user: AuthUser, projectCode: string, lines: StockLine[]): Promise<Delivery> {
  requireCompanyStore(user);
  const projectId = projectIdFromCode(projectCode);
  if (projectId === null) throw badRequest('Unknown project');
  const id = await withTransaction(async (client) => {
    await lockActiveProject(client, projectId).catch(() => {
      throw badRequest('Unknown project');
    });
    await assertActiveMaterials(client, lines);
    await takeFromSender(client, await companyStoreId(client), lines);
    return createDelivery(client, projectId, 'to_project', user, lines);
  });
  return getDelivery(user, id);
}

// Project store -> company store.
export async function sendToCompany(user: AuthUser, projectCode: string, lines: StockLine[]): Promise<Delivery> {
  const id = await withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    await lockActiveProject(client, projectId);
    await assertActiveMaterials(client, lines);
    await takeFromSender(client, await projectStoreId(client, projectId), lines);
    return createDelivery(client, projectId, 'to_company', user, lines);
  });
  return getDelivery(user, id);
}

async function viewerSides(db: pg.Pool | pg.PoolClient, user: AuthUser, projectId: number): Promise<Sides> {
  if (user.role === 'super_admin') return { company: true, project: true };
  const { rowCount } = await db.query(
    `SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id = $1 AND pm.user_id = $2 AND p.deleted_at IS NULL`,
    [projectId, user.id],
  );
  return { company: canUseCompanyStore(user), project: rowCount === 1 };
}

// Record, reject or cancel an in-transit delivery. Each one moves stock and closes the delivery in one transaction.
export async function actOnDelivery(user: AuthUser, deliveryId: number, action: DeliveryAction): Promise<Delivery> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ projectId: number; direction: Direction; status: DeliveryStatus }>(
      `SELECT project_id AS "projectId", direction, status FROM deliveries WHERE id = $1 FOR UPDATE`,
      [deliveryId],
    );
    const d = rows[0];
    if (!d) throw notFound('Delivery not found');
    const sides = await viewerSides(client, user, d.projectId);
    if (!sides.company && !sides.project) throw notFound('Delivery not found');
    if (d.status !== 'in_transit') throw conflict(`Delivery is already ${d.status}`);
    if (!allowedActions(d, sides).includes(action)) {
      throw forbidden(action === 'cancel' ? 'Only the sending side can cancel' : 'Only the receiving side can record or reject');
    }

    const { rows: lines } = await client.query<{ materialId: number; quantity: string }>(
      'SELECT material_id AS "materialId", quantity FROM delivery_lines WHERE delivery_id = $1',
      [deliveryId],
    );
    const ids = lines.map((l) => l.materialId);
    const qtys = lines.map((l) => l.quantity);
    const company = await companyStoreId(client);
    const project = await projectStoreId(client, d.projectId);
    const [senderStore, receiverStore] = d.direction === 'to_project' ? [company, project] : [project, company];

    if (action === 'record') {
      // Make sure the receiver has a row for each material, then lock both stores' rows in one ordered pass.
      await client.query(
        `INSERT INTO store_stock (store_id, material_id)
         SELECT $1, m FROM unnest($2::bigint[]) AS m ORDER BY m
         ON CONFLICT DO NOTHING`,
        [receiverStore, ids],
      );
      await lockStock(client, [senderStore, receiverStore], ids);
      await client.query(
        `UPDATE store_stock s SET in_transit_out = s.in_transit_out - v.qty
           FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)
          WHERE s.store_id = $1 AND s.material_id = v.material_id`,
        [senderStore, ids, qtys],
      );
      await client.query(
        `UPDATE store_stock s SET quantity = s.quantity + v.qty, last_movement_at = now()
           FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)
          WHERE s.store_id = $1 AND s.material_id = v.material_id`,
        [receiverStore, ids, qtys],
      );
    } else {
      // Rejected or cancelled: everything goes back to the sender.
      await lockStock(client, [senderStore], ids);
      await client.query(
        `UPDATE store_stock s SET quantity = s.quantity + v.qty, in_transit_out = s.in_transit_out - v.qty
           FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, qty)
          WHERE s.store_id = $1 AND s.material_id = v.material_id`,
        [senderStore, ids, qtys],
      );
    }

    const status: DeliveryStatus = action === 'record' ? 'delivered' : action === 'reject' ? 'rejected' : 'cancelled';
    await client.query(
      'UPDATE deliveries SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1',
      [deliveryId, status, user.id],
    );
  });
  return getDelivery(user, deliveryId);
}

// ---------- Reading ----------

export interface DeliveryFilter {
  direction?: Direction;
  status?: DeliveryStatus[];
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

interface DeliveryRow extends Omit<Delivery, 'allowedActions'> {
  projectId: number;
  total: number;
}

// Filters and pages the deliveries first, then fetches material lines only for the rows on the page.
async function queryDeliveries(
  projectId: number | null,
  f: DeliveryFilter & { id?: number },
): Promise<DeliveryRow[]> {
  const { rows } = await pool.query<DeliveryRow>(
    `WITH page AS (
       SELECT d.*, count(*) OVER () AS total
         FROM deliveries d
        WHERE ($1::bigint IS NULL OR d.project_id = $1)
          AND ($2::bigint IS NULL OR d.id = $2)
          AND ($3::text IS NULL OR d.direction = $3)
          AND ($4::text[] IS NULL OR d.status = ANY($4))
          AND ($5::date IS NULL OR d.sent_at >= $5)
          AND ($6::date IS NULL OR d.sent_at < $6::date + 1)
        ORDER BY d.sent_at DESC, d.id DESC
        LIMIT $7 OFFSET $8
     )
     SELECT page.id, page.project_id AS "projectId", page.direction, page.status, page.total,
            page.sent_at AS "sentAt", page.resolved_at AS "resolvedAt",
            json_build_object('id', p.code, 'name', p.name) AS project,
            json_build_object('id', su.id, 'name', su.name) AS "sentBy",
            CASE WHEN ru.id IS NULL THEN NULL ELSE json_build_object('id', ru.id, 'name', ru.name) END AS "resolvedBy",
            (SELECT json_agg(json_build_object('materialId', m.id, 'name', m.name, 'unit', m.unit,
                                               'quantity', l.quantity::float8) ORDER BY m.name)
               FROM delivery_lines l JOIN materials m ON m.id = l.material_id
              WHERE l.delivery_id = page.id) AS lines
       FROM page
       JOIN projects p ON p.id = page.project_id
       JOIN users su ON su.id = page.sent_by
       LEFT JOIN users ru ON ru.id = page.resolved_by
      ORDER BY page.sent_at DESC, page.id DESC`,
    [
      projectId,
      f.id ?? null,
      f.direction ?? null,
      f.status?.length ? f.status : null,
      f.from ?? null,
      f.to ?? null,
      f.pageSize,
      (f.page - 1) * f.pageSize,
    ],
  );
  return rows;
}

function toPage(rows: DeliveryRow[], f: DeliveryFilter, sidesFor: (projectId: number) => Sides): Page<Delivery> {
  return {
    items: rows.map(({ total: _, projectId, ...d }) => ({ ...d, allowedActions: allowedActions(d, sidesFor(projectId)) })),
    page: f.page,
    pageSize: f.pageSize,
    total: rows[0]?.total ?? 0,
  };
}

export async function listProjectDeliveries(user: AuthUser, projectCode: string, f: DeliveryFilter) {
  const { projectId } = await requireProjectAccess(user, projectCode);
  const rows = await queryDeliveries(projectId, f);
  return toPage(rows, f, () => ({ company: canUseCompanyStore(user), project: true }));
}

export async function listCompanyDeliveries(user: AuthUser, f: DeliveryFilter & { project?: string }) {
  requireCompanyStore(user);
  let projectId: number | null = null;
  if (f.project) {
    projectId = projectIdFromCode(f.project);
    if (projectId === null) throw badRequest('Unknown project');
  }
  const rows = await queryDeliveries(projectId, f);
  return toPage(rows, f, () => ({ company: true, project: user.role === 'super_admin' }));
}

// Visible to the company store side and to members of the delivery's project; 404 for everyone else.
export async function getDelivery(user: AuthUser, id: number): Promise<Delivery> {
  const [row] = await queryDeliveries(null, { id, page: 1, pageSize: 1 });
  if (!row) throw notFound('Delivery not found');
  const sides = await viewerSides(pool, user, row.projectId);
  if (!sides.company && !sides.project) throw notFound('Delivery not found');
  const { total: _, projectId: __, ...d } = row;
  return { ...d, allowedActions: allowedActions(d, sides) };
}
