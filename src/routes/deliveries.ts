import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as deliveries from '../deliveries/service.js';
import { parse } from '../lib/validation.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const actionParams = idParams.extend({ action: z.enum(['record', 'reject', 'cancel']) });

export async function deliveryRoutes(app: FastifyInstance) {
  app.get('/deliveries/:id', async (request) => deliveries.getDelivery(request.user, parse(idParams, request.params).id));

  // POST /deliveries/57/record | reject | cancel
  app.post('/deliveries/:id/:action', async (request) => {
    const { id, action } = parse(actionParams, request.params);
    return deliveries.actOnDelivery(request.user, id, action);
  });
}
