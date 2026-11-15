import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { addMember, call, createProject, registerUser, type TestUser } from './helpers.js';

let manager: TestUser;
let siteAdmin: TestUser;
let siteMember: TestUser;
let outsider: TestUser;
let project: string;
let cement: number;
let steel: number;

before(async () => {
  manager = await registerUser('store_manager');
  siteAdmin = await registerUser();
  siteMember = await registerUser();
  outsider = await registerUser();
  project = await createProject(siteAdmin);
  await addMember(siteAdmin, project, siteMember);

  const material = async (name: string) =>
    (await call('POST', '/materials', { token: manager.token, body: { name, category: 'Binders', unit: 'bag' } })).body.id;
  cement = await material('Cement');
  steel = await material('Steel');
});

const companyStock = async (materialId: number) => {
  const res = await call('GET', '/company-store/stock?pageSize=100', { token: manager.token });
  return res.body.items.find((r: { materialId: number }) => r.materialId === materialId);
};
const projectQty = async (materialId: number) => {
  const res = await call('GET', `/projects/${project}/store`, { token: siteMember.token });
  return res.body.items.find((r: { materialId: number }) => r.materialId === materialId)?.quantity ?? 0;
};
const send = (lines: { materialId: number; quantity: number }[]) =>
  call('POST', '/company-store/deliveries', { token: manager.token, body: { projectId: project, lines } });

describe('materials catalogue', () => {
  test('everyone logged in reads it; only the company store side changes it', async () => {
    assert.equal((await call('GET', '/materials', { token: outsider.token })).status, 200);
    const create = await call('POST', '/materials', { token: siteAdmin.token, body: { name: 'Sand', category: 'x', unit: 'm3' } });
    assert.equal(create.status, 403);
  });

  test('names are unique regardless of case', async () => {
    const dup = await call('POST', '/materials', { token: manager.token, body: { name: 'CEMENT', category: 'x', unit: 'bag' } });
    assert.equal(dup.status, 409);
  });
});

describe('stock and deliveries', () => {
  test('stock status follows quantity and reorder point', async () => {
    assert.equal((await companyStock(cement)).status, 'out_of_stock');
    await call('POST', '/company-store/stock', { token: manager.token, body: { lines: [{ materialId: cement, quantity: 100 }] } });
    await call('PUT', `/company-store/stock/${cement}/reorder-point`, { token: manager.token, body: { reorderPoint: 100 } });
    assert.equal((await companyStock(cement)).status, 'low_stock'); // at the reorder point counts as low
    await call('PUT', `/company-store/stock/${cement}/reorder-point`, { token: manager.token, body: { reorderPoint: 99 } });
    assert.equal((await companyStock(cement)).status, 'available');
  });

  test('a send with any short line changes nothing', async () => {
    const res = await send([{ materialId: cement, quantity: 10 }, { materialId: steel, quantity: 5 }]);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details.shortages, [{ materialId: steel, available: 0, requested: 5 }]);
    assert.equal((await companyStock(cement)).quantity, 100);
  });

  test('send then record: stock leaves the sender, travels, and joins the receiver', async () => {
    const sent = await send([{ materialId: cement, quantity: 30 }]);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.status, 'in_transit');
    const afterSend = await companyStock(cement);
    assert.equal(afterSend.quantity, 70);
    assert.equal(afterSend.inTransitToProjects, 30);

    // Only the receiving side records, only the sender cancels, and outsiders can't see it at all.
    assert.equal((await call('POST', `/deliveries/${sent.body.id}/record`, { token: outsider.token })).status, 404);
    assert.equal((await call('POST', `/deliveries/${sent.body.id}/record`, { token: manager.token })).status, 403);
    assert.equal((await call('POST', `/deliveries/${sent.body.id}/cancel`, { token: siteMember.token })).status, 403);

    const recorded = await call('POST', `/deliveries/${sent.body.id}/record`, { token: siteMember.token });
    assert.equal(recorded.body.status, 'delivered');
    assert.equal((await call('POST', `/deliveries/${sent.body.id}/record`, { token: siteMember.token })).status, 409);
    assert.equal(await projectQty(cement), 30);
    assert.equal((await companyStock(cement)).inTransitToProjects, 0);
  });

  test('reject and cancel return the stock to the sender', async () => {
    const toReject = await send([{ materialId: cement, quantity: 20 }]);
    const toCancel = await send([{ materialId: cement, quantity: 15 }]);
    assert.equal((await companyStock(cement)).quantity, 35);

    assert.equal((await call('POST', `/deliveries/${toReject.body.id}/reject`, { token: siteMember.token })).body.status, 'rejected');
    assert.equal((await call('POST', `/deliveries/${toCancel.body.id}/cancel`, { token: manager.token })).body.status, 'cancelled');
    const stock = await companyStock(cement);
    assert.equal(stock.quantity, 70);
    assert.equal(stock.inTransitToProjects, 0);
  });

  test('a project sends material back; the company side records it', async () => {
    const tooMuch = await call('POST', `/projects/${project}/deliveries`, {
      token: siteMember.token,
      body: { lines: [{ materialId: cement, quantity: 31 }] },
    });
    assert.equal(tooMuch.status, 409);

    const back = await call('POST', `/projects/${project}/deliveries`, {
      token: siteMember.token,
      body: { lines: [{ materialId: cement, quantity: 10 }] },
    });
    assert.equal(back.status, 201);
    assert.equal(await projectQty(cement), 20);
    assert.equal((await call('POST', `/deliveries/${back.body.id}/record`, { token: manager.token })).status, 200);
    assert.equal((await companyStock(cement)).quantity, 80);
  });

  test('concurrent sends never take stock below zero', async () => {
    await call('POST', '/company-store/stock', { token: manager.token, body: { lines: [{ materialId: steel, quantity: 40 }] } });
    const results = await Promise.all(Array.from({ length: 10 }, () => send([{ materialId: steel, quantity: 6 }])));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 6);
    assert.equal(statuses.filter((s) => s === 409).length, 4);
    const stock = await companyStock(steel);
    assert.equal(stock.quantity, 4);
    assert.equal(stock.inTransitToProjects, 36);
  });

  test('a project with deliveries in transit cannot be removed', async () => {
    assert.equal((await call('DELETE', `/projects/${project}`, { token: siteAdmin.token })).status, 409);
  });

  test('a material held in a store cannot be removed', async () => {
    assert.equal((await call('DELETE', `/materials/${cement}`, { token: manager.token })).status, 409);
  });

  test('the project and company delivery lists show the same delivery with the right actions', async () => {
    const projectView = await call('GET', `/projects/${project}/deliveries?status=in_transit`, { token: siteMember.token });
    const companyView = await call('GET', `/company-store/deliveries?project=${project}&status=in_transit`, { token: manager.token });
    assert.equal(projectView.body.total, 6);
    assert.equal(companyView.body.total, 6);
    assert.deepEqual(projectView.body.items[0].allowedActions, ['record', 'reject']);
    assert.deepEqual(companyView.body.items[0].allowedActions, ['cancel']);
  });
});
