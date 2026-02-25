import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { SlashCommand } from '../types';
import { store } from '../utils/store';
import { createApprovalResultEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('cmd:deny');

export const denyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Deny a pending request')
    .addStringOption(option =>
      option
        .setName('id')
        .setDescription('The approval request ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('Reason for denial')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString('id', true);
    const reason = interaction.options.getString('reason') || undefined;

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
      status: 'denied',
      resolvedAt: new Date(),
      resolvedBy: interaction.user.tag,
      denyReason: reason,
    });

    const embed = createApprovalResultEmbed(store.getApproval(id)!);
    await interaction.reply({ embeds: [embed] });

    logger.info(`Approval ${id} denied by ${interaction.user.tag}${reason ? ` — Reason: ${reason}` : ''}`);

    // If there's a callback URL, notify the requesting system
    if (approval.callbackUrl) {
      try {
        await fetch(approval.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approvalId: id,
            status: 'denied',
            reason,
            resolvedBy: interaction.user.tag,
            resolvedAt: new Date().toISOString(),
          }),
        });
        logger.info(`Callback sent for denial ${id}`);
      } catch (error) {
        logger.error(`Failed to send callback for denial ${id}`, { error });
      }
    }
  },
};
