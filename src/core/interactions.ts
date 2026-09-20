import {
  Events,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction,
  type MentionableSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction
} from 'discord.js';

type ComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | RoleSelectMenuInteraction
  | MentionableSelectMenuInteraction;

function toComponentInteraction(interaction: Interaction): ComponentInteraction | undefined {
  if (interaction.isButton()) return interaction;
  if (interaction.isStringSelectMenu()) return interaction;
  if (interaction.isUserSelectMenu()) return interaction;
  if (interaction.isRoleSelectMenu()) return interaction;
  if (interaction.isMentionableSelectMenu()) return interaction;
  return undefined;
}
import type { ModuleContext, SupreCommand } from './module.js';
import type { ModuleManager } from './moduleManager.js';
import { SupreError, isSupreError, normalizeDiscordError } from '../utils/errors.js';
import { memberHasPermission, memberHasRole } from './permissions.js';
import { translate } from '../utils/i18n/index.js';
import type { CustomCommandRow, executeCustomCommand } from '../modules/custom/executor.js';

export interface InteractionRouterDeps {
  ctx: ModuleContext;
  manager: ModuleManager;
  /** Look up DB-backed custom commands (owned by the custom-commands module). */
  findCustomCommand: (guildId: string, name: string) => Promise<CustomCommandRow | undefined>;
  runCustomCommand: typeof executeCustomCommand;
}

/**
 * The single interaction entry point. Responsibilities:
 *  - route slash commands to module handlers (enabled-module + permission +
 *    cooldown gates, all server-side);
 *  - route DB-backed custom commands when they exist;
 *  - route buttons/selects by `module:action` customId;
 *  - map every failure to a clean, localized, ephemeral user message while
 *    logging the full detail for developers.
 */
export function attachInteractionRouter(deps: InteractionRouterDeps): void {
  const { ctx, manager } = deps;
  const commandMap = new Map<string, SupreCommand>();
  for (const cmd of manager.commands()) commandMap.set(cmd.name, cmd);

  ctx.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlash(deps, commandMap, interaction);
        return;
      }
      const component = toComponentInteraction(interaction);
      if (component) await handleComponent(deps, component);
    } catch (err) {
      const label =
        (interaction as { commandName?: string }).commandName ??
        (interaction as { customId?: string }).customId ??
        interaction.constructor.name;
      ctx.logger.error(
        {
          err: {
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : 'unknown',
            stack: err instanceof Error ? err.stack : undefined
          },
          interaction: label
        },
        'unhandled interaction error'
      );
    }
  });

  void ctx.client.once?.(Events.ClientReady, () => {
    ctx.logger.info({ commands: commandMap.size }, 'interaction router attached');
  });
}

async function guildOf(interaction: Interaction): Promise<Guild | null> {
  if (interaction.inGuild() && interaction.guild) return interaction.guild;
  return interaction.guild ?? null;
}

async function handleSlash(deps: InteractionRouterDeps, commandMap: Map<string, SupreCommand>, interaction: ChatInputCommandInteraction): Promise<void> {
  const { ctx } = deps;
  const guild = await guildOf(interaction);

  // 1. DB-backed custom commands take precedence when present & enabled.
  if (guild) {
    const custom = await deps.findCustomCommand(guild.id, interaction.commandName).catch(() => undefined);
    if (custom) {
      await deps.runCustomCommand(ctx, custom, interaction);
      return;
    }
  }

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    ctx.logger.warn({ name: interaction.commandName }, 'unknown slash command invoked');
    return;
  }

  ctx.metrics.recordCommand(command.module, command.name);

  const say = (text: string, ephemeral = true) => {
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content: text }).catch(() => undefined);
    return interaction.reply({ content: text, ephemeral });
  };

  // 2. Module must be enabled for this guild.
  if (guild && !(await ctx.settings.isEnabled(guild.id, command.module))) {
    ctx.metrics.recordError(command.module, 'MODULE_DISABLED');
    await say(translate(await localeOf(ctx, guild.id), 'error.module_disabled'));
    return;
  }

  // 3. Guild-only commands.
  if (command.guildOnly !== false && !guild) {
    await say(translate('en', 'error.guild_only'));
    return;
  }

  const member = (interaction.member ?? null) as GuildMember | null;
  if (!member) {
    ctx.metrics.recordError(command.module, 'PERMISSION_DENIED');
    await say(translate('en', 'error.not_in_guild'));
    return;
  }

  // 4. Permissions (never trust the client — resolved from the guild).
  const permCheck = memberHasPermission(member, guild!, toBit(command.requiredPermission));
  if (!permCheck.ok) {
    ctx.metrics.recordError(command.module, 'PERMISSION_DENIED');
    await say(translate(await localeOf(ctx, guild!.id), 'error.permission_denied'));
    return;
  }
  if (command.requiredRoleId) {
    const roleCheck = memberHasRole(member, command.requiredRoleId);
    if (!roleCheck.ok) {
      ctx.metrics.recordError(command.module, 'PERMISSION_DENIED');
      await say(translate(await localeOf(ctx, guild!.id), 'error.permission_denied'));
      return;
    }
  }

  // 5. Cooldown (per user per guild per command).
  const cooldownSeconds = command.cooldownSeconds ?? 0;
  if (cooldownSeconds > 0 && guild) {
    const n = await ctx.cache.incr(`cd:${guild.id}:${interaction.user.id}:${command.name}`, cooldownSeconds + 1);
    if (n > 1) {
      ctx.metrics.recordError(command.module, 'RATE_LIMITED');
      await say(translate(await localeOf(ctx, guild.id), 'error.rate_limited'));
      return;
    }
  }

  try {
    await command.run(ctx, interaction);
  } catch (err) {
    const error = toSupreError(err);
    const code = error.code;
    ctx.metrics.recordError(command.module, code);
    ctx.logger.error(
      {
        err: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : 'unknown',
          stack: err instanceof Error ? err.stack : undefined
        },
        code,
        command: command.name,
        guild: guild?.id,
        user: interaction.user.id
      },
      'command failed'
    );
    const key =
      code === 'PERMISSION_DENIED'
        ? 'error.permission_denied'
        : code === 'BOT_HIERARCHY'
          ? 'error.bot_hierarchy'
          : code === 'MISSING_CHANNEL'
            ? 'error.missing_channel'
            : code === 'MISSING_ROLE'
              ? 'error.missing_role'
              : code === 'INVALID_INPUT'
                ? 'error.invalid_input'
                : code === 'RATE_LIMITED'
                  ? 'error.rate_limited'
                  : code === 'EXPIRED_INTERACTION'
                    ? 'error.expired_interaction'
                    : code === 'MODULE_DISABLED'
                      ? 'error.module_disabled'
                      : code === 'DB_ERROR'
                        ? 'error.db_error'
                        : code === 'DISCORD_API'
                          ? 'error.discord_api'
                          : code === 'NOT_IN_GUILD'
                            ? 'error.not_in_guild'
                            : 'error.internal';
    await say(translate(await localeOf(ctx, guild?.id ?? 'en'), key));
  }
}

async function handleComponent(deps: InteractionRouterDeps, interaction: ComponentInteraction): Promise<void> {
  const { ctx } = deps;

  // Expired components: ignore silently after logging (user sees no crash).
  if (isExpiredInteraction(interaction)) {
    ctx.logger.debug({ customId: interaction.customId }, 'expired component interaction ignored');
    return;
  }

  const entry = interaction.isButton()
    ? ctx.ui.getButton(interaction.customId)
    : ctx.ui.getSelect(interaction.customId);

  if (!entry) {
    ctx.logger.warn({ customId: interaction.customId }, 'unregistered component interaction');
    return;
  }

  const guild = await guildOf(interaction);
  if (guild && !(await ctx.settings.isEnabled(guild.id, entry.module))) {
    const loc = await localeOf(ctx, guild.id);
    const msg = translate(loc, 'error.module_disabled');
    if (interaction.deferred || interaction.replied) await interaction.update({ content: msg }).catch(() => undefined);
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => undefined);
    return;
  }

  try {
    await entry.handler(ctx, interaction);
  } catch (err) {
    const error = toSupreError(err);
    ctx.metrics.recordError(entry.module, error.code);
    ctx.logger.error(
      {
        err: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : 'unknown', stack: err instanceof Error ? err.stack : undefined },
        customId: interaction.customId
      },
      'component handler failed'
    );
    const loc = guild ? await localeOf(ctx, guild.id) : 'en';
    const msg = error.code === 'PERMISSION_DENIED' ? translate(loc, 'error.permission_denied') : translate(loc, 'error.internal');
    if (interaction.deferred || interaction.replied) await interaction.update({ content: msg }).catch(() => undefined);
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => undefined);
  }
}

/** Interaction components expire after ~3 seconds (Discord redelivers nothing after that). */
function isExpiredInteraction(interaction: Interaction): boolean {
  return Date.now() - interaction.createdTimestamp > 3_000;
}

function toSupreError(err: unknown): { code: string } {
  if (isSupreError(err)) return { code: err.code };
  if (err instanceof Error && err.name === 'DiscordAPIError') return { code: normalizeDiscordError(err).code };
  return { code: 'INTERNAL' };
}

function toBit(name: string | undefined): bigint | undefined {
  if (!name) return undefined;
  const value = (PermissionFlagsBits as Record<string, bigint>)[name];
  if (value === undefined) {
    throw new SupreError('INVALID_INPUT', `unknown permission name in command definition: ${name}`);
  }
  return value;
}

async function localeOf(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    const core = await ctx.settings.get<{ locale?: string }>(guildId, 'core');
    return core.locale ?? 'en';
  } catch {
    return 'en';
  }
}
