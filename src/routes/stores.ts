import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as deliveries from '../deliveries/service.js';
import { paginationQuery } from '../lib/pagination.js';
import { parse } from '../lib/validation.js';
import * as stores from '../stores/service.js';

const quantity = z.number().positive().max(1_000_000_000);
const linesBody = z.object({
  lines: z.array(z.object({ materialId: z.number().int().positive(), quantity })).min(1).max(200),
});
const sendToProjectBody = linesBody.extend({ projectId: z.string() });
const reorderBody = z.object({ reorderPoint: z.number().min(0).max(1_000_000_000) });
const materialParams = z.object({ materialId: z.coerce.number().int().positive() });
const projectParams = z.object({ projectId: z.string() });

const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().transform((s) => s.split(',').map((v) => v.trim())).pipe(z.array(z.enum(values))).optional();

const companyStockQuery = z.object({
  status: commaList(['out_of_stock', 'low_stock', 'available'] as const),
  category: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['name', 'quantity', 'status']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...paginationQuery,
});

const projectStockQuery = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  sort: z.enum(['name', 'quantity', 'lastDelivery']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...paginationQuery,
});

const deliveryQuery = z.object({
  direction: z.enum(['to_project', 'to_company']).optional(),
  status: commaList(['in_transit', 'delivered', 'rejected', 'cancelled'] as const),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  ...paginationQuery,
});
const companyDeliveryQuery = deliveryQuery.extend({ project: z.string().max(20).optional() });

export async function storeRoutes(app: FastifyInstance) {
  // Company store (store managers and SuperAdmins)
  app.get('/company-store/stock', async (request) =>
    stores.listCompanyStock(request.user, parse(companyStockQuery, request.query)),
  );

  app.post('/company-store/stock', async (request, reply) => {
    const result = await stores.addStock(request.user, parse(linesBody, request.body).lines);
    reply.code(201);
    return result;
  });

  app.put('/company-store/stock/:materialId/reorder-point', async (request) => {
    const { materialId } = parse(materialParams, request.params);
    return stores.setReorderPoint(request.user, materialId, parse(reorderBody, request.body).reorderPoint);
  });

  app.get('/company-store/deliveries', async (request) =>
    deliveries.listCompanyDeliveries(request.user, parse(companyDeliveryQuery, request.query)),
  );

  app.post('/company-store/deliveries', async (request, reply) => {
    const { projectId, lines } = parse(sendToProjectBody, request.body);
    const delivery = await deliveries.sendToProject(request.user, projectId, lines);
    reply.code(201);
    return delivery;
  });

  // Project store (project members)
  app.get('/projects/:projectId/store', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    return stores.listProjectStock(request.user, projectId, parse(projectStockQuery, request.query));
  });

  app.get('/projects/:projectId/deliveries', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    return deliveries.listProjectDeliveries(request.user, projectId, parse(deliveryQuery, request.query));
  });

  app.post('/projects/:projectId/deliveries', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const delivery = await deliveries.sendToCompany(request.user, projectId, parse(linesBody, request.body).lines);
    reply.code(201);
    return delivery;
  });
}
