import { Interaction } from 'discord.js';
import { commands } from '../commands';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('event:interaction');

/**
 * Handles all interaction events (slash commands, buttons, etc.)
 */
export async function handleInteractionCreate(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    logger.info(`Command received: /${interaction.commandName} by ${interaction.user.tag}`);
    await command.execute(interaction);
    logger.info(`Command completed: /${interaction.commandName} by ${interaction.user.tag}`);
  } catch (error: any) {
    logger.error(`Command error: /${interaction.commandName}`, { error: error?.message || error });

    try {
      const reply = {
        content: '❌ An error occurred while executing this command.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (replyError: any) {
      // Interaction already expired — can't respond
      logger.warn(`Could not send error reply for /${interaction.commandName}: ${replyError?.message}`);
    }
  }
}
