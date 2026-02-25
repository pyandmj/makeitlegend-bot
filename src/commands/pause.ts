import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { SlashCommand } from '../types';
import { DEPARTMENTS } from '../config';
import { store } from '../utils/store';
import { BRAND_COLORS } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter } from '../services/service-registry';

const logger = createModuleLogger('cmd:pause');

export const pauseCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause all agent activity in a department')
    .addStringOption(option =>
      option
        .setName('department')
        .setDescription('Department to pause')
        .setRequired(true)
        .addChoices(
          ...DEPARTMENTS.map(d => ({ name: d.charAt(0).toUpperCase() + d.slice(1), value: d }))
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const department = interaction.options.getString('department', true);

    if (store.isDepartmentPaused(department)) {
      await interaction.reply({
        content: `⚠️ The **${department}** department is already paused.`,
        ephemeral: true,
      });
      return;
    }

    store.pauseDepartment(department);

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLORS.warning)
      .setTitle(`⏸️ Department Paused: ${department.charAt(0).toUpperCase() + department.slice(1)}`)
      .setDescription(`All agent activity in the **${department}** department has been paused by ${interaction.user.tag}.`)
      .addFields(
        { name: 'Paused By', value: interaction.user.tag, inline: true },
        { name: 'Resume With', value: `\`/resume ${department}\``, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Make It Legend — AI Pet Portraits' });

    await interaction.reply({ embeds: [embed] });

    // Notify the department channel
    const router = getChannelRouter();
    if (router) {
      await router.routeDepartmentUpdate(department, embed);
    }

    logger.info(`Department ${department} paused by ${interaction.user.tag}`);
  },
};
