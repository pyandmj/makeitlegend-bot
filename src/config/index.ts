import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Gets an environment variable value.
 * Logs a warning if missing but does NOT throw — allows the app to start.
 */
function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value) return value;
  if (fallback !== undefined) return fallback;
  console.warn(`⚠️  Missing environment variable: ${key}`);
  return '';
}

export const config = {
  /** Discord configuration */
  discord: {
    token: requireEnv('DISCORD_BOT_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    guildId: requireEnv('DISCORD_GUILD_ID'),
    founderUserId: requireEnv('FOUNDER_USER_ID'),
  },

  /** Manus API configuration */
  manus: {
    apiKey: process.env.MANUS_API_KEY || '',
    baseUrl: process.env.MANUS_API_BASE_URL || 'https://api.manus.im',
  },

  /** Webhook server configuration */
  webhook: {
    port: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10),
    publicUrl: process.env.WEBHOOK_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : '',
    stripeSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    manusSecret: process.env.MANUS_WEBHOOK_SECRET || '',
    websiteSecret: process.env.WEBSITE_WEBHOOK_SECRET || '',
  },

  /** Scheduling configuration */
  scheduling: {
    briefingCron: process.env.BRIEFING_CRON || '0 8 * * *',
    timezone: process.env.TIMEZONE || 'America/New_York',
  },

  /** Logging configuration */
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  /** Environment */
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
} as const;

/**
 * Channel structure definition for the Make It Legend Discord server.
 * Each category contains its channels with name, topic, and routing purpose.
 */
export const CHANNEL_STRUCTURE = {
  'EXECUTIVE': {
    emoji: '📋',
    channels: [
      { name: 'ceo-briefing', topic: 'Daily summary and strategic overview for the founder', readOnly: true },
      { name: 'approvals', topic: 'Decisions requiring human input — react ✅ to approve, ❌ to deny', readOnly: false },
      { name: 'announcements', topic: 'Company-wide updates and announcements', readOnly: true },
    ],
  },
  'ALERTS': {
    emoji: '🚨',
    channels: [
      { name: 'alerts-critical', topic: 'System failures and urgent issues requiring immediate attention', readOnly: true },
      { name: 'alerts-warning', topic: 'Non-critical issues that need attention soon', readOnly: true },
    ],
  },
  'ENGINEERING': {
    emoji: '🔧',
    channels: [
      { name: 'eng-general', topic: 'Engineering team updates and discussions', readOnly: false },
      { name: 'eng-deployments', topic: 'Deployment logs, CI/CD status, and release notes', readOnly: true },
      { name: 'eng-bugs', topic: 'Bug reports, tracking, and fix confirmations', readOnly: false },
    ],
  },
  'CREATIVE': {
    emoji: '🎨',
    channels: [
      { name: 'creative-general', topic: 'Creative team updates and discussions', readOnly: false },
      { name: 'creative-portraits', topic: 'Portrait generation logs, results, and quality reviews', readOnly: true },
      { name: 'creative-content', topic: 'UGC, copywriting, and social media content pipeline', readOnly: false },
    ],
  },
  'MARKETING': {
    emoji: '📈',
    channels: [
      { name: 'mkt-general', topic: 'Marketing team updates and discussions', readOnly: false },
      { name: 'mkt-campaigns', topic: 'Campaign performance, A/B tests, and optimization logs', readOnly: true },
      { name: 'mkt-analytics', topic: 'Traffic, conversion, and funnel analytics', readOnly: true },
    ],
  },
  'OPERATIONS': {
    emoji: '🛒',
    channels: [
      { name: 'ops-orders', topic: 'Order processing logs, fulfillment status, and shipping updates', readOnly: true },
      { name: 'ops-support', topic: 'Customer support tickets and resolution tracking', readOnly: false },
      { name: 'ops-quality', topic: 'QA results, quality metrics, and review outcomes', readOnly: true },
    ],
  },
  'ANALYTICS': {
    emoji: '📊',
    channels: [
      { name: 'analytics-dashboard', topic: 'KPI summaries, dashboards, and performance snapshots', readOnly: true },
      { name: 'analytics-credits', topic: 'Credit usage tracking, efficiency reports, and waste alerts', readOnly: true },
      { name: 'analytics-anomalies', topic: 'Detected anomalies, outliers, and data quality issues', readOnly: true },
      { name: 'analytics-self-healing', topic: 'Automated fixes, self-healing actions, and recovery logs', readOnly: true },
    ],
  },
} as const;

/**
 * Role definitions for the Make It Legend team.
 * Each role has a name, color, and permission scope.
 */
export const ROLE_DEFINITIONS = [
  { name: 'Founder', color: 0xFFD700, hoist: true, mentionable: true, position: 'top', departments: ['all'] },
  { name: 'Prime', color: 0x9B59B6, hoist: true, mentionable: true, position: 'high', departments: ['all'] },
  { name: 'Engineering Director', color: 0x3498DB, hoist: true, mentionable: true, position: 'mid', departments: ['ENGINEERING'] },
  { name: 'Creative Director', color: 0xE91E63, hoist: true, mentionable: true, position: 'mid', departments: ['CREATIVE'] },
  { name: 'Marketing Director', color: 0x2ECC71, hoist: true, mentionable: true, position: 'mid', departments: ['MARKETING'] },
  { name: 'Operations Director', color: 0xF39C12, hoist: true, mentionable: true, position: 'mid', departments: ['OPERATIONS'] },
  { name: 'Analytics Director', color: 0x1ABC9C, hoist: true, mentionable: true, position: 'mid', departments: ['ANALYTICS'] },
  { name: 'Worker Agent', color: 0x95A5A6, hoist: false, mentionable: false, position: 'low', departments: ['limited'] },
] as const;

/**
 * Department names mapped to their channel prefixes for routing.
 */
export const DEPARTMENT_CHANNEL_MAP: Record<string, string[]> = {
  engineering: ['eng-general', 'eng-deployments', 'eng-bugs'],
  creative: ['creative-general', 'creative-portraits', 'creative-content'],
  marketing: ['mkt-general', 'mkt-campaigns', 'mkt-analytics'],
  operations: ['ops-orders', 'ops-support', 'ops-quality'],
  analytics: ['analytics-dashboard', 'analytics-credits', 'analytics-anomalies', 'analytics-self-healing'],
};

/**
 * Valid department names for slash command choices.
 */
export const DEPARTMENTS = ['engineering', 'creative', 'marketing', 'operations', 'analytics'] as const;
export type Department = typeof DEPARTMENTS[number];
