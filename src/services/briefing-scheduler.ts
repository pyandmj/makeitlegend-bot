import cron from 'node-cron';
import { config } from '../config';
import { store } from '../utils/store';
import { createBriefingEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter } from './service-registry';

const logger = createModuleLogger('briefing-scheduler');

/**
 * Service that schedules and sends daily CEO briefings,
 * and handles daily counter resets.
 */
export class BriefingScheduler {
  private briefingJob: cron.ScheduledTask | null = null;
  private resetJob: cron.ScheduledTask | null = null;

  /**
   * Starts the scheduled jobs.
   */
  start(): void {
    // Daily briefing
    this.briefingJob = cron.schedule(
      config.scheduling.briefingCron,
      () => this.sendDailyBriefing(),
      { timezone: config.scheduling.timezone }
    );

    // Reset daily counters at midnight
    this.resetJob = cron.schedule(
      '0 0 * * *',
      () => store.resetDailyCounters(),
      { timezone: config.scheduling.timezone }
    );

    logger.info(`Briefing scheduled: ${config.scheduling.briefingCron} (${config.scheduling.timezone})`);
    logger.info('Daily counter reset scheduled: midnight');
  }

  /**
   * Stops all scheduled jobs.
   */
  stop(): void {
    this.briefingJob?.stop();
    this.resetJob?.stop();
    logger.info('All scheduled jobs stopped');
  }

  /**
   * Sends the daily briefing to #ceo-briefing.
   * Can also be called manually.
   */
  async sendDailyBriefing(): Promise<void> {
    const router = getChannelRouter();
    if (!router) {
      logger.error('Channel router not available — cannot send briefing');
      return;
    }

    try {
      const data = store.generateBriefingData();
      const embeds = createBriefingEmbed(data);

      await router.sendEmbeds('ceo-briefing', embeds);

      store.setLastBriefing(new Date());
      logger.info('Daily briefing sent to #ceo-briefing');
    } catch (error) {
      logger.error('Failed to send daily briefing', { error });
    }
  }
}
