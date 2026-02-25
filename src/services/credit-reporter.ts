import { EmbedBuilder } from 'discord.js';
import { CreditDatabase, DailySpendRecord, AgentEfficiency } from './credit-database';
import { getChannelRouter } from './service-registry';
import { createModuleLogger } from '../utils/logger';
import { BRAND_COLORS } from '../utils/embeds';

const logger = createModuleLogger('credit-reporter');

/**
 * Generates and posts credit usage reports to Discord.
 * Handles daily summaries, weekly efficiency reports, and on-demand queries.
 */
export class CreditReporter {
  private creditDb: CreditDatabase;
  private dailyReportTimer: NodeJS.Timeout | null = null;
  private weeklyReportTimer: NodeJS.Timeout | null = null;

  constructor(creditDb: CreditDatabase) {
    this.creditDb = creditDb;
  }

  /**
   * Starts the scheduled reporting (daily at 8:05 AM, weekly on Mondays at 8:15 AM).
   */
  start(): void {
    // Daily report — runs every 24 hours (scheduled alongside the briefing)
    const now = new Date();
    const nextDaily = new Date(now);
    nextDaily.setHours(8, 5, 0, 0);
    if (nextDaily <= now) nextDaily.setDate(nextDaily.getDate() + 1);
    const dailyDelay = nextDaily.getTime() - now.getTime();

    setTimeout(() => {
      this.postDailyReport().catch(err => logger.error('Daily credit report failed', { error: err }));
      this.dailyReportTimer = setInterval(() => {
        this.postDailyReport().catch(err => logger.error('Daily credit report failed', { error: err }));
      }, 24 * 60 * 60 * 1000);
    }, dailyDelay);

    // Weekly report — runs every Monday
    const nextMonday = new Date(now);
    nextMonday.setHours(8, 15, 0, 0);
    const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7;
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    const weeklyDelay = nextMonday.getTime() - now.getTime();

    setTimeout(() => {
      this.postWeeklyReport().catch(err => logger.error('Weekly credit report failed', { error: err }));
      this.weeklyReportTimer = setInterval(() => {
        this.postWeeklyReport().catch(err => logger.error('Weekly credit report failed', { error: err }));
      }, 7 * 24 * 60 * 60 * 1000);
    }, weeklyDelay);

    logger.info('Credit reporter scheduled (daily at 8:05 AM, weekly on Mondays at 8:15 AM)');
  }

  stop(): void {
    if (this.dailyReportTimer) clearInterval(this.dailyReportTimer);
    if (this.weeklyReportTimer) clearInterval(this.weeklyReportTimer);
    logger.info('Credit reporter stopped');
  }

  // ─────────────────────────────────────────────────────
  // Daily Report
  // ─────────────────────────────────────────────────────

  /**
   * Posts the daily credit usage summary to #analytics-credits.
   */
  async postDailyReport(): Promise<void> {
    const router = getChannelRouter();
    if (!router) return;

    const embeds = this.buildDailyReportEmbeds();
    for (const embed of embeds) {
      await router.sendEmbed('analytics-credits' as any, embed);
    }
    logger.info('Daily credit report posted');
  }

  /**
   * Builds the daily report embeds (used by both scheduled and on-demand).
   */
  buildDailyReportEmbeds(): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    const summary = this.creditDb.getCreditBriefingSummary();
    const dailySpend = this.creditDb.getDailySpend();
    const wasteRecords = this.creditDb.getWasteRecords(1);

    // Header
    const efficiencyEmoji = summary.todaySuccessRate >= 80 ? '🟢' :
      summary.todaySuccessRate >= 50 ? '🟡' : '🔴';

    embeds.push(
      new EmbedBuilder()
        .setColor(BRAND_COLORS.gold)
        .setTitle(`📊 Daily Credit Report — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`)
        .setDescription(
          `${efficiencyEmoji} **Overall Efficiency:** ${summary.todaySuccessRate}%\n` +
          `💰 **Total Credits Used:** ${summary.todayTotal.toFixed(1)}\n` +
          `🗑️ **Credits Wasted:** ${summary.todayWaste.toFixed(1)}\n` +
          `🛡️ **Credits Saved (Fail-Fast):** ${summary.todaySaved.toFixed(1)}\n` +
          `📋 **Total Tasks:** ${summary.todayTasks}`
        )
        .setTimestamp()
        .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
    );

    // Department breakdown
    if (dailySpend.length > 0) {
      const deptLines = dailySpend.map(d => {
        const efficiency = d.task_count > 0
          ? ((d.success_count / d.task_count) * 100).toFixed(0)
          : '0';
        const wasteFlag = d.wasted_credits > 0 ? ' ⚠️' : '';
        return `**${d.department}** — ${d.total_credits.toFixed(1)} credits | ${d.task_count} tasks | ${efficiency}% success${wasteFlag}`;
      }).join('\n');

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.info)
          .setTitle('🏢 Department Breakdown')
          .setDescription(deptLines || 'No department activity today.')
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    // Waste summary
    if (wasteRecords.length > 0) {
      const wasteLines = wasteRecords.slice(0, 10).map(r =>
        `• \`${r.task_id}\` [${r.agent}] ${r.operation} — ${r.waste_reason || 'Flagged as waste'}`
      ).join('\n');

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.danger)
          .setTitle(`🗑️ Waste Flags (${wasteRecords.length} today)`)
          .setDescription(wasteLines)
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    return embeds;
  }

  // ─────────────────────────────────────────────────────
  // Weekly Report
  // ─────────────────────────────────────────────────────

  /**
   * Posts the weekly efficiency report to #analytics-credits.
   */
  async postWeeklyReport(): Promise<void> {
    const router = getChannelRouter();
    if (!router) return;

    const embeds = this.buildWeeklyReportEmbeds();
    for (const embed of embeds) {
      await router.sendEmbed('analytics-credits' as any, embed);
    }
    logger.info('Weekly credit report posted');
  }

  /**
   * Builds the weekly report embeds.
   */
  buildWeeklyReportEmbeds(): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    const weeklySpend = this.creditDb.getWeeklySpend();
    const agentEfficiency = this.creditDb.getAgentEfficiency(undefined, 7);
    const totalSaved = this.creditDb.getTotalCreditsSaved(7);
    const summary = this.creditDb.getCreditBriefingSummary();

    // Weekly header
    const totalCredits = weeklySpend.reduce((sum, d) => sum + d.total_credits, 0);
    const totalWaste = weeklySpend.reduce((sum, d) => sum + d.wasted_credits, 0);
    const totalTasks = weeklySpend.reduce((sum, d) => sum + d.task_count, 0);
    const totalSuccess = weeklySpend.reduce((sum, d) => sum + d.success_count, 0);
    const overallEfficiency = totalTasks > 0 ? ((totalSuccess / totalTasks) * 100).toFixed(1) : '0';

    embeds.push(
      new EmbedBuilder()
        .setColor(BRAND_COLORS.gold)
        .setTitle(`📊 Weekly Credit Efficiency Report`)
        .setDescription(
          `**Week ending ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}**\n\n` +
          `💰 **Total Credits:** ${totalCredits.toFixed(1)}\n` +
          `📋 **Total Tasks:** ${totalTasks}\n` +
          `✅ **Success Rate:** ${overallEfficiency}%\n` +
          `🗑️ **Credits Wasted:** ${totalWaste.toFixed(1)}\n` +
          `🛡️ **Credits Saved (Fail-Fast):** ${totalSaved.toFixed(1)}`
        )
        .setTimestamp()
        .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
    );

    // Department comparison table
    if (weeklySpend.length > 0) {
      const deptLines = weeklySpend.map(d => {
        const eff = d.task_count > 0 ? ((d.success_count / d.task_count) * 100).toFixed(0) : '0';
        const bar = this.progressBar(parseInt(eff));
        return `**${d.department}**\n${bar} ${eff}% | ${d.total_credits.toFixed(1)} credits | ${d.task_count} tasks`;
      }).join('\n\n');

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.info)
          .setTitle('🏢 Department Comparison')
          .setDescription(deptLines)
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    // Agent leaderboard
    if (agentEfficiency.length > 0) {
      const topEfficient = agentEfficiency
        .sort((a, b) => b.efficiency_score - a.efficiency_score)
        .slice(0, 5);

      const topWasters = agentEfficiency
        .sort((a, b) => b.waste_flags - a.waste_flags)
        .filter(a => a.waste_flags > 0)
        .slice(0, 5);

      let leaderboard = '**🏆 Most Efficient Agents:**\n';
      leaderboard += topEfficient.map((a, i) =>
        `${i + 1}. **${a.agent}** (${a.department}) — ${a.efficiency_score.toFixed(1)}% efficiency | ${a.total_credits.toFixed(1)} credits`
      ).join('\n');

      if (topWasters.length > 0) {
        leaderboard += '\n\n**⚠️ Top Wasters:**\n';
        leaderboard += topWasters.map((a, i) =>
          `${i + 1}. **${a.agent}** (${a.department}) — ${a.waste_flags} waste flags | ${a.total_credits.toFixed(1)} credits`
        ).join('\n');
      }

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.primary)
          .setTitle('🤖 Agent Leaderboard')
          .setDescription(leaderboard)
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    return embeds;
  }

  // ─────────────────────────────────────────────────────
  // On-Demand Reports (for /credits command)
  // ─────────────────────────────────────────────────────

  /**
   * Builds an on-demand daily summary embed.
   */
  buildOnDemandDaily(): EmbedBuilder[] {
    return this.buildDailyReportEmbeds();
  }

  /**
   * Builds an on-demand weekly summary embed.
   */
  buildOnDemandWeekly(): EmbedBuilder[] {
    return this.buildWeeklyReportEmbeds();
  }

  /**
   * Builds an agent-specific usage report.
   */
  buildAgentReport(agentName: string): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    const efficiency = this.creditDb.getAgentEfficiency(agentName, 30);

    if (efficiency.length === 0) {
      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.neutral)
          .setTitle(`🤖 Agent Report: ${agentName}`)
          .setDescription('No credit usage data found for this agent in the last 30 days.')
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
      return embeds;
    }

    const totalCredits = efficiency.reduce((sum, e) => sum + e.total_credits, 0);
    const totalTasks = efficiency.reduce((sum, e) => sum + e.total_tasks, 0);
    const totalSuccess = efficiency.reduce((sum, e) => sum + e.successful_outcomes, 0);
    const totalFailed = efficiency.reduce((sum, e) => sum + e.failed_tasks, 0);
    const totalWaste = efficiency.reduce((sum, e) => sum + e.waste_flags, 0);
    const totalSaved = efficiency.reduce((sum, e) => sum + e.credits_saved, 0);
    const overallEfficiency = totalTasks > 0 ? ((totalSuccess / totalTasks) * 100).toFixed(1) : '0';

    embeds.push(
      new EmbedBuilder()
        .setColor(parseFloat(overallEfficiency) >= 70 ? BRAND_COLORS.success : BRAND_COLORS.warning)
        .setTitle(`🤖 Agent Report: ${agentName}`)
        .setDescription(`**30-Day Performance Summary**`)
        .addFields(
          { name: '💰 Total Credits', value: totalCredits.toFixed(1), inline: true },
          { name: '📋 Total Tasks', value: `${totalTasks}`, inline: true },
          { name: '✅ Success Rate', value: `${overallEfficiency}%`, inline: true },
          { name: '❌ Failed Tasks', value: `${totalFailed}`, inline: true },
          { name: '⚠️ Waste Flags', value: `${totalWaste}`, inline: true },
          { name: '🛡️ Credits Saved', value: totalSaved.toFixed(1), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
    );

    // Department breakdown for this agent
    if (efficiency.length > 1) {
      const deptLines = efficiency.map(e =>
        `**${e.department}** — ${e.efficiency_score.toFixed(1)}% efficiency | ${e.total_credits.toFixed(1)} credits | ${e.total_tasks} tasks`
      ).join('\n');

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.info)
          .setTitle('Department Activity')
          .setDescription(deptLines)
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    // Recent activity
    const recentRecords = this.creditDb.getRecentRecords(10);
    const agentRecords = recentRecords.filter(r => r.agent === agentName);
    if (agentRecords.length > 0) {
      const recentLines = agentRecords.map(r => {
        const statusEmoji = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'blocked' ? '🚫' : '⏳';
        const wasteFlag = r.is_waste ? ' 🗑️' : '';
        return `${statusEmoji} \`${r.task_id}\` ${r.operation} — ${(r.actual_credits || r.estimated_credits).toFixed(1)} credits${wasteFlag}`;
      }).join('\n');

      embeds.push(
        new EmbedBuilder()
          .setColor(BRAND_COLORS.neutral)
          .setTitle('📝 Recent Activity')
          .setDescription(recentLines)
          .setTimestamp()
          .setFooter({ text: '🐾 Make It Legend — Credit Monitor' })
      );
    }

    return embeds;
  }

  // ─────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────

  private progressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}
