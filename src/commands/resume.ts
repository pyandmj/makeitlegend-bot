import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { SlashCommand } from '../types';
import { DEPARTMENTS } from '../config';
import { store } from '../utils/store';
import { BRAND_COLORS } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter } from '../services/service-registry';

const logger = createModuleLogger('cmd:resume');

export const resumeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume agent activity in a department')
    .addStringOption(option =>
      option
        .setName('department')
        .setDescription('Department to resume')
        .setRequired(true)
        .addChoices(
          ...DEPARTMENTS.map(d => ({ name: d.charAt(0).toUpperCase() + d.slice(1), value: d }))
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const department = interaction.options.getString('department', true);

    if (!store.isDepartmentPaused(department)) {
      await interaction.reply({
        content: `ℹ️ The **${department}** department is not paused.`,
        ephemeral: true,
      });
      return;
    }

    store.resumeDepartment(department);

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLORS.success)
      .setTitle(`▶️ Department Resumed: ${department.charAt(0).toUpperCase() + department.slice(1)}`)
      .setDescription(`Agent activity in the **${department}** department has been resumed by ${interaction.user.tag}.`)
      .addFields(
        { name: 'Resumed By', value: interaction.user.tag, inline: true },
        { name: 'Status', value: 'Active', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Make It Legend — AI Pet Portraits' });

    await interaction.reply({ embeds: [embed] });

    // Notify the department channel
    const router = getChannelRouter();
    if (router) {
      await router.routeDepartmentUpdate(department, embed);
    }

    logger.info(`Department ${department} resumed by ${interaction.user.tag}`);
  },
};
