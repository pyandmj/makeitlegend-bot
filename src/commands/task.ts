import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { SlashCommand } from '../types';
import { DEPARTMENTS } from '../config';
import { store } from '../utils/store';
import { createTaskEmbed, BRAND_COLORS } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getManusClient } from '../services/service-registry';

const logger = createModuleLogger('cmd:task');

// ─── Agent profile selection by priority ───
const AGENT_PROFILE_MAP: Record<string, 'manus-1.6-lite' | 'manus-1.6' | 'manus-1.6-max'> = {
  low: 'manus-1.6-lite',
  medium: 'manus-1.6',
  high: 'manus-1.6',
  critical: 'manus-1.6-max',
};

// ─── Estimated credits by priority ───
const CREDIT_ESTIMATE_MAP: Record<string, number> = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
  critical: 3.0,
};

export const taskCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('task')
    .setDescription('Dispatch a task to Manus AI — results post back to Discord automatically')
    .addStringOption(option =>
      option
        .setName('department')
        .setDescription('Target department')
        .setRequired(true)
        .addChoices(
          ...DEPARTMENTS.map(d => ({ name: d.charAt(0).toUpperCase() + d.slice(1), value: d }))
        )
    )
    .addStringOption(option =>
      option
        .setName('description')
        .setDescription('What do you need Manus to do?')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('priority')
        .setDescription('Task priority (affects agent model used)')
        .setRequired(false)
        .addChoices(
          { name: 'Low — manus-1.6-lite (fastest, cheapest)', value: 'low' },
          { name: 'Medium — manus-1.6 (default)', value: 'medium' },
          { name: 'High — manus-1.6 (full power)', value: 'high' },
          { name: 'Critical — manus-1.6-max (maximum capability)', value: 'critical' },
        )
    )
    .addStringOption(option =>
      option
        .setName('agent')
        .setDescription('Agent label (for tracking only, default: manus-agent)')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const department = interaction.options.getString('department', true);
    const description = interaction.options.getString('description', true);
    const priority = (interaction.options.getString('priority') || 'medium') as
      'low' | 'medium' | 'high' | 'critical';
    const agent = interaction.options.getString('agent') || 'manus-agent';

    // ─── Check if department is paused ───
    if (store.isDepartmentPaused(department)) {
      await interaction.reply({
        content: `⚠️ The **${department}** department is currently paused. Resume it first with \`/resume ${department}\`.`,
        ephemeral: true,
      });
      return;
    }

    try {
      await interaction.deferReply();
    } catch (deferError: any) {
      logger.error('Failed to defer reply — interaction may have expired', { error: deferError?.message });
      return;
    }

    // ─── Create internal task record ───
    const task = store.createTask(department, description, priority);

    // ─── Try to dispatch to Manus API ───
    const manusClient = getManusClient();

    if (!manusClient) {
      // No Manus client configured — local task only
      const taskEmbed = createTaskEmbed(task);
      await interaction.editReply({ embeds: [taskEmbed] });

      const router = getChannelRouter();
      if (router) await router.routeDepartmentUpdate(department, taskEmbed);

      logger.warn('Manus client not configured — task created locally only');
      return;
    }

    try {
      const result = await manusClient.createTask({
        department,
        agent,
        operation: `task:${department}:${priority}`,
        request: {
          prompt: description,
          agentProfile: AGENT_PROFILE_MAP[priority],
          hideInTaskList: false,
        },
        estimatedCredits: CREDIT_ESTIMATE_MAP[priority],
        // Pass Discord context so the webhook handler can route results back
        discordContext: {
          channelId: interaction.channelId,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          priority,
        },
      });

      if (result.success && result.taskResponse) {
        // ─── SUCCESS: Task dispatched to Manus ───
        store.updateTask(task.id, {
          status: 'in_progress',
          assignedTo: agent,
        });

        const successEmbed = new EmbedBuilder()
          .setColor(BRAND_COLORS.success)
          .setTitle('📌 Task Dispatched to Manus')
          .setDescription(`> ${description.slice(0, 300)}`)
          .addFields(
            { name: 'Internal ID', value: `\`${task.id}\``, inline: true },
            { name: 'Manus Task', value: `\`${result.taskResponse.task_id}\``, inline: true },
            { name: 'Department', value: department.charAt(0).toUpperCase() + department.slice(1), inline: true },
            { name: 'Priority', value: priority.toUpperCase(), inline: true },
            { name: 'Model', value: AGENT_PROFILE_MAP[priority], inline: true },
            { name: 'Status', value: '🟡 Running…', inline: true },
          )
          .addFields({
            name: '🔗 Live View',
            value: `[Watch in Manus](${result.taskResponse.task_url})`,
          })
          .setFooter({ text: '✅ Results will post here automatically when complete' })
          .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });

        // Also post to the department channel so the team sees it
        const router = getChannelRouter();
        if (router && interaction.channelId !== (await getChannelIdForDepartment(department))) {
          await router.routeDepartmentUpdate(department, successEmbed);
        }

        logger.info(
          `Task dispatched: ${result.taskResponse.task_id} | ${department} | ${priority} | ${interaction.user.tag}`,
        );

        // ─── Start polling fallback (in case webhooks don't fire) ───
        const manusTaskId = result.taskResponse.task_id;
        startPollingFallback(manusTaskId, department, interaction.channelId);

      } else if (result.failFast?.blocked) {
        // ─── FAIL-FAST: Task blocked ───
        const blockedEmbed = new EmbedBuilder()
          .setColor(BRAND_COLORS.danger)
          .setTitle('🚫 Task Blocked by Fail-Fast')
          .setDescription(
            `This task was **not sent** to Manus because a known issue was detected.\n\n` +
            `**Reason:** ${result.failFast.reason}\n\n` +
            `**Credits Saved:** ${result.failFast.creditsSaved?.toFixed(1) || '1.0'}`,
          )
          .addFields(
            { name: 'Internal ID', value: `\`${task.id}\``, inline: true },
            { name: 'Department', value: department, inline: true },
            { name: 'Priority', value: priority.toUpperCase(), inline: true },
          )
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
          .setTimestamp();

        store.updateTask(task.id, { status: 'failed', result: `Blocked: ${result.failFast.reason}` });
        await interaction.editReply({ embeds: [blockedEmbed] });

      } else {
        // ─── API ERROR: Task failed to dispatch ───
        const failEmbed = new EmbedBuilder()
          .setColor(BRAND_COLORS.warning)
          .setTitle('⚠️ Task Created Locally (Manus API Error)')
          .setDescription(
            `Task was saved locally but the Manus API call failed.\n\n` +
            `**Error:** \`${result.error}\`\n\n` +
            `Use \`/retry ${task.id}\` to try again, or check \`/status\` for system health.`,
          )
          .addFields(
            { name: 'Internal ID', value: `\`${task.id}\``, inline: true },
            { name: 'Department', value: department, inline: true },
            { name: 'Priority', value: priority.toUpperCase(), inline: true },
          )
          .setFooter({ text: '🐾 Make It Legend' })
          .setTimestamp();

        await interaction.editReply({ embeds: [failEmbed] });
      }

    } catch (error: any) {
      logger.error('Unexpected error in /task command', { error });
      await interaction.editReply({
        content: `⚠️ Unexpected error: \`${error.message}\`. Task saved locally as \`${task.id}\`.`,
      });
    }

    logger.info(`/task executed by ${interaction.user.tag}: ${task.id} — ${department} — ${description}`);
  },
};

// ─── Helper: get channel ID for department (for dedup routing) ───
async function getChannelIdForDepartment(_department: string): Promise<string | null> {
  // This avoids double-posting when the command is run from the department channel itself.
  // Returns null if we can't determine — routing will proceed normally.
  return null;
}

// ─── Polling fallback: check task status and post result to Discord ───
function startPollingFallback(manusTaskId: string, department: string, channelId: string): void {
  const manusClient = getManusClient();
  const router = getChannelRouter();
  if (!manusClient || !router) return;

  logger.info(`Starting polling fallback for task ${manusTaskId}`);

  // Poll in background — don't await
  manusClient.pollTaskUntilDone(manusTaskId, {
    intervalMs: 5_000,
    timeoutMs: 600_000, // 10 minutes
  }).then(async (taskDetail) => {
    if (!taskDetail) {
      logger.warn(`Polling timeout for task ${manusTaskId}`);
      return;
    }

    logger.info(`Polling got result for ${manusTaskId}: status=${taskDetail.status}`);

    // Extract text output from the task
    const extracted = manusClient.extractTaskOutput(taskDetail);
    const outputText = extracted.text || (taskDetail.status === 'completed'
      ? 'Task completed but no text output was returned.'
      : taskDetail.error || 'Task failed without details.');

    // Build result embed
    const resultEmbed = new EmbedBuilder()
      .setColor(taskDetail.status === 'completed' ? BRAND_COLORS.success : BRAND_COLORS.danger)
      .setTitle(taskDetail.status === 'completed' ? '✅ Task Completed' : '❌ Task Failed')
      .setDescription(outputText.slice(0, 4000))
      .addFields(
        { name: 'Manus Task', value: `\`${manusTaskId}\``, inline: true },
        { name: 'Department', value: department.charAt(0).toUpperCase() + department.slice(1), inline: true },
        { name: 'Status', value: taskDetail.status, inline: true },
      )
      .setFooter({ text: '🐾 Make It Legend — Result via polling' })
      .setTimestamp();

    // If there are file attachments, add them
    if (extracted.files.length > 0) {
      const fileList = extracted.files.map(f => `[📄 ${f.fileName}](${f.fileUrl})`).join('\n');
      resultEmbed.addFields({ name: 'Attachments', value: fileList.slice(0, 1024) });
    }

    // Post to the department channel
    await router.routeDepartmentUpdate(department, resultEmbed);

    logger.info(`Posted polling result for ${manusTaskId} to ${department}`);
  }).catch(err => {
    logger.error(`Polling error for ${manusTaskId}: ${err.message}`);
  });
}
