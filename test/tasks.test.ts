import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { call, createProject, createTask, registerUser, type TestUser } from './helpers.js';

let owner: TestUser;
before(async () => {
  owner = await registerUser();
});

const url = (project: string, task = '', suffix = '') => `/projects/${project}/tasks${task ? `/${task}` : ''}${suffix}`;
const act = (project: string, task: string, action: string) => call('POST', url(project, task, `/${action}`), { token: owner.token });
const depend = (project: string, task: string, on: string) =>
  call('POST', url(project, task, '/dependencies'), { token: owner.token, body: { dependsOn: on } });
const get = async (project: string, task: string) => (await call('GET', url(project, task), { token: owner.token })).body;

describe('task IDs', () => {
  test('numbers count up within each project and stay unique under concurrent creates', async () => {
    const p1 = await createProject(owner, 'P1');
    const p2 = await createProject(owner, 'P2');
    assert.equal(await createTask(owner, p1, 'first'), `${p1}-T-0001`);
    assert.equal(await createTask(owner, p2, 'first'), `${p2}-T-0001`);

    const codes = await Promise.all(Array.from({ length: 20 }, (_, i) => createTask(owner, p1, `t${i}`)));
    const numbers = codes.map((c) => Number(c.slice(-4))).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => i + 2));
  });

  test('a deleted task\'s number is never reused', async () => {
    const p = await createProject(owner);
    await createTask(owner, p, 'a');
    const b = await createTask(owner, p, 'b');
    assert.equal((await call('DELETE', url(p, b), { token: owner.token })).status, 204);
    assert.equal(await createTask(owner, p, 'c'), `${p}-T-0003`);
  });
});

describe('dependencies', () => {
  test('cycles are rejected, directly and through other tasks', async () => {
    const p = await createProject(owner);
    const a = await createTask(owner, p, 'A');
    const b = await createTask(owner, p, 'B');
    const c = await createTask(owner, p, 'C');
    assert.equal((await depend(p, b, a)).status, 201); // B waits for A
    assert.equal((await depend(p, c, b)).status, 201); // C waits for B

    assert.equal((await depend(p, a, a)).status, 400); // itself
    assert.equal((await depend(p, a, b)).status, 409); // A -> B -> A
    assert.equal((await depend(p, a, c)).status, 409); // A -> C -> B -> A
    assert.equal((await depend(p, c, b)).status, 409); // already exists
  });

  test('dependencies only link tasks in the same project', async () => {
    const p1 = await createProject(owner);
    const p2 = await createProject(owner);
    const t1 = await createTask(owner, p1, 'here');
    const t2 = await createTask(owner, p2, 'there');
    assert.equal((await depend(p1, t1, t2)).status, 400);
  });

  test('two opposite dependencies added at the same moment cannot both succeed', async () => {
    const p = await createProject(owner);
    const a = await createTask(owner, p, 'A');
    const b = await createTask(owner, p, 'B');
    const results = await Promise.all([depend(p, a, b), depend(p, b, a)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });

  test('task details list every task it waits on, and every task waiting on it, with steps', async () => {
    // D waits on B and C; B and C both wait on A (a diamond): A is 2 steps from D by either path.
    const p = await createProject(owner);
    const a = await createTask(owner, p, 'A');
    const b = await createTask(owner, p, 'B');
    const c = await createTask(owner, p, 'C');
    const d = await createTask(owner, p, 'D');
    await depend(p, b, a);
    await depend(p, c, a);
    await depend(p, d, b);
    await depend(p, d, c);

    const detail = await get(p, d);
    const steps = Object.fromEntries(detail.waitsOn.map((e: { id: string; steps: number }) => [e.id, e.steps]));
    assert.deepEqual(steps, { [a]: 2, [b]: 1, [c]: 1 });
    assert.deepEqual([...detail.dependsOn].sort(), [b, c].sort());

    const aDetail = await get(p, a);
    const waitedBy = Object.fromEntries(aDetail.waitedOnBy.map((e: { id: string; steps: number }) => [e.id, e.steps]));
    assert.deepEqual(waitedBy, { [b]: 1, [c]: 1, [d]: 2 });
    assert.equal(aDetail.dependentsCount, 2);
  });
});

describe('status and derived flags', () => {
  test('a task can start only when everything it waits on is done, directly or indirectly', async () => {
    const p = await createProject(owner);
    const a = await createTask(owner, p, 'A');
    const b = await createTask(owner, p, 'B');
    const c = await createTask(owner, p, 'C');
    await depend(p, b, a);
    await depend(p, c, b);

    assert.equal((await get(p, c)).isBlocked, true);
    assert.deepEqual((await get(p, c)).allowedActions, []);
    assert.equal((await act(p, c, 'start')).status, 409);

    await act(p, a, 'start');
    await act(p, a, 'complete');
    // A is done but B is not, so C is still blocked (indirectly).
    assert.equal((await get(p, c)).isBlocked, true);
    assert.equal((await get(p, b)).isBlocked, false);

    await act(p, b, 'start');
    await act(p, b, 'complete');
    assert.equal((await get(p, c)).isBlocked, false);
    assert.equal((await act(p, c, 'start')).status, 200);
  });

  test('only the allowed transitions work', async () => {
    const p = await createProject(owner);
    const t = await createTask(owner, p, 'T');
    assert.equal((await act(p, t, 'complete')).status, 409); // not started -> done
    assert.equal((await act(p, t, 'reopen')).status, 409);
    assert.deepEqual((await act(p, t, 'start')).body.allowedActions, ['complete']);
    assert.equal((await act(p, t, 'start')).status, 409);
    assert.deepEqual((await act(p, t, 'complete')).body.allowedActions, ['reopen']);
    const reopened = await act(p, t, 'reopen');
    assert.equal(reopened.body.status, 'in_progress');
  });

  test('reopen is refused once a task that waits on it has started', async () => {
    const p = await createProject(owner);
    const a = await createTask(owner, p, 'A');
    const b = await createTask(owner, p, 'B');
    await depend(p, b, a);
    await act(p, a, 'start');
    await act(p, a, 'complete');
    await act(p, b, 'start');
    assert.equal((await act(p, a, 'reopen')).status, 409);
  });

  test('late follows today\'s date: past end and not done, or past start and not started', async () => {
    const p = await createProject(owner);
    const past = { plannedStart: '2025-01-01', plannedEnd: '2025-01-10' };
    const startedLate = { plannedStart: '2025-01-01', plannedEnd: '2099-01-10' };
    const notStarted = await createTask(owner, p, 'overdue', past);
    const running = await createTask(owner, p, 'running', startedLate);
    const future = await createTask(owner, p, 'future');

    assert.equal((await get(p, notStarted)).isLate, true);
    assert.equal((await get(p, running)).isLate, true); // not started, start date passed
    await act(p, running, 'start');
    assert.equal((await get(p, running)).isLate, false); // in progress, end date in the future
    assert.equal((await get(p, future)).isLate, false);

    const lateList = await call('GET', `${url(p)}?late=true`, { token: owner.token });
    assert.deepEqual(lateList.body.items.map((t: { id: string }) => t.id), [notStarted]);
  });

  test('the projects list counts stay correct as tasks change', async () => {
    const p = await createProject(owner, 'Counted');
    const tasks = await Promise.all(['a', 'b', 'c', 'd'].map((n) => createTask(owner, p, n)));
    await Promise.all(tasks.slice(0, 3).map((t) => act(p, t, 'start')));
    await Promise.all(tasks.slice(0, 3).map((t) => act(p, t, 'complete')));
    await act(p, tasks[0], 'reopen');
    await call('DELETE', url(p, tasks[1]), { token: owner.token });

    const project = (await call('GET', `/projects/${p}`, { token: owner.token })).body;
    assert.deepEqual(project.taskCounts, { total: 3, notStarted: 1, inProgress: 1, done: 1 });
    assert.equal(project.percentDone, 33.3);
  });
});
