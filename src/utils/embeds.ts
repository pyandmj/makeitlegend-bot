import { EmbedBuilder, Colors } from 'discord.js';
import { ApprovalRequest, DailyBriefingData, SystemHealth, DepartmentStatus, Task, Alert } from '../types';

/**
 * Brand colors for Make It Legend embeds.
 */
export const BRAND_COLORS = {
  primary: 0x7C3AED,    // Purple
  success: 0x22C55E,    // Green
  warning: 0xF59E0B,    // Amber
  danger: 0xEF4444,     // Red
  info: 0x3B82F6,       // Blue
  neutral: 0x6B7280,    // Gray
  gold: 0xFFD700,       // Gold (founder)
} as const;

/**
 * Creates a branded embed with the Make It Legend footer.
 */
function brandedEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setFooter({ text: '🐾 Make It Legend — AI Pet Portraits' })
    .setTimestamp();
}

// ─────────────────────────────────────────────────────────
// Approval Embeds
// ─────────────────────────────────────────────────────────

export function createApprovalEmbed(request: ApprovalRequest): EmbedBuilder {
  return brandedEmbed()
    .setColor(BRAND_COLORS.warning)
    .setTitle(`🔔 Approval Required: ${request.title}`)
    .setDescription(request.description)
    .addFields(
      { name: '📋 Request ID', value: `\`${request.id}\``, inline: true },
      { name: '🏢 Department', value: request.department, inline: true },
      { name: '🤖 Requested By', value: request.requestedBy, inline: true },
      { name: '\u200b', value: '**React ✅ to approve or ❌ to deny**\n*Or use `/approve` and `/deny` commands*' }
    );
}

export function createApprovalResultEmbed(request: ApprovalRequest): EmbedBuilder {
  const isApproved = request.status === 'approved';
  return brandedEmbed()
    .setColor(isApproved ? BRAND_COLORS.success : BRAND_COLORS.danger)
    .setTitle(`${isApproved ? '✅ Approved' : '❌ Denied'}: ${request.title}`)
    .setDescription(
      isApproved
        ? 'This request has been approved and will be processed.'
        : `This request has been denied.${request.denyReason ? `\n**Reason:** ${request.denyReason}` : ''}`
    )
    .addFields(
      { name: '📋 Request ID', value: `\`${request.id}\``, inline: true },
      { name: '🏢 Department', value: request.department, inline: true },
      { name: '👤 Resolved By', value: request.resolvedBy || 'Unknown', inline: true }
    );
}

// ─────────────────────────────────────────────────────────
// Briefing Embed
// ─────────────────────────────────────────────────────────

export function createBriefingEmbed(data: DailyBriefingData): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  // Header embed
  embeds.push(
    brandedEmbed()
      .setColor(BRAND_COLORS.gold)
      .setTitle(`📋 CEO Daily Briefing — ${data.date}`)
      .setDescription(
        `Good morning! Here's your daily overview of Make It Legend operations.\n` +
        `**Pending Approvals:** ${data.pendingApprovals}`
      )
  );

  // Revenue & Orders
  const revenueProgress = data.revenue.target > 0
    ? ((data.revenue.mtd / data.revenue.target) * 100).toFixed(1)
    : '0';
  embeds.push(
    brandedEmbed()
      .setColor(BRAND_COLORS.success)
      .setTitle('💰 Revenue & Orders')
      .addFields(
        { name: 'Today Revenue', value: `$${data.revenue.today.toLocaleString()}`, inline: true },
        { name: 'Yesterday', value: `$${data.revenue.yesterday.toLocaleString()}`, inline: true },
        { name: 'MTD / Target', value: `$${data.revenue.mtd.toLocaleString()} / $${data.revenue.target.toLocaleString()} (${revenueProgress}%)`, inline: false },
        { name: 'New Orders', value: `${data.orders.new}`, inline: true },
        { name: 'Processing', value: `${data.orders.processing}`, inline: true },
        { name: 'Completed', value: `${data.orders.completed}`, inline: true },
        { name: 'Failed', value: `${data.orders.failed}`, inline: true },
      )
  );

  // Portraits & Creative
  embeds.push(
    brandedEmbed()
      .setColor(BRAND_COLORS.primary)
      .setTitle('🎨 Portraits & Creative')
      .addFields(
        { name: 'Generated', value: `${data.portraits.generated}`, inline: true },
        { name: 'Approved', value: `${data.portraits.approved}`, inline: true },
        { name: 'Rejected', value: `${data.portraits.rejected}`, inline: true },
        { name: 'Avg Generation Time', value: data.portraits.avgGenerationTime, inline: true },
      )
  );

  // Marketing
  embeds.push(
    brandedEmbed()
      .setColor(BRAND_COLORS.info)
      .setTitle('📈 Marketing')
      .addFields(
        { name: 'Visitors', value: `${data.marketing.visitors.toLocaleString()}`, inline: true },
        { name: 'Conversions', value: `${data.marketing.conversions}`, inline: true },
        { name: 'Conv. Rate', value: data.marketing.conversionRate, inline: true },
        { name: 'Ad Spend', value: `$${data.marketing.adSpend.toLocaleString()}`, inline: true },
        { name: 'ROAS', value: data.marketing.roas, inline: true },
      )
  );

  // Engineering & Support
  embeds.push(
    brandedEmbed()
      .setColor(BRAND_COLORS.neutral)
      .setTitle('🔧 Engineering & Support')
      .addFields(
        { name: 'Uptime', value: data.engineering.uptime, inline: true },
        { name: 'Deployments', value: `${data.engineering.deployments}`, inline: true },
        { name: 'Bugs (Open/Resolved)', value: `${data.engineering.openBugs} / ${data.engineering.resolvedBugs}`, inline: true },
        { name: 'New Tickets', value: `${data.support.newTickets}`, inline: true },
        { name: 'Resolved', value: `${data.support.resolved}`, inline: true },
        { name: 'Avg Response', value: data.support.avgResponseTime, inline: true },
        { name: 'CSAT', value: data.support.satisfaction, inline: true },
      )
  );

  // Alerts & Priorities
  if (data.topPriorities.length > 0) {
    embeds.push(
      brandedEmbed()
        .setColor(data.alerts.critical > 0 ? BRAND_COLORS.danger : BRAND_COLORS.warning)
        .setTitle('🚨 Alerts & Top Priorities')
        .addFields(
          { name: 'Critical', value: `${data.alerts.critical}`, inline: true },
          { name: 'Warning', value: `${data.alerts.warning}`, inline: true },
          { name: 'Resolved', value: `${data.alerts.resolved}`, inline: true },
          { name: '🎯 Top Priorities', value: data.topPriorities.map((p, i) => `${i + 1}. ${p}`).join('\n') },
        )
    );
  }

  return embeds;
}

// ─────────────────────────────────────────────────────────
// System Health Embed
// ─────────────────────────────────────────────────────────

export function createSystemHealthEmbed(health: SystemHealth): EmbedBuilder {
  const statusEmoji = {
    healthy: '🟢',
    degraded: '🟡',
    critical: '🔴',
    down: '⚫',
  };

  const deptLines = health.departments.map(d => {
    const emoji = statusEmoji[d.health] || '⚪';
    const statusLabel = d.status === 'paused' ? ' (PAUSED)' : '';
    return `${emoji} **${d.name}**${statusLabel} — ${d.activeTasks} active, ${d.completedToday} done today${d.alerts > 0 ? `, ⚠️ ${d.alerts} alerts` : ''}`;
  }).join('\n');

  return brandedEmbed()
    .setColor(
      health.overall === 'healthy' ? BRAND_COLORS.success :
      health.overall === 'degraded' ? BRAND_COLORS.warning :
      BRAND_COLORS.danger
    )
    .setTitle(`${statusEmoji[health.overall]} System Status — Make It Legend`)
    .setDescription(`**Overall:** ${health.overall.toUpperCase()}\n**Uptime:** ${health.uptime}`)
    .addFields(
      { name: '🏢 Departments', value: deptLines || 'No department data available' },
      { name: '📋 Pending Approvals', value: `${health.pendingApprovals}`, inline: true },
      { name: '🚨 Active Alerts', value: `${health.activeAlerts}`, inline: true },
      { name: '📅 Last Briefing', value: health.lastBriefing ? health.lastBriefing.toLocaleString() : 'Never', inline: true },
    );
}

// ─────────────────────────────────────────────────────────
// Department Report Embed
// ─────────────────────────────────────────────────────────

export function createDepartmentReportEmbed(dept: DepartmentStatus, tasks: Task[]): EmbedBuilder {
  const statusEmoji = dept.health === 'healthy' ? '🟢' : dept.health === 'degraded' ? '🟡' : '🔴';
  const taskList = tasks.length > 0
    ? tasks.slice(0, 10).map(t => `• \`${t.id.slice(0, 8)}\` [${t.status}] ${t.description}`).join('\n')
    : 'No active tasks';

  return brandedEmbed()
    .setColor(
      dept.health === 'healthy' ? BRAND_COLORS.success :
      dept.health === 'degraded' ? BRAND_COLORS.warning :
      BRAND_COLORS.danger
    )
    .setTitle(`${statusEmoji} ${dept.name} Department Report`)
    .addFields(
      { name: 'Status', value: dept.status.toUpperCase(), inline: true },
      { name: 'Health', value: dept.health.toUpperCase(), inline: true },
      { name: 'Alerts', value: `${dept.alerts}`, inline: true },
      { name: 'Active Tasks', value: `${dept.activeTasks}`, inline: true },
      { name: 'Completed Today', value: `${dept.completedToday}`, inline: true },
      { name: 'Failed Today', value: `${dept.failedToday}`, inline: true },
      { name: '📝 Recent Tasks', value: taskList },
      { name: '🕐 Last Activity', value: dept.lastActivity.toLocaleString() },
    );
}

// ─────────────────────────────────────────────────────────
// Task Embed
// ─────────────────────────────────────────────────────────

export function createTaskEmbed(task: Task): EmbedBuilder {
  const priorityColors: Record<string, number> = {
    critical: BRAND_COLORS.danger,
    high: BRAND_COLORS.warning,
    medium: BRAND_COLORS.info,
    low: BRAND_COLORS.neutral,
  };

  return brandedEmbed()
    .setColor(priorityColors[task.priority] || BRAND_COLORS.neutral)
    .setTitle(`📌 New Task: ${task.description.slice(0, 100)}`)
    .addFields(
      { name: 'Task ID', value: `\`${task.id}\``, inline: true },
      { name: 'Department', value: task.department, inline: true },
      { name: 'Priority', value: task.priority.toUpperCase(), inline: true },
      { name: 'Status', value: task.status, inline: true },
    );
}

// ─────────────────────────────────────────────────────────
// Alert Embed
// ─────────────────────────────────────────────────────────

export function createAlertEmbed(alert: Alert): EmbedBuilder {
  const severityConfig = {
    critical: { color: BRAND_COLORS.danger, emoji: '🔴' },
    warning: { color: BRAND_COLORS.warning, emoji: '🟡' },
    info: { color: BRAND_COLORS.info, emoji: '🔵' },
  };

  const cfg = severityConfig[alert.severity];

  return brandedEmbed()
    .setColor(cfg.color)
    .setTitle(`${cfg.emoji} ${alert.severity.toUpperCase()} Alert: ${alert.title}`)
    .setDescription(alert.description)
    .addFields(
      { name: 'Alert ID', value: `\`${alert.id}\``, inline: true },
      { name: 'Department', value: alert.department, inline: true },
      { name: 'Severity', value: alert.severity.toUpperCase(), inline: true },
    );
}

// ─────────────────────────────────────────────────────────
// Webhook Event Embeds
// ─────────────────────────────────────────────────────────

export function createStripeEmbed(eventType: string, data: Record<string, unknown>): EmbedBuilder {
  const obj = data as Record<string, unknown>;
  const amount = typeof obj.amount === 'number' ? (obj.amount / 100).toFixed(2) : 'N/A';
  const currency = (obj.currency as string || 'usd').toUpperCase();
  const email = obj.customer_email as string || 'Unknown';

  const typeLabels: Record<string, { title: string; color: number }> = {
    'checkout.session.completed': { title: '💳 New Order Payment', color: BRAND_COLORS.success },
    'payment_intent.succeeded': { title: '💰 Payment Succeeded', color: BRAND_COLORS.success },
    'payment_intent.payment_failed': { title: '❌ Payment Failed', color: BRAND_COLORS.danger },
    'charge.refunded': { title: '↩️ Refund Processed', color: BRAND_COLORS.warning },
    'charge.dispute.created': { title: '⚠️ Dispute Created', color: BRAND_COLORS.danger },
  };

  const label = typeLabels[eventType] || { title: `Stripe: ${eventType}`, color: BRAND_COLORS.neutral };

  return brandedEmbed()
    .setColor(label.color)
    .setTitle(label.title)
    .addFields(
      { name: 'Event', value: eventType, inline: true },
      { name: 'Amount', value: `${amount} ${currency}`, inline: true },
      { name: 'Customer', value: email, inline: true },
      { name: 'ID', value: `\`${obj.id || 'N/A'}\``, inline: false },
    );
}

export function createManusEventEmbed(event: string, data: Record<string, unknown>): EmbedBuilder {
  const isSuccess = data.status === 'completed' || data.status === 'success';
  const isFailure = data.status === 'failed' || data.status === 'error';

  return brandedEmbed()
    .setColor(isSuccess ? BRAND_COLORS.success : isFailure ? BRAND_COLORS.danger : BRAND_COLORS.info)
    .setTitle(`🤖 Manus: ${event}`)
    .addFields(
      { name: 'Task ID', value: `\`${data.taskId || 'N/A'}\``, inline: true },
      { name: 'Department', value: (data.department as string) || 'Unknown', inline: true },
      { name: 'Status', value: (data.status as string) || 'Unknown', inline: true },
    )
    .setDescription(
      data.result ? `**Result:** ${data.result}` :
      data.error ? `**Error:** ${data.error}` :
      'No additional details.'
    );
}

export function createWebsiteEventEmbed(event: string, data: Record<string, unknown>): EmbedBuilder {
  const isError = event.includes('error') || event.includes('fail');

  const embed = brandedEmbed()
    .setColor(isError ? BRAND_COLORS.danger : BRAND_COLORS.primary)
    .setTitle(`🌐 Website: ${event}`);

  const fields: { name: string; value: string; inline: boolean }[] = [];
  if (data.orderId) fields.push({ name: 'Order ID', value: `\`${data.orderId}\``, inline: true });
  if (data.portraitId) fields.push({ name: 'Portrait ID', value: `\`${data.portraitId}\``, inline: true });
  if (data.petName) fields.push({ name: 'Pet Name', value: data.petName as string, inline: true });
  if (data.style) fields.push({ name: 'Style', value: data.style as string, inline: true });
  if (data.email) fields.push({ name: 'Customer', value: data.email as string, inline: true });
  if (data.status) fields.push({ name: 'Status', value: data.status as string, inline: true });
  if (data.error) embed.setDescription(`**Error:** ${data.error}`);

  if (fields.length > 0) embed.addFields(fields);

  return embed;
}
