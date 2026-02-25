import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { createModuleLogger } from '../utils/logger';
import { getCreditReporter } from '../services/service-registry';

const logger = createModuleLogger('cmd:credits');

export const creditsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('credits')
    .setDescription('View credit usage and efficiency reports')
    .addSubcommand(sub =>
      sub
        .setName('daily')
        .setDescription('Today\'s credit usage breakdown')
    )
    .addSubcommand(sub =>
      sub
        .setName('weekly')
        .setDescription('This week\'s credit usage and efficiency report')
    )
    .addSubcommand(sub =>
      sub
        .setName('agent')
        .setDescription('View a specific agent\'s usage history')
        .addStringOption(opt =>
          opt
            .setName('name')
            .setDescription('Agent name (e.g., manus-agent)')
            .setRequired(true)
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const reporter = getCreditReporter();

    if (!reporter) {
      await interaction.reply({
        content: '⚠️ Credit monitoring system is not yet initialized. Please try again in a moment.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      let embeds;

      switch (subcommand) {
        case 'daily':
          embeds = reporter.buildOnDemandDaily();
          break;

        case 'weekly':
          embeds = reporter.buildOnDemandWeekly();
          break;

        case 'agent': {
          const agentName = interaction.options.getString('name', true);
          embeds = reporter.buildAgentReport(agentName);
          break;
        }

        default:
          await interaction.editReply('Unknown subcommand.');
          return;
      }

      if (embeds.length === 0) {
        await interaction.editReply('No credit data available yet. Data will appear once tasks are created via the `/task` command or Manus API.');
        return;
      }

      // Discord allows max 10 embeds per message
      await interaction.editReply({ embeds: embeds.slice(0, 10) });

      logger.info(`Credits report generated: ${subcommand} by ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Error generating credits report: ${subcommand}`, { error });
      await interaction.editReply('❌ Failed to generate credit report. Check logs for details.');
    }
  },
};
