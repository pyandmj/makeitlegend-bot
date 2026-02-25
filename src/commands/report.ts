import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { DEPARTMENTS } from '../config';
import { store } from '../utils/store';
import { createDepartmentReportEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('cmd:report');

export const reportCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Get the latest report from a department')
    .addStringOption(option =>
      option
        .setName('department')
        .setDescription('Department to get report from')
        .setRequired(true)
        .addChoices(
          ...DEPARTMENTS.map(d => ({ name: d.charAt(0).toUpperCase() + d.slice(1), value: d }))
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const department = interaction.options.getString('department', true);

    try {
      const deptStatus = store.getDepartmentStatus(department);
      if (!deptStatus) {
        await interaction.editReply({
          content: `❌ Department not found: **${department}**`,
        });
        return;
      }

      const tasks = store.getTasksByDepartment(department);
      const embed = createDepartmentReportEmbed(deptStatus, tasks);

      await interaction.editReply({ embeds: [embed] });

      logger.info(`Report for ${department} requested by ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Failed to generate report for ${department}`, { error });
      await interaction.editReply({
        content: '❌ Failed to generate department report. Check logs for details.',
      });
    }
  },
};
