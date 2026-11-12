import type pg from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { lockProjectAsAdmin, requireProjectAccess } from '../auth/access.js';
import { pool, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

interface UserRef {
  id: number;
  name: string;
  email: string;
}

export interface Member extends UserRef {
  isAdmin: boolean;
  joinedAt: string;
}

export interface PendingInvitation {
  id: number;
  user: UserRef;
  invitedBy: UserRef;
  createdAt: string;
}

export async function listMembers(user: AuthUser, code: string) {
  const { projectId } = await requireProjectAccess(user, code);
  const [members, invitations] = await Promise.all([
    pool.query<Member>(
      `SELECT u.id, u.name, u.email, pm.is_admin AS "isAdmin", pm.joined_at AS "joinedAt"
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1
        ORDER BY pm.is_admin DESC, lower(u.name), u.id`,
      [projectId],
    ),
    pool.query<PendingInvitation>(
      `SELECT i.id,
              json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS "user",
              json_build_object('id', b.id, 'name', b.name, 'email', b.email) AS "invitedBy",
              i.created_at AS "createdAt"
         FROM invitations i
         JOIN users u ON u.id = i.invitee_id
         JOIN users b ON b.id = i.invited_by
        WHERE i.project_id = $1 AND i.status = 'pending'
        ORDER BY i.created_at DESC`,
      [projectId],
    ),
  ]);
  return { members: members.rows, pendingInvitations: invitations.rows };
}

export async function invite(user: AuthUser, code: string, email: string): Promise<PendingInvitation> {
  return withTransaction(async (client) => {
    const { projectId } = await lockProjectAsAdmin(user, code, client);

    const { rows: found } = await client.query<UserRef>('SELECT id, name, email FROM users WHERE email = $1', [email]);
    const invitee = found[0];
    if (!invitee) throw notFound('No registered user with this email');
    if (invitee.id === user.id) throw badRequest('You are already a member of this project');

    const { rowCount: isMember } = await client.query(
      'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, invitee.id],
    );
    if (isMember) throw conflict('This user is already a member');

    const { rows, rowCount } = await client.query<{ id: number; createdAt: string }>(
      `INSERT INTO invitations (project_id, invitee_id, invited_by) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, invitee_id) WHERE status = 'pending' DO NOTHING
       RETURNING id, created_at AS "createdAt"`,
      [projectId, invitee.id, user.id],
    );
    if (!rowCount) throw conflict('This user already has a pending invitation');

    return { id: rows[0].id, user: invitee, invitedBy: { id: user.id, name: user.name, email: user.email }, createdAt: rows[0].createdAt };
  });
}

export async function withdrawInvitation(user: AuthUser, code: string, invitationId: number): Promise<void> {
  await withTransaction(async (client) => {
    const { projectId } = await lockProjectAsAdmin(user, code, client);
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM invitations WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [invitationId, projectId],
    );
    if (!rows[0]) throw notFound('Invitation not found');
    if (rows[0].status !== 'pending') throw conflict(`Invitation was already ${rows[0].status}`);
    await client.query(
      `UPDATE invitations SET status = 'withdrawn', responded_at = now(), read_at = COALESCE(read_at, now())
        WHERE id = $1`,
      [invitationId],
    );
  });
}

// Run while holding the project lock, so the count can't change underneath us.
async function assertAnotherAdminRemains(client: pg.PoolClient, projectId: number, userId: number) {
  const { rows } = await client.query<{ others: number }>(
    'SELECT count(*) AS others FROM project_members WHERE project_id = $1 AND is_admin AND user_id <> $2',
    [projectId, userId],
  );
  if (rows[0].others === 0) throw conflict('A project must always have at least one project admin');
}

async function getMemberForUpdate(client: pg.PoolClient, projectId: number, userId: number) {
  const { rows } = await client.query<{ isAdmin: boolean }>(
    'SELECT is_admin AS "isAdmin" FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE',
    [projectId, userId],
  );
  if (!rows[0]) throw notFound('Member not found');
  return rows[0];
}

export async function setAdmin(user: AuthUser, code: string, memberId: number, isAdmin: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const { projectId } = await lockProjectAsAdmin(user, code, client);
    const member = await getMemberForUpdate(client, projectId, memberId);
    if (member.isAdmin === isAdmin) return;
    if (!isAdmin) await assertAnotherAdminRemains(client, projectId, memberId);
    await client.query('UPDATE project_members SET is_admin = $3 WHERE project_id = $1 AND user_id = $2', [
      projectId, memberId, isAdmin,
    ]);
  });
}

export async function removeMember(user: AuthUser, code: string, memberId: number): Promise<void> {
  await withTransaction(async (client) => {
    const { projectId } = await lockProjectAsAdmin(user, code, client);
    const member = await getMemberForUpdate(client, projectId, memberId);
    if (member.isAdmin) await assertAnotherAdminRemains(client, projectId, memberId);
    await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, memberId]);
  });
}
