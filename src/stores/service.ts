import type pg from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { requireProjectAccess } from '../auth/access.js';
import { requireCompanyStore } from '../auth/roles.js';
import { pool, withTransaction } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';
import { escapeLike } from '../lib/sql.js';

export interface StockLine {
  materialId: number;
  quantity: number;
}

export type StockStatus = 'out_of_stock' | 'low_stock' | 'available';

let companyStoreIdCache: number | undefined;
export async function companyStoreId(db: pg.Pool | pg.PoolClient = pool): Promise<number> {
  if (companyStoreIdCache === undefined) {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM stores WHERE kind = 'company'`);
    companyStoreIdCache = rows[0].id;
  }
  return companyStoreIdCache;
}

export async function projectStoreId(db: pg.Pool | pg.PoolClient, projectId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM stores WHERE project_id = $1', [projectId]);
  if (!rows[0]) throw notFound('Project not found');
  return rows[0].id;
}

// Rejects duplicate lines and materials that don't exist or were removed.
export async function assertActiveMaterials(db: pg.Pool | pg.PoolClient, lines: StockLine[]): Promise<void> {
  const ids = lines.map((l) => l.materialId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each material can appear only once');
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM materials WHERE id = ANY($1) AND deleted_at IS NULL',
    [ids],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw badRequest('Unknown materials', { materialIds: missing });
}

const STATUS_ORDER = `CASE status WHEN 'out_of_stock' THEN 0 WHEN 'low_stock' THEN 1 ELSE 2 END`;
const COMPANY_SORT = { name: 'lower(name)', quantity: 'quantity', status: STATUS_ORDER } as const;

export interface CompanyStockRow {
  materialId: number;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  inTransitToProjects: number;
  reorderPoint: number;
  status: StockStatus;
}

// Every catalogue material is listed, with 0 for materials the company store has never held.
export async function listCompanyStock(
  user: AuthUser,
  query: {
    status?: StockStatus[];
    category?: string;
    q?: string;
    sort: keyof typeof COMPANY_SORT;
    order: 'asc' | 'desc';
    page: number;
    pageSize: number;
  },
): Promise<Page<CompanyStockRow>> {
  requireCompanyStore(user);
  const dir = query.order === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await pool.query<CompanyStockRow & { total: number }>(
    `WITH stock AS (
       SELECT m.id AS "materialId", m.name, m.category, m.unit,
              COALESCE(s.quantity, 0)::float8 AS quantity,
              COALESCE(s.in_transit_out, 0)::float8 AS "inTransitToProjects",
              COALESCE(s.reorder_point, 0)::float8 AS "reorderPoint",
              CASE WHEN COALESCE(s.quantity, 0) = 0 THEN 'out_of_stock'
                   WHEN s.quantity <= s.reorder_point THEN 'low_stock'
                   ELSE 'available' END AS status
         FROM materials m
         LEFT JOIN store_stock s ON s.material_id = m.id AND s.store_id = $1
        WHERE m.deleted_at IS NULL
          AND ($2::text IS NULL OR m.name ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR m.category = $3)
     )
     SELECT *, count(*) OVER () AS total
       FROM stock
      WHERE ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY ${COMPANY_SORT[query.sort]} ${dir}, "materialId" ${dir}
      LIMIT $5 OFFSET $6`,
    [
      await companyStoreId(),
      query.q?.trim() ? escapeLike(query.q.trim()) : null,
      query.category ?? null,
      query.status?.length ? query.status : null,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ],
  );
  return {
    items: rows.map(({ total: _, ...r }) => r),
    page: query.page,
    pageSize: query.pageSize,
    total: rows[0]?.total ?? 0,
  };
}

// Stock arriving from a supplier: the only way new material enters SiteTrack. All lines apply or none do.
export async function addStock(user: AuthUser, lines: StockLine[]) {
  requireCompanyStore(user);
  return withTransaction(async (client) => {
    await assertActiveMaterials(client, lines);
    const storeId = await companyStoreId(client);
    const { rows } = await client.query<{ materialId: number; quantity: number }>(
      `INSERT INTO store_stock (store_id, material_id, quantity)
       SELECT $1, v.material_id, v.quantity
         FROM unnest($2::bigint[], $3::numeric[]) AS v(material_id, quantity)
        ORDER BY v.material_id
       ON CONFLICT (store_id, material_id) DO UPDATE SET quantity = store_stock.quantity + EXCLUDED.quantity
       RETURNING material_id AS "materialId", quantity::float8 AS quantity`,
      [storeId, lines.map((l) => l.materialId), lines.map((l) => l.quantity)],
    );
    return { items: rows };
  });
}

export async function setReorderPoint(user: AuthUser, materialId: number, reorderPoint: number) {
  requireCompanyStore(user);
  await assertActiveMaterials(pool, [{ materialId, quantity: 0 }]);
  const { rows } = await pool.query<{ materialId: number; reorderPoint: number }>(
    `INSERT INTO store_stock (store_id, material_id, reorder_point) VALUES ($1, $2, $3)
     ON CONFLICT (store_id, material_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point
     RETURNING material_id AS "materialId", reorder_point::float8 AS "reorderPoint"`,
    [await companyStoreId(), materialId, reorderPoint],
  );
  return rows[0];
}

const PROJECT_SORT = {
  name: 'lower(m.name)',
  quantity: 's.quantity',
  lastDelivery: 's.last_movement_at',
} as const;

export interface ProjectStockRow {
  materialId: number;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  lastDeliveryAt: string | null;
}

export async function listProjectStock(
  user: AuthUser,
  projectCode: string,
  query: { q?: string; category?: string; sort: keyof typeof PROJECT_SORT; order: 'asc' | 'desc'; page: number; pageSize: number },
): Promise<Page<ProjectStockRow>> {
  const { projectId } = await requireProjectAccess(user, projectCode);
  const dir = query.order === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await pool.query<ProjectStockRow & { total: number }>(
    `SELECT m.id AS "materialId", m.name, m.category, m.unit, s.quantity::float8 AS quantity,
            s.last_movement_at AS "lastDeliveryAt", count(*) OVER () AS total
       FROM store_stock s
       JOIN stores st ON st.id = s.store_id
       JOIN materials m ON m.id = s.material_id
      WHERE st.project_id = $1
        AND m.deleted_at IS NULL
        AND ($2::text IS NULL OR m.name ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR m.category = $3)
      ORDER BY ${PROJECT_SORT[query.sort]} ${dir} NULLS LAST, m.id ${dir}
      LIMIT $4 OFFSET $5`,
    [
      projectId,
      query.q?.trim() ? escapeLike(query.q.trim()) : null,
      query.category ?? null,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ],
  );
  return {
    items: rows.map(({ total: _, ...r }) => r),
    page: query.page,
    pageSize: query.pageSize,
    total: rows[0]?.total ?? 0,
  };
}
