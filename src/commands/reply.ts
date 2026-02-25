import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { SlashCommand } from '../types';
import { BRAND_COLORS } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getManusClient } from '../services/service-registry';

const logger = createModuleLogger('cmd:reply');

/**
 * /reply <task_id> <message>
 *
 * Continues a Manus task that paused with stop_reason: "ask".
 * Sends the user's reply back to Manus as a follow-up message on the same task.
 */
export const replyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('reply')
    .setDescription('Reply to a Manus task that is waiting for your input')
    .addStringOption(option =>
      option
        .setName('task_id')
        .setDescription('The Manus task ID (shown in the question embed)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription('Your reply to Manus')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = interaction.options.getString('task_id', true).trim();
    const message = interaction.options.getString('message', true);

    await interaction.deferReply();

    const manusClient = getManusClient();
    if (!manusClient) {
      await interaction.editReply({ content: '❌ Manus client is not configured.' });
      return;
    }

    try {
      const response = await manusClient.continueTask(taskId, message);

      if (!response) {
        await interaction.editReply({
          content: `❌ Failed to send reply to task \`${taskId}\`. The task may have already completed or the ID is incorrect.`,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(BRAND_COLORS.success)
        .setTitle('↩️ Reply Sent to Manus')
        .setDescription(`Your message has been delivered. Manus will continue working and post results when done.`)
        .addFields(
          { name: 'Task ID', value: `\`${taskId}\``, inline: true },
          { name: 'Your Reply', value: message.slice(0, 500), inline: false },
        )
        .addFields({
          name: '🔗 View Task',
          value: `[Watch in Manus](${response.task_url})`,
        })
        .setFooter({ text: `Replied by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      logger.info(`Reply sent to Manus task ${taskId} by ${interaction.user.tag}`);
    } catch (error: any) {
      logger.error(`Failed to reply to task ${taskId}`, { error });
      await interaction.editReply({
        content: `❌ Error sending reply: \`${error.message}\``,
      });
    }
  },
};
