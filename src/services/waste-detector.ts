import { EmbedBuilder } from 'discord.js';
import { CreditDatabase, CreditRecord } from './credit-database';
import { getChannelRouter } from './service-registry';
import { createModuleLogger } from '../utils/logger';
import { BRAND_COLORS } from '../utils/embeds';

const logger = createModuleLogger('waste-detector');

// ─────────────────────────────────────────────────────────
// Waste Detection Rules
// ─────────────────────────────────────────────────────────

export interface WasteAlert {
  type: 'retry_abuse' | 'credit_overrun' | 'spend_spike' | 'hard_error_retry';
  severity: 'warning' | 'critical';
  department: string;
  agent: string;
  description: string;
  creditsWasted: number;
  creditsSaved: number;
  recommendation: string;
}

/**
 * The WasteDetector runs checks against the credit database
 * and posts alerts to Discord when waste is detected.
 */
export class WasteDetector {
  private creditDb: CreditDatabase;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(creditDb: CreditDatabase) {
    this.creditDb = creditDb;
  }

  /**
   * Starts periodic waste detection checks (every 5 minutes).
   */
  start(): void {
    this.checkInterval = setInterval(() => {
      this.runAllChecks().catch(err => logger.error('Waste detection check failed', { error: err }));
    }, 5 * 60 * 1000);
    logger.info('Waste detector started (checking every 5 minutes)');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Waste detector stopped');
  }

  /**
   * Runs all waste detection rules and posts alerts for any violations.
   */
  async runAllChecks(): Promise<WasteAlert[]> {
    const alerts: WasteAlert[] = [];

    try {
      alerts.push(...this.checkRetryAbuse());
      alerts.push(...this.checkCreditOverruns());
      alerts.push(...this.checkSpendSpikes());
      alerts.push(...this.checkHardErrorRetries());

      // Post alerts to Discord
      for (const alert of alerts) {
        await this.postWasteAlert(alert);
      }

      if (alerts.length > 0) {
        logger.warn(`Waste detector found ${alerts.length} issue(s)`);
      }
    } catch (error) {
      logger.error('Error running waste detection checks', { error });
    }

    return alerts;
  }

  /**
   * RULE 1: If an agent retries the same failed approach more than 2 times → flag as waste.
   */
  private checkRetryAbuse(): WasteAlert[] {
    const alerts: WasteAlert[] = [];

    const recentRecords = this.creditDb.getRecentRecords(100);
    const retryGroups = new Map<string, CreditRecord[]>();

    for (const record of recentRecords) {
      if (record.is_retry) {
        const key = `${record.operation}:${record.department}`;
        if (!retryGroups.has(key)) retryGroups.set(key, []);
        retryGroups.get(key)!.push(record);
      }
    }

    for (const [key, records] of retryGroups) {
      if (records.length > 2) {
        const [operation, department] = key.split(':');
        const totalWasted = records.reduce((sum, r) => sum + (r.actual_credits || r.estimated_credits), 0);

        alerts.push({
          type: 'retry_abuse',
          severity: records.length > 4 ? 'critical' : 'warning',
          department,
          agent: records[0].agent,
          description: `Agent "${records[0].agent}" retried operation "${operation}" ${records.length} times in ${department}. Same failed approach repeated without changing strategy.`,
          creditsWasted: totalWasted,
          creditsSaved: 0,
          recommendation: `Stop retrying "${operation}" and escalate to the founder for a different approach.`,
        });

        // Mark records as waste in the database
        for (const record of records) {
          if (!record.is_waste) {
            this.creditDb.updateTaskCompletion(record.task_id, {
              status: record.status as any,
              isWaste: true,
              wasteReason: `Retry abuse: ${records.length} retries of same operation`,
            });
          }
        }
      }
    }

    return alerts;
  }

  /**
   * RULE 2: If a task takes more than 3x the expected credits → flag for review.
   */
  private checkCreditOverruns(): WasteAlert[] {
    const alerts: WasteAlert[] = [];

    const recentRecords = this.creditDb.getRecentRecords(50);
    for (const record of recentRecords) {
      if (
        record.actual_credits > 0 &&
        record.estimated_credits > 0 &&
        record.actual_credits > record.estimated_credits * 3 &&
        !record.is_waste
      ) {
        alerts.push({
          type: 'credit_overrun',
          severity: 'warning',
          department: record.department,
          agent: record.agent,
          description: `Task "${record.operation}" used ${record.actual_credits.toFixed(1)} credits vs estimated ${record.estimated_credits.toFixed(1)} (${(record.actual_credits / record.estimated_credits).toFixed(1)}x overrun).`,
          creditsWasted: record.actual_credits - record.estimated_credits,
          creditsSaved: 0,
          recommendation: `Review task "${record.task_id}" — the agent may be using an inefficient approach.`,
        });

        this.creditDb.updateTaskCompletion(record.task_id, {
          status: record.status as any,
          isWaste: true,
          wasteReason: `Credit overrun: ${(record.actual_credits / record.estimated_credits).toFixed(1)}x estimated`,
        });
      }
    }

    return alerts;
  }

  /**
   * RULE 3: If a department's daily spend exceeds 150% of its 7-day average → alert.
   */
  private checkSpendSpikes(): WasteAlert[] {
    const alerts: WasteAlert[] = [];

    const todaySpend = this.creditDb.getDailySpend();
    for (const dept of todaySpend) {
      const avg7Day = this.creditDb.get7DayAverage(dept.department);
      if (avg7Day > 0 && dept.total_credits > avg7Day * 1.5) {
        alerts.push({
          type: 'spend_spike',
          severity: dept.total_credits > avg7Day * 2 ? 'critical' : 'warning',
          department: dept.department,
          agent: 'department-wide',
          description: `${dept.department} has spent ${dept.total_credits.toFixed(1)} credits today, which is ${(dept.total_credits / avg7Day * 100).toFixed(0)}% of the 7-day daily average (${avg7Day.toFixed(1)}).`,
          creditsWasted: dept.total_credits - avg7Day,
          creditsSaved: 0,
          recommendation: `Review ${dept.department} department activity. Consider pausing non-critical tasks with \`/pause ${dept.department}\`.`,
        });
      }
    }

    return alerts;
  }

  /**
   * RULE 4: Hard errors (API restrictions, permission denied) should NEVER be retried.
   * Flag immediately if detected.
   */
  private checkHardErrorRetries(): WasteAlert[] {
    const alerts: WasteAlert[] = [];

    const recentRecords = this.creditDb.getRecentRecords(50);
    for (const record of recentRecords) {
      if (
        record.error_code &&
        record.is_retry &&
        this.isHardErrorCode(record.error_code) &&
        !record.is_waste
      ) {
        alerts.push({
          type: 'hard_error_retry',
          severity: 'critical',
          department: record.department,
          agent: record.agent,
          description: `Agent "${record.agent}" retried operation "${record.operation}" after receiving hard error ${record.error_code}: "${record.error_message}". Hard errors should NEVER be retried.`,
          creditsWasted: record.actual_credits || record.estimated_credits,
          creditsSaved: 0,
          recommendation: `This error is permanent. The agent should have recognized error ${record.error_code} as non-retryable and escalated immediately.`,
        });

        this.creditDb.updateTaskCompletion(record.task_id, {
          status: record.status as any,
          isWaste: true,
          wasteReason: `Hard error retry: ${record.error_code} is a permanent error`,
        });
      }
    }

    return alerts;
  }

  /**
   * Posts a waste alert to Discord channels.
   */
  private async postWasteAlert(alert: WasteAlert): Promise<void> {
    const router = getChannelRouter();
    if (!router) return;

    const embed = new EmbedBuilder()
      .setColor(alert.severity === 'critical' ? BRAND_COLORS.danger : BRAND_COLORS.warning)
      .setTitle(`${alert.severity === 'critical' ? '🔴' : '🟡'} Credit Waste Detected: ${alert.type.replace(/_/g, ' ').toUpperCase()}`)
      .setDescription(alert.description)
      .addFields(
        { name: '🏢 Department', value: alert.department, inline: true },
        { name: '🤖 Agent', value: alert.agent, inline: true },
        { name: '💸 Credits Wasted', value: alert.creditsWasted.toFixed(1), inline: true },
        { name: '💡 Recommendation', value: alert.recommendation },
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Make It Legend — Credit Monitor' });

    // Post to #analytics-credits
    await router.sendEmbed('analytics-credits' as any, embed);

    // Also post to #alerts-warning for visibility
    await router.routeAlert(alert.severity === 'critical' ? 'critical' : 'warning', embed);

    logger.warn(`Waste alert posted: ${alert.type} — ${alert.department} — ${alert.description.slice(0, 100)}`);
  }

  /**
   * Checks if an error code is a known hard error.
   */
  private isHardErrorCode(code: string): boolean {
    const hardCodes = new Set([
      '20001', '50001', '50013', '40001', '40003', '10001', '10004',
      '403', '401', 'ENOTFOUND', 'INVALID_API_KEY', 'ACCOUNT_SUSPENDED',
      'QUOTA_EXCEEDED', 'FEATURE_NOT_AVAILABLE', 'PERMISSION_DENIED',
    ]);
    return hardCodes.has(code);
  }
}
