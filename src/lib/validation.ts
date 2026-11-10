import { z } from 'zod';

// Parses untrusted input; a ZodError becomes a 400 response in the global error handler.
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}
