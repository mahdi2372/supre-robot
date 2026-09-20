import type { SupreModule } from '../../core/module.js';
import { moderationCommands } from './commands.js';
import { moderationSettingsDefaults, moderationSettingsSchema } from './settings.js';

/**
 * Moderation module: case-based punishments (warn/ban/kick/timeout/softban),
 * warning escalation, channel tools (clear/slowmode/lock/unlock), case
 * lookup. Temporary punishments are durably scheduled to auto-expire.
 */
export const moderationModule: SupreModule = {
  name: 'moderation',
  version: '0.1.0',
  description: 'Punishments, warnings, escalation, channel tools, case history',
  dependencies: ['core', 'logging'],
  commands: moderationCommands
};

export { moderationSettingsSchema, moderationSettingsDefaults };
