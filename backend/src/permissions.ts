import { Prisma } from '@prisma/client';

export const PERMISSIONS = [
  { key: 'investigate.view', group: 'Investigate', label: 'View investigations', description: 'Address, transaction, graph, path and risk pages' },
  { key: 'export.data', group: 'Investigate', label: 'Export data', description: 'CSV downloads and case reports' },
  { key: 'screen.run', group: 'Screening', label: 'Run bulk screening', description: 'Create bulk screening jobs' },
  { key: 'labels.view', group: 'Labels', label: 'View labels', description: 'See labels and their sources' },
  { key: 'labels.manage', group: 'Labels', label: 'Manage labels', description: 'Create, delete and import labels' },
  { key: 'labels.sync', group: 'Labels', label: 'Sync label sources', description: 'Run OFAC and Tether sync, import labels from a URL' },
  { key: 'monitor.view', group: 'Monitoring', label: 'View monitoring', description: 'See watchlists, rules and alerts' },
  { key: 'monitor.manage', group: 'Monitoring', label: 'Manage monitoring', description: 'Create and edit watchlists and rules' },
  { key: 'alerts.triage', group: 'Monitoring', label: 'Triage alerts', description: 'Change alert status' },
  { key: 'cases.view', group: 'Cases', label: 'View cases', description: 'See cases and their evidence' },
  { key: 'cases.manage', group: 'Cases', label: 'Manage cases', description: 'Create and edit cases, addresses, notes, files and graphs' },
  { key: 'cases.delete', group: 'Cases', label: 'Delete cases', description: 'Permanently delete cases' },
  { key: 'attribution.run', group: 'Attribution', label: 'Run clustering', description: 'Start deposit-address clustering' },
  { key: 'attribution.review', group: 'Attribution', label: 'Review suggestions', description: 'Accept or reject cluster suggestions' },
  { key: 'notify.manage', group: 'Platform', label: 'Manage notifications', description: 'Email and webhook targets' },
  { key: 'users.manage', group: 'Platform', label: 'Manage users', description: 'Create, disable, change role, reset 2FA, revoke sessions' },
  { key: 'roles.manage', group: 'Platform', label: 'Manage roles', description: 'Create, edit and delete custom roles' },
  { key: 'apikeys.manage', group: 'Platform', label: 'Manage API keys', description: 'Create and revoke API keys' },
  { key: 'audit.view', group: 'Platform', label: 'View audit log', description: 'Read the audit log' },
  { key: 'org.manage', group: 'Platform', label: 'Manage organisation', description: 'Name, require 2FA, session lifetime' },
] as const;

export type PermKey = (typeof PERMISSIONS)[number]['key'];
export const ALL_PERMS: string[] = PERMISSIONS.map((p) => p.key);

/** Built-in roles, created per org. Their permissions are re-synced from here at every boot. */
export const SYSTEM_ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: 'Owner', description: 'Full control, including organisation settings', permissions: ALL_PERMS },
  { name: 'Admin', description: 'Everything except organisation settings', permissions: ALL_PERMS.filter((p) => p !== 'org.manage') },
  {
    name: 'Analyst',
    description: 'Investigates, screens, monitors and works cases',
    permissions: ['investigate.view', 'export.data', 'screen.run', 'labels.view', 'labels.manage', 'monitor.view', 'monitor.manage', 'alerts.triage', 'cases.view', 'cases.manage', 'attribution.run', 'attribution.review'],
  },
  { name: 'Viewer', description: 'Read-only access', permissions: ['investigate.view', 'labels.view', 'monitor.view', 'cases.view'] },
];

/** True if `held` contains at least one of `needed`. */
export const hasAny = (held: readonly string[], needed: readonly string[]) => needed.some((p) => held.includes(p));
/** Permissions in `wanted` that `held` lacks. */
export const missing = (held: readonly string[], wanted: readonly string[]) => wanted.filter((p) => !held.includes(p));

/** Creates or updates the four system roles of one org; returns role ids by name. */
export async function ensureSystemRoles(tx: Pick<Prisma.TransactionClient, 'role'>, orgId: number) {
  const ids: Record<string, number> = {};
  for (const r of SYSTEM_ROLES) {
    const row = await tx.role.upsert({
      where: { orgId_name: { orgId, name: r.name } },
      create: { orgId, name: r.name, description: r.description, system: true, permissions: r.permissions },
      update: { description: r.description, system: true, permissions: r.permissions },
    });
    ids[r.name] = row.id;
  }
  return ids;
}
