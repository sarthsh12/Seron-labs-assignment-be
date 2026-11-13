import { forbidden } from '../lib/errors.js';
import type { AuthUser } from './authenticate.js';

export const canUseCompanyStore = (user: AuthUser) => user.role === 'store_manager' || user.role === 'super_admin';

export function requireCompanyStore(user: AuthUser): void {
  if (!canUseCompanyStore(user)) throw forbidden('Only company store managers and SuperAdmins can do this');
}
