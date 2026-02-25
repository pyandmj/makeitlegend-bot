import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { store } from '../utils/store';
import { createApprovalResultEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('cmd:approve');

export const approveCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a pending request')
    .addStringOption(option =>
      option
        .setName('id')
        .setDescription('The approval request ID')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString('id', true);

    const approval = store.getApproval(id);
    if (!approval) {
      await interaction.reply({
        content: `❌ No approval request found with ID: \`${id}\``,
        ephemeral: true,
      });
      return;
    }

    if (approval.status !== 'pending') {
      await interaction.reply({
        content: `⚠️ This request has already been **${approval.status}**.`,
        ephemeral: true,
      });
      return;
    }

    store.updateApproval(id, {
      status: 'approved',
      resolvedAt: new Date(),
      resolvedBy: interaction.user.tag,
    });

    const embed = createApprovalResultEmbed(store.getApproval(id)!);
    await interaction.reply({ embeds: [embed] });

    logger.info(`Approval ${id} approved by ${interaction.user.tag}`);

    // If there's a callback URL, notify the requesting system
    if (approval.callbackUrl) {
      try {
        await fetch(approval.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approvalId: id,
            status: 'approved',
            resolvedBy: interaction.user.tag,
            resolvedAt: new Date().toISOString(),
          }),
        });
        logger.info(`Callback sent for approval ${id}`);
      } catch (error) {
        logger.error(`Failed to send callback for approval ${id}`, { error });
      }
    }
  },
};
