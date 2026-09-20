import type { ChatInputCommandInteraction, Client, Interaction } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { QueryExecutor } from '../types/index.js';
import type { CacheStore } from '../cache/types.js';
import type { SettingsService } from './settings.js';
import type { LogService } from '../services/logService.js';
import type { JobScheduler } from '../jobs/scheduler.js';
import type { Metrics } from './metrics.js';
import type { UiRegistry } from './ui.js';
import type { TranslateFn } from '../utils/i18n/types.js';

export type ModuleStatus = 'registered' | 'ready' | 'failed' | 'stopped';

/**
 * Everything a module may need from the platform core. Modules never touch
 * the pool, the client event bus, or settings storage directly — they go
 * through these services. This keeps module boundaries explicit and
 * testable.
 */
export interface ModuleContext {
  client: Client;
  config: AppConfig;
  db: QueryExecutor;
  cache: CacheStore;
  logger: Logger;
  settings: SettingsService;
  logs: LogService;
  jobs: JobScheduler;
  metrics: Metrics;
  ui: UiRegistry;
  t: TranslateFn;
  /** Live module status snapshot (name -> {status, version}). */
  moduleSnapshot: () => Record<string, { status: string; version: string }>;
}

/**
 * A slash command owned by a module.
 *
 * - `requiredPermission`: a Discord permission flag name (e.g. 'BanMembers')
 *   the invoking user must have. Enforced server-side, always.
 * - `requiredRoleId`: optional role id the user must hold (alternative to a
 *   permission for community-facing admin panels).
 * - `cooldownSeconds`: per user per guild.
 */
export interface SupreCommand {
  module: string;
  name: string;
  description: string;
  /**
   * Configure the Discord command builder: options and/or subcommands.
   * `name` and `description` come from this interface, not the builder.
   */
  configure?(builder: import('discord.js').SlashCommandBuilder): void;
  requiredPermission?: string;
  requiredRoleId?: string;
  cooldownSeconds?: number;
  guildOnly?: boolean;
  run(ctx: ModuleContext, interaction: ChatInputCommandInteraction): Promise<void>;
}

export type ComponentHandler = (ctx: ModuleContext, interaction: Interaction) => Promise<void>;

/**
 * Plugin contract (§30 of the spec). Adding a feature = implement one of
 * these, add it to the modules list in src/modules/index.ts. Nothing in the
 * core needs to change.
 */
export interface SupreModule {
  name: string;
  version: string;
  description?: string;
  /** Names of modules that must be ready before this one starts. */
  dependencies?: string[];
  commands?: SupreCommand[];
  /** Called once at boot: register component handlers, set up internals. */
  register?(ctx: ModuleContext): void | Promise<void>;
  /** Called after register: start listeners/timers. */
  startup?(ctx: ModuleContext): void | Promise<void>;
  /** Called on shutdown: dispose resources. */
  shutdown?(ctx: ModuleContext): void | Promise<void>;
}
