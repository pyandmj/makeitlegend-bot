import { REST, Routes } from 'discord.js';
import { config } from './config';
import { getCommandData } from './commands';
import { logger } from './utils/logger';

/**
 * Deploys slash commands to Discord.
 * Can be run standalone or called from the main bot.
 */
export async function deployCommands(guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const commandData = getCommandData();
  const targetGuildId = guildId || config.discord.guildId;

  try {
    logger.info(`Deploying ${commandData.length} slash commands...`);

    if (targetGuildId && !targetGuildId.startsWith('PLACEHOLDER')) {
      // Guild-specific commands (instant, good for development)
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, targetGuildId),
        { body: commandData }
      );
      logger.info(`Successfully deployed ${commandData.length} guild commands to ${targetGuildId}`);
    } else {
      // Global commands (can take up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commandData }
      );
      logger.info(`Successfully deployed ${commandData.length} global commands`);
    }
  } catch (error) {
    logger.error('Failed to deploy commands', { error });
    throw error;
  }
}

// Run standalone if executed directly
if (require.main === module) {
  deployCommands()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
