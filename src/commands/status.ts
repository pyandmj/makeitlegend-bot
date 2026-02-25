import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { store } from '../utils/store';
import { createSystemHealthEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('cmd:status');

export const statusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show system health overview for all departments'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    try {
      const health = store.getSystemHealth();
      const embed = createSystemHealthEmbed(health);
      await interaction.editReply({ embeds: [embed] });

      logger.info(`Status requested by ${interaction.user.tag}`);
    } catch (error) {
      logger.error('Failed to generate status', { error });
      await interaction.editReply({
        content: '❌ Failed to generate system status. Check logs for details.',
      });
    }
  },
};
