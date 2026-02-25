import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { store } from '../utils/store';
import { createBriefingEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('cmd:briefing');

export const briefingCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('briefing')
    .setDescription('Get the current status briefing of all departments'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    try {
      const briefingData = store.generateBriefingData();
      const embeds = createBriefingEmbed(briefingData);

      // Discord allows max 10 embeds per message
      if (embeds.length <= 10) {
        await interaction.editReply({ embeds });
      } else {
        await interaction.editReply({ embeds: embeds.slice(0, 10) });
        // Send remaining embeds as follow-up
        await interaction.followUp({ embeds: embeds.slice(10), ephemeral: false });
      }

      logger.info(`Briefing requested by ${interaction.user.tag}`);
    } catch (error) {
      logger.error('Failed to generate briefing', { error });
      await interaction.editReply({
        content: '❌ Failed to generate briefing. Check logs for details.',
      });
    }
  },
};
