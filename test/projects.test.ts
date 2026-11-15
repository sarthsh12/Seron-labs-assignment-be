import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addMember, call, createProject, registerUser } from './helpers.js';

describe('project IDs', () => {
  test('codes count up across the company and stay unique under concurrent creates', async () => {
    const owner = await registerUser();
    const first = await createProject(owner, 'First');
    assert.equal(first, 'PRJ-0001');

    const codes = await Promise.all(Array.from({ length: 15 }, (_, i) => createProject(owner, `Parallel ${i}`)));
    assert.equal(new Set(codes).size, 15);
    const numbers = codes.map((c) => Number(c.slice(4))).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 15 }, (_, i) => i + 2));
  });

  test('a removed project\'s code is never reused', async () => {
    const owner = await registerUser();
    const removed = await createProject(owner, 'To remove');
    assert.equal((await call('DELETE', `/projects/${removed}`, { token: owner.token })).status, 204);
    const next = await createProject(owner, 'After');
    assert.ok(Number(next.slice(4)) > Number(removed.slice(4)));
    assert.equal((await call('GET', `/projects/${removed}`, { token: owner.token })).status, 404);
  });
});

describe('data security', () => {
  test('a non-member gets the same 404 as for a project that does not exist', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const project = await createProject(owner);

    for (const path of ['', '/tasks', '/members', '/store', '/deliveries']) {
      const real = await call('GET', `/projects/${project}${path}`, { token: outsider.token });
      const missing = await call('GET', `/projects/PRJ-9999${path}`, { token: outsider.token });
      assert.equal(real.status, 404, path);
      assert.deepEqual(real.body, missing.body, path);
    }
    const write = await call('POST', `/projects/${project}/tasks`, {
      token: outsider.token,
      body: { name: 'x', plannedStart: '2026-01-01', plannedEnd: '2026-01-02' },
    });
    assert.equal(write.status, 404);
  });

  test('lists only include projects the person can see; a SuperAdmin sees all', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const boss = await registerUser('super_admin');
    const mine = await createProject(alice, 'Visible to Alice');
    await createProject(bob, 'Visible to Bob');

    const aliceList = await call('GET', '/projects?pageSize=100', { token: alice.token });
    assert.ok(!aliceList.body.items.some((p: { name: string }) => p.name === 'Visible to Bob'));

    const search = await call('GET', '/projects?q=Visible', { token: alice.token });
    assert.equal(search.body.total, 1);

    const bossList = await call('GET', '/projects?q=Visible', { token: boss.token });
    assert.equal(bossList.body.total, 2);
    assert.ok(bossList.body.items.every((p: { isAdmin: boolean }) => p.isAdmin === false));
  });

  test('only the company store side reaches the company store', async () => {
    const user = await registerUser();
    const manager = await registerUser('store_manager');
    assert.equal((await call('GET', '/company-store/stock', { token: user.token })).status, 403);
    assert.equal((await call('GET', '/company-store/deliveries', { token: user.token })).status, 403);
    assert.equal((await call('GET', '/company-store/stock', { token: manager.token })).status, 200);
  });
});

describe('members and invitations', () => {
  test('invite, see it in notifications, and join only after accepting', async () => {
    const admin = await registerUser();
    const priya = await registerUser();
    const stranger = await registerUser();
    const project = await createProject(admin);

    const invite = await call('POST', `/projects/${project}/invitations`, { token: admin.token, body: { email: priya.email } });
    assert.equal(invite.status, 201);
    assert.equal((await call('GET', `/projects/${project}`, { token: priya.token })).status, 404);

    const unread = await call('GET', '/notifications/unread-count', { token: priya.token });
    assert.equal(unread.body.unreadCount, 1);
    const list = await call('GET', '/notifications', { token: priya.token });
    assert.equal(list.body.items[0].project.id, project);
    assert.equal(list.body.items[0].status, 'pending');

    assert.equal((await call('POST', `/invitations/${invite.body.id}/accept`, { token: stranger.token })).status, 404);
    assert.equal((await call('POST', `/invitations/${invite.body.id}/accept`, { token: priya.token })).status, 204);
    assert.equal((await call('POST', `/invitations/${invite.body.id}/reject`, { token: priya.token })).status, 409);

    const view = await call('GET', `/projects/${project}`, { token: priya.token });
    assert.equal(view.status, 200);
    assert.equal(view.body.isAdmin, false);
    assert.equal(view.body.memberCount, 2);
  });

  test('a withdrawn invitation disappears and can no longer be accepted', async () => {
    const admin = await registerUser();
    const guest = await registerUser();
    const project = await createProject(admin);
    const invite = await call('POST', `/projects/${project}/invitations`, { token: admin.token, body: { email: guest.email } });

    const duplicate = await call('POST', `/projects/${project}/invitations`, { token: admin.token, body: { email: guest.email } });
    assert.equal(duplicate.status, 409);

    assert.equal((await call('DELETE', `/projects/${project}/invitations/${invite.body.id}`, { token: admin.token })).status, 204);
    assert.equal((await call('GET', '/notifications', { token: guest.token })).body.total, 0);
    assert.notEqual((await call('POST', `/invitations/${invite.body.id}/accept`, { token: guest.token })).status, 204);
  });

  test('members who are not admins cannot manage members', async () => {
    const admin = await registerUser();
    const member = await registerUser();
    const other = await registerUser();
    const project = await createProject(admin);
    await addMember(admin, project, member);

    const invite = await call('POST', `/projects/${project}/invitations`, { token: member.token, body: { email: other.email } });
    assert.equal(invite.status, 403);
    const promote = await call('PATCH', `/projects/${project}/members/${member.id}`, { token: member.token, body: { isAdmin: true } });
    assert.equal(promote.status, 403);
  });

  test('the last project admin cannot step down or be removed', async () => {
    const admin = await registerUser();
    const project = await createProject(admin);
    const demote = await call('PATCH', `/projects/${project}/members/${admin.id}`, { token: admin.token, body: { isAdmin: false } });
    assert.equal(demote.status, 409);
    assert.equal((await call('DELETE', `/projects/${project}/members/${admin.id}`, { token: admin.token })).status, 409);
  });

  test('two admins demoting each other at the same moment still leave one admin', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const project = await createProject(a);
    await addMember(a, project, b);
    await call('PATCH', `/projects/${project}/members/${b.id}`, { token: a.token, body: { isAdmin: true } });

    await Promise.all([
      call('PATCH', `/projects/${project}/members/${b.id}`, { token: a.token, body: { isAdmin: false } }),
      call('PATCH', `/projects/${project}/members/${a.id}`, { token: b.token, body: { isAdmin: false } }),
    ]);
    const members = await call('GET', `/projects/${project}/members`, { token: a.token });
    const admins = members.body.members.filter((m: { isAdmin: boolean }) => m.isAdmin);
    assert.equal(admins.length, 1);
  });

  test('removing a member takes effect on their very next request', async () => {
    const admin = await registerUser();
    const member = await registerUser();
    const project = await createProject(admin);
    await addMember(admin, project, member);
    assert.equal((await call('GET', `/projects/${project}/tasks`, { token: member.token })).status, 200);

    assert.equal((await call('DELETE', `/projects/${project}/members/${member.id}`, { token: admin.token })).status, 204);
    assert.equal((await call('GET', `/projects/${project}/tasks`, { token: member.token })).status, 404);
  });
});
