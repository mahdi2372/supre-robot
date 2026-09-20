import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { SupreCommand } from '../core/module.js';

export interface ApiCommandBody {
  name: string;
  description: string;
  options?: unknown[];
  [key: string]: unknown;
}

/** Convert a SupreCommand into Discord's REST command body. */
export function toApiCommand(cmd: SupreCommand): ApiCommandBody {
  const builder = new SlashCommandBuilder()
    .setName(cmd.name)
    .setDescription(cmd.description)
    .setDMPermission(cmd.guildOnly === false);
  cmd.configure?.(builder);
  return builder.toJSON() as ApiCommandBody;
}

/**
 * Register (replace) all slash commands. With DISCORD_GUILD_ID set the
 * commands are guild-scoped (instant, for development); otherwise global
 * (may take up to an hour to propagate).
 */
export async function registerCommands(
  config: AppConfig,
  commands: SupreCommand[],
  logger: Logger
): Promise<{ scope: 'guild' | 'global'; count: number }> {
  const body = commands.map(toApiCommand);
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  if (config.DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), { body });
    logger.info({ guildId: config.DISCORD_GUILD_ID, count: body.length }, 'guild commands registered');
    return { scope: 'guild', count: body.length };
  }
  await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body });
  logger.info({ count: body.length }, 'global commands registered (propagation may take a while)');
  return { scope: 'global', count: body.length };
}
