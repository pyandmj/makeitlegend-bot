import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  Guild,
  EmbedBuilder,
} from 'discord.js';
import { config } from './config';
import { logger } from './utils/logger';
import { store } from './utils/store';
import { BRAND_COLORS } from './utils/embeds';
import { ServerSetupService } from './services/server-setup';
import { ChannelRouter } from './services/channel-router';
import { ApprovalService } from './services/approval-service';
import { BriefingScheduler } from './services/briefing-scheduler';
import { CreditDatabase } from './services/credit-database';
import { ManusClient } from './services/manus-client';
import { WasteDetector } from './services/waste-detector';
import { CreditReporter } from './services/credit-reporter';
import {
  registerChannelRouter,
  registerCreditDb,
  registerCreditReporter,
  registerManusClient,
  registerWasteDetector,
} from './services/service-registry';
import { handleInteractionCreate } from './events/interaction-create';
import { handleMessageCreate } from './events/message-create';
import { handleMessageReactionAdd, setApprovalService } from './events/message-reaction';
import { createWebhookServer } from './webhooks/server';
import { deployCommands } from './deploy-commands';
import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────
// Services
// ─────────────────────────────────────────────────────────

let channelRouter: ChannelRouter;
let approvalService: ApprovalService;
let briefingScheduler: BriefingScheduler;
let creditDb: CreditDatabase;
let manusClient: ManusClient | null = null;
let wasteDetector: WasteDetector;
let creditReporter: CreditReporter;
let isSetupComplete = false;

// ─────────────────────────────────────────────────────────
// START WEBHOOK SERVER FIRST (so healthcheck passes)
// ─────────────────────────────────────────────────────────

const tempApprovalService = new ApprovalService();
const webhookApp = createWebhookServer(tempApprovalService);

const webhookServer = webhookApp.listen(config.webhook.port, '0.0.0.0', () => {
  logger.info(`Webhook server listening on port ${config.webhook.port}`);
  logger.info('Health endpoint available at /health');
});

// ─────────────────────────────────────────────────────────
// Initialize Core Services (runs once, before guild setup)
// ─────────────────────────────────────────────────────────

function initializeCoreServices(): void {
  // Credit Database (SQLite)
  const dbPath = path.resolve(__dirname, '../data/credits.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  creditDb = new CreditDatabase(dbPath);
  registerCreditDb(creditDb);
  logger.info('Credit database initialized');

  // Manus API Client (with fail-fast enforcement)
  if (config.manus.apiKey) {
    manusClient = new ManusClient(config.manus.apiKey, creditDb, { baseUrl: config.manus.baseUrl });
    registerManusClient(manusClient);
    logger.info('Manus API client initialized');

    // Register webhook with Manus so results post back automatically
    const publicUrl = config.webhook.publicUrl;
    if (publicUrl) {
      const webhookUrl = `${publicUrl}/webhooks/manus`;
      manusClient.registerWebhook(webhookUrl).then(result => {
        if (result) {
          logger.info(`Manus webhook registered: ${webhookUrl} (ID: ${result.webhook_id})`);
        } else {
          logger.warn(`Failed to register Manus webhook at ${webhookUrl} — will use polling fallback`);
        }
      }).catch(err => {
        logger.warn(`Manus webhook registration error: ${err.message} — will use polling fallback`);
      });
    } else {
      logger.warn('No WEBHOOK_PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN set — Manus webhooks disabled, using polling fallback');
    }
  } else {
    logger.warn('MANUS_API_KEY not set — Manus API integration disabled');
  }

  // Waste Detector
  wasteDetector = new WasteDetector(creditDb);
  registerWasteDetector(wasteDetector);
  wasteDetector.start();
  logger.info('Waste detector started');

  // Credit Reporter
  creditReporter = new CreditReporter(creditDb);
  registerCreditReporter(creditReporter);
  creditReporter.start();
  logger.info('Credit reporter scheduled');
}

// ─────────────────────────────────────────────────────────
// Helper: Save guild ID to .env
// ─────────────────────────────────────────────────────────

function saveGuildIdToEnv(guildId: string): void {
  const envPath = path.resolve(__dirname, '../.env');
  try {
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }

    if (envContent.includes('DISCORD_GUILD_ID=')) {
      envContent = envContent.replace(/DISCORD_GUILD_ID=.*/, `DISCORD_GUILD_ID=${guildId}`);
    } else {
      envContent += `\nDISCORD_GUILD_ID=${guildId}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    logger.info(`Saved DISCORD_GUILD_ID=${guildId} to .env`);
  } catch (error) {
    logger.error('Failed to save guild ID to .env', { error });
  }
}

// ─────────────────────────────────────────────────────────
// Core: Setup a guild with all channels, roles, commands
// ─────────────────────────────────────────────────────────

async function setupGuild(guild: Guild): Promise<void> {
  if (isSetupComplete) {
    logger.info(`Setup already complete, skipping for guild ${guild.name}`);
    return;
  }

  logger.info(`Setting up guild: ${guild.name} (${guild.id})`);

  try {
    // Save guild ID
    saveGuildIdToEnv(guild.id);

    // Step 1: Set up channels and roles
    const setupService = new ServerSetupService(guild);
    await setupService.setup();

    // Step 2: Initialize Discord-dependent services
    channelRouter = new ChannelRouter(client);
    registerChannelRouter(channelRouter);

    approvalService = new ApprovalService();
    setApprovalService(approvalService);

    briefingScheduler = new BriefingScheduler();
    briefingScheduler.start();

    // Step 3: Deploy slash commands
    await deployCommands(guild.id);

    // Step 4: Create invite link
    const inviteLink = await createInviteLink(guild);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🐾 Make It Legend HQ is LIVE!`);
    logger.info(`Guild: ${guild.name} (${guild.id})`);
    logger.info(`Invite Link: ${inviteLink}`);
    logger.info(`Webhook Server: http://localhost:${config.webhook.port}`);
    logger.info(`Credit Monitor: Active (SQLite + Waste Detection + Fail-Fast)`);
    logger.info(`Manus API: ${manusClient ? 'Connected' : 'Not configured'}`);
    logger.info(`${'='.repeat(60)}\n`);

    // Save invite link to a file
    const invitePath = path.resolve(__dirname, '../INVITE_LINK.txt');
    fs.writeFileSync(invitePath, `Make It Legend HQ — Server Invite Link\n\n${inviteLink}\n\nGuild ID: ${guild.id}\n`);

    // Step 5: Send welcome message to #announcements
    const welcomeEmbed = new EmbedBuilder()
      .setColor(BRAND_COLORS.gold)
      .setTitle('🐾 Make It Legend HQ — Online!')
      .setDescription(
        'The command center is now operational. All systems are initialized and ready.\n\n' +
        '**Available Commands:**\n' +
        '`/briefing` — Get daily status briefing\n' +
        '`/status` — System health overview\n' +
        '`/task [dept] [desc]` — Create a new task\n' +
        '`/approve [id]` — Approve a request\n' +
        '`/deny [id] [reason]` — Deny a request\n' +
        '`/pause [dept]` — Pause a department\n' +
        '`/resume [dept]` — Resume a department\n' +
        '`/report [dept]` — Get department report\n' +
        '`/credits daily` — Today\'s credit usage\n' +
        '`/credits weekly` — Weekly efficiency report\n' +
        '`/credits agent [name]` — Agent usage history\n\n' +
        '**Webhook Endpoints:**\n' +
        `\`POST /webhooks/stripe\` — Stripe events\n` +
        `\`POST /webhooks/manus\` — Manus API events\n` +
        `\`POST /webhooks/website\` — Website events\n` +
        `\`POST /api/alert\` — Create alerts\n` +
        `\`POST /api/approval\` — Request approvals\n` +
        `\`GET /api/credits/summary\` — Credit usage summary\n\n` +
        '**Credit Monitoring:**\n' +
        '🛡️ Fail-Fast enforcement active\n' +
        '📊 Waste detection running (5-min intervals)\n' +
        '📈 Daily/weekly credit reports scheduled\n'
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Make It Legend — AI Pet Portraits' });

    await channelRouter.sendEmbed('announcements', welcomeEmbed);

    // Send initial briefing
    await briefingScheduler.sendDailyBriefing();

    isSetupComplete = true;
    logger.info('Guild setup completed successfully!');

  } catch (error) {
    logger.error('Failed during guild setup', { error });
  }
}

// ─────────────────────────────────────────────────────────
// Helper: Create invite link
// ─────────────────────────────────────────────────────────

async function createInviteLink(guild: Guild): Promise<string> {
  try {
    const textChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText
    );

    if (!textChannel) {
      logger.warn('No text channel found for invite');
      return 'No invite link available';
    }

    const invite = await (textChannel as any).createInvite({
      maxAge: 0,
      maxUses: 0,
      unique: true,
      reason: 'Founder invite link',
    });

    logger.info(`Created invite link: ${invite.url}`);
    return invite.url;
  } catch (error) {
    logger.error('Failed to create invite link', { error });
    return 'Failed to create invite link';
  }
}

// ─────────────────────────────────────────────────────────
// Create Discord Client
// ─────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
});

// ─────────────────────────────────────────────────────────
// Bot Ready Event
// ─────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Bot logged in as ${readyClient.user.tag}`);
  logger.info(`Serving ${readyClient.guilds.cache.size} guild(s)`);

  // Initialize core services (credit DB, Manus client, etc.)
  initializeCoreServices();

  // If bot is already in a guild, set it up
  if (readyClient.guilds.cache.size > 0) {
    const guildId = config.discord.guildId;
    let guild: Guild | undefined;

    if (guildId && guildId.length > 0) {
      guild = readyClient.guilds.cache.get(guildId);
    }

    if (!guild) {
      guild = readyClient.guilds.cache.first();
    }

    if (guild) {
      await setupGuild(guild);
    }
  } else {
    logger.info('Bot is not in any guilds yet.');
    logger.info(`Invite the bot using: https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=8&integration_type=0&scope=bot+applications.commands`);
    logger.info('The bot will automatically set up the server when invited.');

    // Still initialize basic services for webhook server
    channelRouter = new ChannelRouter(client);
    registerChannelRouter(channelRouter);
    approvalService = new ApprovalService();
    setApprovalService(approvalService);
  }
});

// ─────────────────────────────────────────────────────────
// Guild Create Event (bot joins a new server)
// ─────────────────────────────────────────────────────────

client.on(Events.GuildCreate, async (guild: Guild) => {
  logger.info(`Bot joined guild: ${guild.name} (${guild.id})`);
  await setupGuild(guild);
});

// ─────────────────────────────────────────────────────────
// Event Handlers
// ─────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, handleInteractionCreate);
client.on(Events.MessageReactionAdd, handleMessageReactionAdd);
client.on(Events.MessageCreate, handleMessageCreate);

client.on(Events.Error, (error) => {
  logger.error('Discord client error', { error });
});

client.on(Events.Warn, (message) => {
  logger.warn('Discord client warning', { message });
});

// ─────────────────────────────────────────────────────────
// Login to Discord (non-fatal if token is missing)
// ─────────────────────────────────────────────────────────

logger.info('Starting Make It Legend bot...');

if (config.discord.token) {
  client.login(config.discord.token).catch((error) => {
    logger.error('Failed to login to Discord', { error });
    logger.warn('Bot running in webhook-only mode — Discord features disabled');
  });
} else {
  logger.warn('DISCORD_BOT_TOKEN not set — running in webhook-only mode');
}

// ─────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  briefingScheduler?.stop();
  wasteDetector?.stop();
  creditReporter?.stop();
  creditDb?.close();
  webhookServer?.close();
  client.destroy();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise: String(promise) });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error });
  // Don't exit — keep webhook server running
  logger.warn('Continuing despite uncaught exception to keep webhook server alive');
});
