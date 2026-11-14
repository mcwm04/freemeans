// One place that says who may do what. Checked on the server for every route; views only use it to hide buttons.
export const ROLES = ['owner', 'admin', 'editor', 'viewer'];
const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };

// permission -> lowest role that has it
const MIN_ROLE = {
  'queue.view': 'viewer',
  'queue.review': 'editor',
  'account.own': 'viewer',
  'users.view': 'admin',
  'users.manage': 'admin',
  'audit.view': 'admin',
  'content.view': 'viewer', // published tools and offers
  'content.edit': 'editor',
  'analytics.view': 'viewer',
  'health.view': 'admin',
  'settings.view': 'admin',
  'settings.edit': 'owner',
  'controls.run': 'admin',
  'controls.danger': 'owner',
  'waitlist.view': 'admin',
  'waitlist.export': 'admin',
};

export const can = (role, perm) => !!MIN_ROLE[perm] && (RANK[role] ?? 0) >= RANK[MIN_ROLE[perm]];

/** May `actor` change or deactivate `target`, and may they hand out `newRole`? Owners are touched only by owners. */
export function canManage(actorRole, targetRole, newRole = targetRole) {
  if (!can(actorRole, 'users.manage')) return false;
  if (actorRole === 'owner') return true;
  return targetRole !== 'owner' && newRole !== 'owner';
}
