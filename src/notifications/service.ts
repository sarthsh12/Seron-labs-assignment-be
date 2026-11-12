import type { AuthUser } from '../auth/authenticate.js';
import { pool, withTransaction } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';

// Notifications are the user's project invitations. Withdrawn ones are hidden: to the invitee
// it's as if they were never sent.
export interface Notification {
  id: number;
  type: 'project_invitation';
  status: 'pending' | 'accepted' | 'rejected';
  read: boolean;
  project: { id: string; name: string };
  invitedBy: { id: number; name: string };
  createdAt: string;
  respondedAt: string | null;
}

export async function unreadCount(user: AuthUser): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*) AS n FROM invitations WHERE invitee_id = $1 AND read_at IS NULL',
    [user.id],
  );
  return rows[0].n;
}

export async function listNotifications(
  user: AuthUser,
  page: number,
  pageSize: number,
): Promise<Page<Notification> & { unreadCount: number }> {
  const [list, unread] = await Promise.all([
    pool.query<Notification & { total: number }>(
      `SELECT i.id, 'project_invitation' AS type, i.status, i.read_at IS NOT NULL AS read,
              json_build_object('id', p.code, 'name', p.name) AS project,
              json_build_object('id', b.id, 'name', b.name) AS "invitedBy",
              i.created_at AS "createdAt", i.responded_at AS "respondedAt",
              count(*) OVER () AS total
         FROM invitations i
         JOIN projects p ON p.id = i.project_id
         JOIN users b ON b.id = i.invited_by
        WHERE i.invitee_id = $1 AND i.status <> 'withdrawn'
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $2 OFFSET $3`,
      [user.id, pageSize, (page - 1) * pageSize],
    ),
    unreadCount(user),
  ]);
  return {
    items: list.rows.map(({ total: _, ...n }) => n),
    page,
    pageSize,
    total: list.rows[0]?.total ?? 0,
    unreadCount: unread,
  };
}

export async function markRead(user: AuthUser, invitationId?: number): Promise<number> {
  await pool.query(
    `UPDATE invitations SET read_at = now()
      WHERE invitee_id = $1 AND read_at IS NULL AND ($2::bigint IS NULL OR id = $2)`,
    [user.id, invitationId ?? null],
  );
  return unreadCount(user);
}

// Only the invited person can answer; anyone else gets 404 as if the invitation didn't exist.
export async function respond(user: AuthUser, invitationId: number, accept: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const { rows: found } = await client.query<{ projectId: number }>(
      'SELECT project_id AS "projectId" FROM invitations WHERE id = $1 AND invitee_id = $2',
      [invitationId, user.id],
    );
    if (!found[0]) throw notFound('Invitation not found');

    // Lock order (project, then invitation) matches the admin-side actions, which avoids deadlocks.
    await client.query('SELECT 1 FROM projects WHERE id = $1 FOR SHARE', [found[0].projectId]);
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM invitations WHERE id = $1 FOR UPDATE',
      [invitationId],
    );
    if (rows[0].status !== 'pending') throw conflict(`Invitation was already ${rows[0].status}`);

    await client.query(
      `UPDATE invitations SET status = $2, responded_at = now(), read_at = COALESCE(read_at, now())
        WHERE id = $1`,
      [invitationId, accept ? 'accepted' : 'rejected'],
    );
    if (accept) {
      await client.query(
        `INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [found[0].projectId, user.id],
      );
    }
  });
}
