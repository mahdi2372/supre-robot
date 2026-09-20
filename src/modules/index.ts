import type { SupreModule } from '../core/module.js';
import { coreModule } from './core/module.js';
import { loggingModule } from './logging/module.js';
import { welcomeModule } from './welcome/module.js';
import { moderationModule } from './moderation/module.js';
import { automodModule } from './automod/module.js';
import { configModule } from './config/module.js';
import { customModule } from './custom/module.js';

/**
 * The module registry. Adding a new feature module = implement a SupreModule
 * and add it here. The ModuleManager resolves dependency order and isolates
 * failures; the settings service registers each module's schema.
 */
export const ALL_MODULES: SupreModule[] = [
  coreModule,
  loggingModule,
  welcomeModule,
  moderationModule,
  automodModule,
  configModule,
  customModule
];
