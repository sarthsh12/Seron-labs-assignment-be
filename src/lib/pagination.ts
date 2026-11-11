import { z } from 'zod';

export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
