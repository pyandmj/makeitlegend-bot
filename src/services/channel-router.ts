import { Client, TextChannel, EmbedBuilder, Webhook } from 'discord.js';
import { ChannelName } from '../types';
import { store } from '../utils/store';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('channel-router');

/**
 * Agent identity for webhook-based messaging.
 */
export interface AgentIdentity {
  name: string;
  role: string;
  avatarURL: string;
}

/**
 * All agent identities used in the system.
 */
export const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  'manus-prime': {
    name: 'Manus Prime',
    role: 'CEO & Coordinator',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/OHaDPdydzpXpzLZc.png',
  },
  'alex': {
    name: 'Alex',
    role: 'Engineering Director',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/zDWxjgLHXVMmTVCr.png',
  },
  'maya': {
    name: 'Maya',
    role: 'Creative Director',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/nJsSJOpZPdBNNgNY.png',
  },
  'sam': {
    name: 'Sam',
    role: 'Marketing Director',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/MdGXevetyMaDXKPa.png',
  },
  'jordan': {
    name: 'Jordan',
    role: 'Operations Director',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/WNrNgAOSJoqWNRbE.png',
  },
  'riley': {
    name: 'Riley',
    role: 'Analytics Director',
    avatarURL: 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663358711383/jOImPXAgnAtmNjMB.png',
  },
};

/**
 * Maps departments to their director agent identity key.
 */
const DEPARTMENT_AGENT_MAP: Record<string, string> = {
  engineering: 'alex',
  creative: 'maya',
  marketing: 'sam',
  operations: 'jordan',
  analytics: 'riley',
};

/**
 * Maps departments to their primary channel.
 */
const DEPARTMENT_CHANNEL_MAP: Record<string, ChannelName> = {
  engineering: 'eng-general',
  creative: 'creative-general',
  marketing: 'mkt-general',
  operations: 'ops-orders',
  analytics: 'analytics-dashboard',
};

/**
 * Service responsible for routing messages to the correct Discord channels.
 * Uses webhooks to send messages with different agent identities.
 */
export class ChannelRouter {
  private client: Client;
  private webhookCache: Map<string, Webhook> = new Map();

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Gets or creates a webhook for a channel, cached for reuse.
   */
  private async getOrCreateWebhook(channel: TextChannel): Promise<Webhook | null> {
    const cached = this.webhookCache.get(channel.id);
    if (cached) return cached;

    try {
      const webhooks = await channel.fetchWebhooks();
      let webhook = webhooks.find(wh => wh.name === 'MIL-Agent' && wh.token !== null);

      if (!webhook) {
        webhook = await channel.createWebhook({
          name: 'MIL-Agent',
          reason: 'Make It Legend agent identity system',
        });
      }

      this.webhookCache.set(channel.id, webhook);
      return webhook;
    } catch (error) {
      logger.error(`Failed to get/create webhook for #${channel.name}`, { error });
      return null;
    }
  }

  /**
   * Sends a plain text message as a specific agent identity via webhook.
   */
  async sendAsAgent(
    channelName: ChannelName,
    agentKey: string,
    content: string,
  ): Promise<string | null> {
    const channel = await this.getChannel(channelName);
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return null;
    }

    const identity = AGENT_IDENTITIES[agentKey];
    if (!identity) {
      logger.warn(`Unknown agent identity: ${agentKey}`);
      return null;
    }

    const webhook = await this.getOrCreateWebhook(channel);
    if (!webhook) {
      // Fallback to regular message
      return this.sendMessage(channelName, `**${identity.name} (${identity.role}):**\n${content}`);
    }

    try {
      const displayName = `${identity.name} — ${identity.role}`;
      const message = await webhook.send({
        content,
        username: displayName,
        avatarURL: identity.avatarURL,
      });

      logger.debug(`Sent as ${displayName} to #${channelName}: ${typeof message === 'string' ? message : message.id}`);
      return typeof message === 'string' ? message : message.id;
    } catch (error) {
      logger.error(`Failed to send as ${agentKey} to #${channelName}`, { error });
      // Fallback to regular message
      return this.sendMessage(channelName, `**${identity.name} (${identity.role}):**\n${content}`);
    }
  }

  /**
   * Sends a message as the department's director to the department's channel.
   */
  async sendAsDepartmentDirector(
    department: string,
    content: string,
  ): Promise<string | null> {
    const dept = department.toLowerCase();
    const channelName = DEPARTMENT_CHANNEL_MAP[dept];
    const agentKey = DEPARTMENT_AGENT_MAP[dept];

    if (!channelName || !agentKey) {
      logger.warn(`Unknown department: ${department}`);
      return null;
    }

    return this.sendAsAgent(channelName, agentKey, content);
  }

  /**
   * Sends a message as Manus Prime to any channel.
   */
  async sendAsPrime(channelName: ChannelName, content: string): Promise<string | null> {
    return this.sendAsAgent(channelName, 'manus-prime', content);
  }

  /**
   * Sends an embed to a named channel (legacy support).
   */
  async sendEmbed(channelName: ChannelName, embed: EmbedBuilder): Promise<string | null> {
    const channel = await this.getChannel(channelName);
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return null;
    }

    try {
      const message = await channel.send({ embeds: [embed] });
      logger.debug(`Sent embed to #${channelName}: ${message.id}`);
      return message.id;
    } catch (error) {
      logger.error(`Failed to send embed to #${channelName}`, { error });
      return null;
    }
  }

  /**
   * Sends multiple embeds to a named channel.
   */
  async sendEmbeds(channelName: ChannelName, embeds: EmbedBuilder[]): Promise<string | null> {
    const channel = await this.getChannel(channelName);
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return null;
    }

    try {
      const chunks: EmbedBuilder[][] = [];
      for (let i = 0; i < embeds.length; i += 10) {
        chunks.push(embeds.slice(i, i + 10));
      }

      let firstMessageId: string | null = null;
      for (const chunk of chunks) {
        const message = await channel.send({ embeds: chunk });
        if (!firstMessageId) firstMessageId = message.id;
      }

      logger.debug(`Sent ${embeds.length} embeds to #${channelName}`);
      return firstMessageId;
    } catch (error) {
      logger.error(`Failed to send embeds to #${channelName}`, { error });
      return null;
    }
  }

  /**
   * Sends a text message to a named channel (as the bot itself).
   */
  async sendMessage(channelName: ChannelName, content: string): Promise<string | null> {
    const channel = await this.getChannel(channelName);
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return null;
    }

    try {
      const message = await channel.send({ content });
      logger.debug(`Sent message to #${channelName}: ${message.id}`);
      return message.id;
    } catch (error) {
      logger.error(`Failed to send message to #${channelName}`, { error });
      return null;
    }
  }

  /**
   * Sends an embed with reaction options (used for approvals).
   */
  async sendWithReactions(
    channelName: ChannelName,
    embed: EmbedBuilder,
    reactions: string[]
  ): Promise<string | null> {
    const channel = await this.getChannel(channelName);
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return null;
    }

    try {
      const message = await channel.send({ embeds: [embed] });

      for (const reaction of reactions) {
        await message.react(reaction);
      }

      logger.debug(`Sent message with reactions to #${channelName}: ${message.id}`);
      return message.id;
    } catch (error) {
      logger.error(`Failed to send message with reactions to #${channelName}`, { error });
      return null;
    }
  }

  /**
   * Resolves a channel name to a TextChannel instance.
   */
  private async getChannel(name: string): Promise<TextChannel | null> {
    const channelId = store.getChannelId(name);
    if (!channelId) {
      logger.warn(`No channel ID mapped for: ${name}`);
      return null;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.warn(`Channel ${name} (${channelId}) is not a text channel`);
        return null;
      }
      return channel;
    } catch (error) {
      logger.error(`Failed to fetch channel: ${name} (${channelId})`, { error });
      return null;
    }
  }

  /**
   * Routes an alert to the appropriate alerts channel based on severity.
   */
  async routeAlert(severity: 'critical' | 'warning', embed: EmbedBuilder): Promise<string | null> {
    const channelName: ChannelName = severity === 'critical' ? 'alerts-critical' : 'alerts-warning';
    return this.sendEmbed(channelName, embed);
  }

  /**
   * Routes a department update as the department director (plain text).
   */
  async routeDepartmentUpdate(department: string, embed: EmbedBuilder): Promise<string | null> {
    const channelName = DEPARTMENT_CHANNEL_MAP[department.toLowerCase()];
    if (!channelName) {
      logger.warn(`Unknown department for routing: ${department}`);
      return null;
    }

    // For backward compatibility, still support embeds
    return this.sendEmbed(channelName, embed);
  }

  /**
   * Routes a department text update as the department director.
   */
  async routeDepartmentText(department: string, content: string): Promise<string | null> {
    return this.sendAsDepartmentDirector(department, content);
  }
}
