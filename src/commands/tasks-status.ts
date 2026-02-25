import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { SlashCommand } from '../types';
import { BRAND_COLORS } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getManusClient } from '../services/service-registry';

const logger = createModuleLogger('cmd:tasks-status');

const STATUS_EMOJI: Record<string, string> = {
  pending: '🕐',
  running: '🟡',
  completed: '✅',
  failed: '❌',
};

/**
 * /tasks-status [task_id]
 *
 * Lists all active Manus tasks tracked by this bot session,
 * or shows the full detail for a specific task.
 */
export const tasksStatusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('tasks-status')
    .setDescription('Check the status of active Manus tasks')
    .addStringOption(option =>
      option
        .setName('task_id')
        .setDescription('Specific Manus task ID to inspect (optional)')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = interaction.options.getString('task_id');

    await interaction.deferReply({ ephemeral: true });

    const manusClient = getManusClient();
    if (!manusClient) {
      await interaction.editReply({ content: '❌ Manus client is not configured.' });
      return;
    }

    try {
      if (taskId) {
        // ─── Single task detail ───
        const task = await manusClient.getTask(taskId);
        if (!task) {
          await interaction.editReply({ content: `❌ Task \`${taskId}\` not found.` });
          return;
        }

        const { text, files } = manusClient.extractTaskOutput(task);
        const emoji = STATUS_EMOJI[task.status] || '❓';

        const embed = new EmbedBuilder()
          .setColor(task.status === 'completed' ? BRAND_COLORS.success :
                    task.status === 'failed' ? BRAND_COLORS.danger : BRAND_COLORS.warning)
          .setTitle(`${emoji} Task: ${task.metadata.task_title}`)
          .addFields(
            { name: 'Status', value: `${emoji} ${task.status}`, inline: true },
            { name: 'Model', value: task.model, inline: true },
            { name: 'Credits Used', value: String(task.credit_usage ?? 0), inline: true },
            { name: 'Created', value: `<t:${task.created_at}:R>`, inline: true },
            { name: 'Updated', value: `<t:${task.updated_at}:R>`, inline: true },
          );

        if (text) {
          embed.addFields({
            name: 'Latest Output',
            value: text.slice(0, 1000) + (text.length > 1000 ? '…' : ''),
          });
        }

        if (files.length > 0) {
          embed.addFields({
            name: `📎 Files (${files.length})`,
            value: files.map(f => `• [${f.fileName}](${f.fileUrl})`).join('\n').slice(0, 500),
          });
        }

        if (task.error) {
          embed.addFields({ name: '❌ Error', value: task.error.slice(0, 500) });
        }

        embed.addFields({ name: '🔗 View', value: `[Open in Manus](${task.metadata.task_url})` });
        embed.setTimestamp();

        await interaction.editReply({ embeds: [embed] });

      } else {
        // ─── All active tasks tracked in this session ───
        const activeContexts = manusClient.getActiveTaskContexts();

        if (activeContexts.length === 0) {
          // Fall back to listing recent tasks from the API
          const list = await manusClient.listTasks({ limit: 5 });
          if (!list || list.data.length === 0) {
            await interaction.editReply({ content: 'No active tasks found.' });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(BRAND_COLORS.info ?? 0x3498db)
            .setTitle('📋 Recent Manus Tasks')
            .setDescription('Last 5 tasks from the Manus API:');

          for (const task of list.data) {
            const emoji = STATUS_EMOJI[task.status] || '❓';
            embed.addFields({
              name: `${emoji} ${task.metadata.task_title.slice(0, 80)}`,
              value: `ID: \`${task.id}\` | Status: ${task.status} | Credits: ${task.credit_usage ?? 0}\n[View](${task.metadata.task_url})`,
            });
          }

          embed.setTimestamp();
          await interaction.editReply({ embeds: [embed] });

        } else {
          // Show tasks tracked in this bot session
          const embed = new EmbedBuilder()
            .setColor(BRAND_COLORS.info ?? 0x3498db)
            .setTitle(`📋 Active Tasks (${activeContexts.length})`)
            .setDescription('Tasks dispatched this session that are still running:');

          for (const ctx of activeContexts.slice(0, 10)) {
            const age = Math.floor((Date.now() - ctx.createdAt) / 60000);
            embed.addFields({
              name: `🟡 ${ctx.department.toUpperCase()} | ${ctx.priority.toUpperCase()}`,
              value: [
                `ID: \`${ctx.manusTaskId}\``,
                `Task: ${ctx.promptSummary.slice(0, 100)}`,
                `By: ${ctx.userTag} | ${age}m ago`,
              ].join('\n'),
            });
          }

          embed.setFooter({ text: 'Use /tasks-status <task_id> for full detail' }).setTimestamp();
          await interaction.editReply({ embeds: [embed] });
        }
      }
    } catch (error: any) {
      logger.error('tasks-status error', { error });
      await interaction.editReply({ content: `❌ Error: \`${error.message}\`` });
    }
  },
};
