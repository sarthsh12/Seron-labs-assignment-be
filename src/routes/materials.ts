import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { parse } from '../lib/validation.js';
import * as materials from '../materials/service.js';

const fields = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(30),
};
const createBody = z.object(fields);
const updateBody = z.object(fields).partial();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  sort: z.enum(['name', 'category']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...paginationQuery,
});

export async function materialRoutes(app: FastifyInstance) {
  app.get('/materials', async (request) => materials.listMaterials(parse(listQuery, request.query)));

  app.get('/materials/categories', async () => ({ categories: await materials.listCategories() }));

  app.get('/materials/:id', async (request) => materials.getMaterial(parse(idParams, request.params).id));

  app.post('/materials', async (request, reply) => {
    const material = await materials.createMaterial(request.user, parse(createBody, request.body));
    reply.code(201);
    return material;
  });

  app.patch('/materials/:id', async (request) =>
    materials.updateMaterial(request.user, parse(idParams, request.params).id, parse(updateBody, request.body)),
  );

  app.delete('/materials/:id', async (request, reply) => {
    await materials.deleteMaterial(request.user, parse(idParams, request.params).id);
    reply.code(204);
  });
}
