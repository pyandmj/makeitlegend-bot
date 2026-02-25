import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { ChannelName } from '../types';
import { store } from '../utils/store';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('channel-router');

/**
 * Service responsible for routing messages to the correct Discord channels.
 * Acts as the central message dispatcher for all bot communications.
 */
export class ChannelRouter {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Sends an embed to a named channel.
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
      // Discord allows max 10 embeds per message
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
   * Sends a text message to a named channel.
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
   * Routes a department update to the correct general channel.
   */
  async routeDepartmentUpdate(department: string, embed: EmbedBuilder): Promise<string | null> {
    const channelMap: Record<string, ChannelName> = {
      engineering: 'eng-general',
      creative: 'creative-general',
      marketing: 'mkt-general',
      operations: 'ops-orders',
      analytics: 'analytics-dashboard',
    };

    const channelName = channelMap[department.toLowerCase()];
    if (!channelName) {
      logger.warn(`Unknown department for routing: ${department}`);
      return null;
    }

    return this.sendEmbed(channelName, embed);
  }
}
