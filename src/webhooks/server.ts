import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { store } from '../utils/store';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getCreditDb, getManusClient } from '../services/service-registry';
import { ApprovalService } from '../services/approval-service';
import {
  createStripeEmbed,
  createManusEventEmbed,
  createWebsiteEventEmbed,
  createAlertEmbed,
  BRAND_COLORS,
} from '../utils/embeds';
import {
  ChannelName,
  StripeWebhookPayload,
  WebsiteWebhookPayload,
} from '../types';
import {
  ManusWebhookPayload,
  ManusTaskCreatedEvent,
  ManusTaskProgressEvent,
  ManusTaskStoppedEvent,
} from '../services/manus-client';
import { EmbedBuilder } from 'discord.js';

const logger = createModuleLogger('webhook-server');

/**
 * Creates and configures the Express webhook server.
 *
 * Receives events from Stripe, Manus API, and the website,
 * then formats and routes them to the appropriate Discord channels.
 *
 * The Manus webhook handler has been updated to process the real
 * Manus Open API event format (task_created / task_progress / task_stopped).
 */
export function createWebhookServer(approvalService: ApprovalService): express.Application {
  const app = express();

  // ─────────────────────────────────────────────────────
  // Middleware
  // ─────────────────────────────────────────────────────

  app.use(helmet());

  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  app.use(limiter);

  // Raw body for Stripe; JSON for everything else
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/webhooks/stripe') {
      express.raw({ type: 'application/json' })(req, res, next);
    } else if (req.path === '/webhooks/manus') {
      // Keep raw body buffer for RSA signature verification
      express.raw({ type: 'application/json' })(req, res, next);
    } else {
      express.json({ limit: '1mb' })(req, res, next);
    }
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, { ip: req.ip });
    next();
  });

  // ─────────────────────────────────────────────────────
  // Health Check
  // ─────────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    const health = store.getSystemHealth();
    const creditDb = getCreditDb();
    const creditSummary = creditDb ? creditDb.getCreditBriefingSummary() : null;

    res.json({
      status: 'ok',
      service: 'makeitlegend-bot',
      version: '2.0.0',
      system: health.overall,
      uptime: health.uptime,
      credits: creditSummary ? {
        todayTotal: creditSummary.todayTotal,
        todayWaste: creditSummary.todayWaste,
        todaySaved: creditSummary.todaySaved,
        todaySuccessRate: creditSummary.todaySuccessRate,
      } : null,
      timestamp: new Date().toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────
  // Internal API: Send message as agent identity
  // ─────────────────────────────────────────────────────

  app.post('/api/send-as-agent', async (req: Request, res: Response) => {
    try {
      const { agent, channel, message } = req.body;
      if (!agent || !channel || !message) {
        res.status(400).json({ error: 'Missing required fields: agent, channel, message' });
        return;
      }

      const router = getChannelRouter();
      if (!router) {
        res.status(503).json({ error: 'Channel router not available' });
        return;
      }

      const messageId = await router.sendAsAgent(channel as any, agent, message);
      if (messageId) {
        res.json({ status: 'ok', messageId });
      } else {
        res.status(500).json({ error: 'Failed to send message' });
      }
    } catch (error: any) {
      logger.error('Internal API error: send-as-agent', { error });
      res.status(500).json({ error: error.message });
    }
  });

  // ─────────────────────────────────────────────────────
  // Stripe Webhooks
  // ─────────────────────────────────────────────────────

  app.post('/webhooks/stripe', async (req: Request, res: Response) => {
    try {
      let payload: StripeWebhookPayload;
      if (Buffer.isBuffer(req.body)) {
        payload = JSON.parse(req.body.toString());
      } else {
        payload = req.body;
      }

      const eventType = payload.type;
      const data = payload.data?.object || {};

      logger.info(`Stripe webhook: ${eventType}`, { id: data.id });

      const router = getChannelRouter();
      if (!router) { res.status(200).json({ received: true }); return; }

      const embed = createStripeEmbed(eventType, data as Record<string, unknown>);
      const amount = typeof data.amount === 'number' ? data.amount / 100 : 0;

      if (eventType === 'payment_intent.succeeded' || eventType === 'checkout.session.completed') {
        store.trackRevenue(amount);
        store.trackOrder('new');
      }
      if (eventType === 'charge.refunded') {
        store.trackRevenue(-amount);
        store.trackOrder('refund');
      }

      if (eventType.startsWith('checkout.') || eventType.startsWith('payment_intent.')) {
        await router.sendEmbed('ops-orders', embed);
      }
      if (eventType.includes('refund') || eventType.includes('dispute')) {
        await router.sendEmbed('ops-support', embed);
        await router.routeAlert('warning', embed);
      }
      if (eventType.includes('failed')) {
        await router.routeAlert('warning', embed);
      }
      if (eventType.includes('dispute') || amount > 500) {
        await approvalService.createApproval({
          title: `Stripe: ${eventType}`,
          description: `Amount: $${amount.toFixed(2)}\nCustomer: ${data.customer_email || 'Unknown'}\nID: ${data.id}`,
          department: 'operations',
          requestedBy: 'Stripe Webhook',
          metadata: { stripeEventType: eventType, stripeObjectId: data.id },
        });
      }

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('Stripe webhook error', { error });
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  });

  // ─────────────────────────────────────────────────────
  // Manus API Webhooks — Real Open API format
  //
  // Manus sends three event types:
  //   task_created   → task was accepted and queued
  //   task_progress  → step-by-step plan updates
  //   task_stopped   → task finished (or needs user input)
  //
  // Signature verification uses RSA-SHA256 with headers:
  //   X-Webhook-Signature  (base64-encoded RSA signature)
  //   X-Webhook-Timestamp  (unix timestamp)
  // ─────────────────────────────────────────────────────

  app.post('/webhooks/manus', async (req: Request, res: Response) => {
    // ─── 1. Parse raw body ───
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    let payload: ManusWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString()) as ManusWebhookPayload;
    } catch {
      logger.warn('Manus webhook: invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    // ─── 2. Verify RSA-SHA256 signature (if available) ───
    const manusClient = getManusClient();
    const signature = req.headers['x-webhook-signature'] as string | undefined;
    const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;

    if (manusClient && signature && timestamp) {
      const webhookUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const isValid = await manusClient.verifyWebhookSignature(webhookUrl, rawBody, signature, timestamp);
      if (!isValid) {
        logger.warn('Manus webhook: signature verification failed');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } else if (signature || timestamp) {
      // Headers present but client unavailable — log and continue (don't block)
      logger.warn('Manus webhook: signature headers present but could not verify (no client)');
    }

    logger.info(`Manus webhook: ${payload.event_type}`, { event_id: payload.event_id });

    // Respond immediately — Manus expects 200 within 10 seconds
    res.status(200).json({ received: true });

    // ─── 3. Process asynchronously after responding ───
    setImmediate(async () => {
      try {
        await handleManusWebhookEvent(payload, approvalService);
      } catch (error) {
        logger.error('Manus webhook async processing error', { error });
      }
    });
  });

  // ─────────────────────────────────────────────────────
  // Website Webhooks
  // ─────────────────────────────────────────────────────

  app.post('/webhooks/website', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers['x-webhook-secret'] || req.headers['authorization'];
      if (
        config.webhook.websiteSecret &&
        authHeader !== config.webhook.websiteSecret &&
        authHeader !== `Bearer ${config.webhook.websiteSecret}`
      ) {
        logger.warn('Website webhook: invalid secret');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const payload: WebsiteWebhookPayload = req.body;
      const { event, data } = payload;

      logger.info(`Website webhook: ${event}`, { data });

      const router = getChannelRouter();
      if (!router) { res.status(200).json({ received: true }); return; }

      const embed = createWebsiteEventEmbed(event, data as Record<string, unknown>);

      if (event === 'portrait.generation.started') {
        await router.sendEmbed('creative-portraits', embed);
      } else if (event === 'portrait.generation.completed') {
        await router.sendEmbed('creative-portraits', embed);
        store.trackPortrait('completed');
      } else if (event === 'portrait.generation.failed') {
        await router.sendEmbed('creative-portraits', embed);
        store.trackPortrait('failed');
        const alert = store.createAlert({
          severity: 'warning',
          title: 'Portrait Generation Failed',
          description: data.error as string || `Portrait ${data.portraitId} failed`,
          department: 'creative',
        });
        await router.routeAlert('warning', createAlertEmbed(alert));
      } else if (event === 'user.signup') {
        await router.sendEmbed('ops-orders', embed);
      } else if (event.startsWith('order.')) {
        await router.sendEmbed('ops-orders', embed);
        if (event === 'order.created') store.trackOrder('new');
        if (event === 'order.completed') store.trackOrder('completed');
        if (event === 'order.failed') store.trackOrder('failed');
      } else if (event.startsWith('support.')) {
        await router.sendEmbed('ops-support', embed);
      } else if (event.startsWith('error.') || event.startsWith('failure.')) {
        await router.sendEmbed('eng-bugs', embed);
        const isCritical = event.includes('critical');
        const alert = store.createAlert({
          severity: isCritical ? 'critical' : 'warning',
          title: `Website: ${event}`,
          description: data.error as string || `Website event: ${event}`,
          department: 'engineering',
        });
        await router.routeAlert(isCritical ? 'critical' : 'warning', createAlertEmbed(alert));
      } else if (event.startsWith('content.')) {
        await router.sendEmbed('creative-content', embed);
      } else if (event.startsWith('analytics.')) {
        await router.sendEmbed('mkt-analytics', embed);
      } else {
        await router.sendEmbed('announcements', embed);
      }

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('Website webhook error', { error });
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  });

  // ─────────────────────────────────────────────────────
  // Alert & Approval APIs
  // ─────────────────────────────────────────────────────

  app.post('/api/alert', async (req: Request, res: Response) => {
    try {
      const { severity, title, description, department } = req.body;
      if (!severity || !title || !description || !department) {
        res.status(400).json({ error: 'Missing required fields: severity, title, description, department' });
        return;
      }
      const alert = store.createAlert({ severity, title, description, department });
      const embed = createAlertEmbed(alert);
      const router = getChannelRouter();
      if (router) await router.routeAlert(severity === 'critical' ? 'critical' : 'warning', embed);
      res.status(201).json({ alertId: alert.id, status: 'created' });
    } catch (error) {
      logger.error('Alert creation error', { error });
      res.status(500).json({ error: 'Failed to create alert' });
    }
  });

  app.post('/api/approval', async (req: Request, res: Response) => {
    try {
      const { title, description, department, requestedBy, callbackUrl, metadata } = req.body;
      if (!title || !description || !department || !requestedBy) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }
      const approval = await approvalService.createApproval({
        title, description, department, requestedBy, callbackUrl, metadata,
      });
      if (approval) {
        res.status(201).json({ approvalId: approval.id, status: 'pending' });
      } else {
        res.status(500).json({ error: 'Failed to create approval' });
      }
    } catch (error) {
      logger.error('Approval creation error', { error });
      res.status(500).json({ error: 'Failed to create approval' });
    }
  });

  app.get('/api/approval/:id', (req: Request, res: Response) => {
    const approval = store.getApproval(req.params.id);
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return; }
    res.json(approval);
  });

  // ─────────────────────────────────────────────────────
  // Credit Usage API
  // ─────────────────────────────────────────────────────

  app.get('/api/credits/summary', (_req: Request, res: Response) => {
    const creditDb = getCreditDb();
    if (!creditDb) { res.status(503).json({ error: 'Credit tracking not initialized' }); return; }
    res.json(creditDb.getCreditBriefingSummary());
  });

  app.get('/api/credits/daily', (_req: Request, res: Response) => {
    const creditDb = getCreditDb();
    if (!creditDb) { res.status(503).json({ error: 'Credit tracking not initialized' }); return; }
    res.json(creditDb.getDailySpend());
  });

  app.get('/api/credits/weekly', (_req: Request, res: Response) => {
    const creditDb = getCreditDb();
    if (!creditDb) { res.status(503).json({ error: 'Credit tracking not initialized' }); return; }
    res.json(creditDb.getWeeklySpend());
  });

  app.get('/api/status', (_req: Request, res: Response) => {
    res.json(store.getSystemHealth());
  });

  // ─────────────────────────────────────────────────────
  // 404 / Error Handlers
  // ─────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled server error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MANUS WEBHOOK EVENT HANDLER
//  Processes the three real Manus event types and routes results to Discord.
// ─────────────────────────────────────────────────────────────────────────────

async function handleManusWebhookEvent(
  payload: ManusWebhookPayload,
  approvalService: ApprovalService,
): Promise<void> {
  const router = getChannelRouter();
  const creditDb = getCreditDb();
  const manusClient = getManusClient();

  switch (payload.event_type) {

    // ─── task_created: Manus accepted the task ───
    case 'task_created': {
      const { task_id, task_title, task_url } = (payload as ManusTaskCreatedEvent).task_detail;
      logger.info(`Manus task accepted: ${task_id} — "${task_title}"`);

      // Update credit record status to 'running'
      if (creditDb) {
        const record = creditDb.getRecordByManusId(task_id);
        if (record) {
          creditDb.updateTaskCompletion(record.task_id, { status: 'completed', outcome: 'running' });
        }
      }

      // We already posted the "dispatched" embed in task.ts — no need to post again.
      // This event is mainly for internal bookkeeping.
      break;
    }

    // ─── task_progress: Step-by-step plan update ───
    case 'task_progress': {
      const { task_id, message } = (payload as ManusTaskProgressEvent).progress_detail;
      logger.info(`Manus task progress: ${task_id} — ${message}`);

      if (!router || !manusClient) break;

      const ctx = manusClient.getTaskContext(task_id);
      if (!ctx) {
        logger.debug(`No Discord context for task ${task_id} — skipping progress post`);
        break;
      }

      // Post a lightweight progress update to the department channel
      const progressEmbed = new EmbedBuilder()
        .setColor(BRAND_COLORS.info ?? 0x3498db)
        .setTitle('⚙️ Manus Working…')
        .setDescription(`> ${message}`)
        .addFields(
          { name: 'Task', value: `\`${task_id}\``, inline: true },
          { name: 'Department', value: ctx.department, inline: true },
        )
        .setFooter({ text: `Requested by ${ctx.userTag}` })
        .setTimestamp();

      await router.routeDepartmentUpdate(ctx.department, progressEmbed);
      break;
    }

    // ─── task_stopped: Task finished or needs input ───
    case 'task_stopped': {
      const detail = (payload as ManusTaskStoppedEvent).task_detail;
      const { task_id, task_title, task_url, message, attachments, stop_reason } = detail;

      logger.info(`Manus task stopped: ${task_id} — reason: ${stop_reason}`);

      // Update credit record
      if (creditDb) {
        const record = creditDb.getRecordByManusId(task_id);
        if (record) {
          // Fetch actual credit usage from the API
          const taskDetail = manusClient ? await manusClient.getTask(task_id) : null;
          creditDb.updateTaskCompletion(record.task_id, {
            status: stop_reason === 'finish' ? 'completed' : 'completed',
            actualCredits: taskDetail?.credit_usage ?? undefined,
            outcome: message?.slice(0, 500),
          });
        }
      }

      if (!router) break;

      const ctx = manusClient?.getTaskContext(task_id);
      const department = ctx?.department || 'engineering';

      if (stop_reason === 'finish') {
        // ─── TASK COMPLETE — post full result ───
        await postTaskResult(router, {
          task_id,
          task_title,
          task_url,
          message,
          attachments,
          department,
          ctx,
        });

        // Clean up context
        manusClient?.removeTaskContext(task_id);

      } else if (stop_reason === 'ask') {
        // ─── TASK NEEDS USER INPUT ───
        await postTaskQuestion(router, approvalService, {
          task_id,
          task_title,
          task_url,
          message,
          department,
          ctx,
        });
      }

      break;
    }

    default:
      logger.warn(`Unknown Manus webhook event type: ${(payload as any).event_type}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST TASK RESULT to Discord
// ─────────────────────────────────────────────────────────────────────────────

async function postTaskResult(
  router: ReturnType<typeof getChannelRouter>,
  params: {
    task_id: string;
    task_title: string;
    task_url: string;
    message: string;
    attachments: Array<{ file_name: string; url: string; size_bytes: number }>;
    department: string;
    ctx?: any;
  },
): Promise<void> {
  if (!router) return;

  const { task_id, task_title, task_url, message, attachments, department, ctx } = params;

  // Truncate long messages for Discord (max 4096 chars in description)
  const truncated = message.length > 3800
    ? message.slice(0, 3800) + `\n\n*[Result truncated — [view full output](${task_url})]*`
    : message;

  const resultEmbed = new EmbedBuilder()
    .setColor(BRAND_COLORS.success)
    .setTitle(`✅ Task Complete: ${task_title.slice(0, 200)}`)
    .setDescription(truncated || '*No text output — see attachments or task URL.*')
    .addFields(
      { name: 'Task ID', value: `\`${task_id}\``, inline: true },
      { name: 'Department', value: department.charAt(0).toUpperCase() + department.slice(1), inline: true },
    );

  if (ctx?.userTag) {
    resultEmbed.addFields({ name: 'Requested by', value: ctx.userTag, inline: true });
  }

  if (attachments.length > 0) {
    const attachmentList = attachments
      .map(a => `• [${a.file_name}](${a.url}) (${formatBytes(a.size_bytes)})`)
      .join('\n');
    resultEmbed.addFields({ name: `📎 Attachments (${attachments.length})`, value: attachmentList });
  }

  resultEmbed
    .addFields({ name: '🔗 Full Output', value: `[View in Manus](${task_url})` })
    .setFooter({ text: '🐾 Make It Legend — Powered by Manus AI' })
    .setTimestamp();

  // Route to the department channel
  const channelName = getDepartmentChannel(department);
  await router.sendEmbed(channelName, resultEmbed);

  // If we have the specific channel ID from Discord context, also try to send there
  // (in case the task was run from a different channel than the department default)
  if (ctx?.channelId) {
    try {
      // We'll use routeDepartmentUpdate which maps to the right channel
      // The department channel IS the right place — this is intentional
    } catch { /* non-critical */ }
  }

  logger.info(`Task result posted to #${channelName}: ${task_id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST TASK QUESTION (stop_reason: "ask") to Discord
// ─────────────────────────────────────────────────────────────────────────────

async function postTaskQuestion(
  router: ReturnType<typeof getChannelRouter>,
  approvalService: ApprovalService,
  params: {
    task_id: string;
    task_title: string;
    task_url: string;
    message: string;
    department: string;
    ctx?: any;
  },
): Promise<void> {
  if (!router) return;

  const { task_id, task_title, task_url, message, department, ctx } = params;

  const questionEmbed = new EmbedBuilder()
    .setColor(BRAND_COLORS.warning)
    .setTitle(`❓ Manus Needs Your Input: ${task_title.slice(0, 150)}`)
    .setDescription(message.slice(0, 3800))
    .addFields(
      { name: 'Task ID', value: `\`${task_id}\``, inline: true },
      { name: 'Department', value: department, inline: true },
    )
    .addFields({
      name: '↩️ How to Reply',
      value: `Use \`/reply ${task_id} <your answer>\` to continue this task.\nOr [view in Manus](${task_url}) to respond there.`,
    })
    .setFooter({ text: '🐾 Make It Legend — Manus is waiting for input' })
    .setTimestamp();

  const channelName = getDepartmentChannel(department);
  await router.sendEmbed(channelName, questionEmbed);

  // Also create an approval request so it shows up in the approvals flow
  await approvalService.createApproval({
    title: `Manus Input Required: ${task_title.slice(0, 100)}`,
    description: message.slice(0, 500),
    department,
    requestedBy: 'Manus Agent',
    metadata: { taskId: task_id, task_url, stop_reason: 'ask' },
    callbackUrl: `https://web-production-2dac0.up.railway.app/api/manus-reply/${task_id}`,
  });

  logger.info(`Task question posted to #${channelName}: ${task_id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function getDepartmentChannel(department: string): ChannelName {
  const map: Record<string, ChannelName> = {
    engineering: 'eng-general',
    creative: 'creative-general',
    marketing: 'mkt-general',
    operations: 'ops-orders',
    analytics: 'analytics-dashboard',
  };
  return map[department.toLowerCase()] || 'announcements';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
