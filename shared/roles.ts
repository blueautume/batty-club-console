import type { Role, User } from './types.ts';

export const isAdminRole = (role: Role | undefined): boolean => role === 'root' || role === 'admin';
export const canManageAdminAccounts = (user: Pick<User, 'role' | 'canManageAdmins'>): boolean => user.role === 'root' || user.role === 'admin' && user.canManageAdmins === true;
export const roleLabel = (role: Role): string => ({ root: 'root 管理员', admin: '管理员', staff: '客服', shareholder: '股东' })[role];
