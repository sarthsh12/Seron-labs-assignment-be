import type { AuthUser } from '../auth/authenticate.js';
import { requireCompanyStore } from '../auth/roles.js';
import { pool, withTransaction } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';
import { escapeLike } from '../lib/sql.js';

export interface Material {
  id: number;
  name: string;
  category: string;
  unit: string;
  createdAt: string;
}

const COLUMNS = `id, name, category, unit, created_at AS "createdAt"`;
const SORT_COLUMNS = { name: 'lower(name)', category: 'lower(category)' } as const;
const DUPLICATE_NAME = 'A material with this name already exists';

export async function listMaterials(query: {
  q?: string;
  category?: string;
  sort: keyof typeof SORT_COLUMNS;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}): Promise<Page<Material>> {
  const dir = query.order === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await pool.query<Material & { total: number }>(
    `SELECT ${COLUMNS}, count(*) OVER () AS total
       FROM materials
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR category = $2)
      ORDER BY ${SORT_COLUMNS[query.sort]} ${dir}, id ${dir}
      LIMIT $3 OFFSET $4`,
    [query.q?.trim() ? escapeLike(query.q.trim()) : null, query.category ?? null, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return {
    items: rows.map(({ total: _, ...m }) => m),
    page: query.page,
    pageSize: query.pageSize,
    total: rows[0]?.total ?? 0,
  };
}

export async function listCategories(): Promise<string[]> {
  const { rows } = await pool.query<{ category: string }>(
    'SELECT DISTINCT category FROM materials WHERE deleted_at IS NULL ORDER BY category',
  );
  return rows.map((r) => r.category);
}

export async function getMaterial(id: number): Promise<Material> {
  const { rows } = await pool.query<Material>(`SELECT ${COLUMNS} FROM materials WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rows[0]) throw notFound('Material not found');
  return rows[0];
}

const isDuplicate = (err: unknown) => (err as { code?: string }).code === '23505';

export async function createMaterial(user: AuthUser, input: { name: string; category: string; unit: string }) {
  requireCompanyStore(user);
  try {
    const { rows } = await pool.query<Material>(
      `INSERT INTO materials (name, category, unit) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [input.name, input.category, input.unit],
    );
    return rows[0];
  } catch (err) {
    if (isDuplicate(err)) throw conflict(DUPLICATE_NAME);
    throw err;
  }
}

export async function updateMaterial(
  user: AuthUser,
  id: number,
  input: { name?: string; category?: string; unit?: string },
): Promise<Material> {
  requireCompanyStore(user);
  try {
    const { rows } = await pool.query<Material>(
      `UPDATE materials
          SET name = COALESCE($2, name), category = COALESCE($3, category), unit = COALESCE($4, unit)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${COLUMNS}`,
      [id, input.name ?? null, input.category ?? null, input.unit ?? null],
    );
    if (!rows[0]) throw notFound('Material not found');
    return rows[0];
  } catch (err) {
    if (isDuplicate(err)) throw conflict(DUPLICATE_NAME);
    throw err;
  }
}

// Soft delete, so past deliveries still show the material. Refused while any store holds or is sending it.
export async function deleteMaterial(user: AuthUser, id: number): Promise<void> {
  requireCompanyStore(user);
  await withTransaction(async (client) => {
    const { rowCount: found } = await client.query(
      'SELECT 1 FROM materials WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    if (!found) throw notFound('Material not found');
    const { rowCount: held } = await client.query(
      'SELECT 1 FROM store_stock WHERE material_id = $1 AND (quantity > 0 OR in_transit_out > 0) LIMIT 1',
      [id],
    );
    if (held) throw conflict('This material is still held in a store or in transit');
    await client.query('UPDATE materials SET deleted_at = now() WHERE id = $1', [id]);
  });
}
