import {
  Guild,
  ChannelType,
  PermissionFlagsBits,
  Role,
  CategoryChannel,
  TextChannel,
  OverwriteResolvable,
} from 'discord.js';
import { CHANNEL_STRUCTURE, ROLE_DEFINITIONS } from '../config';
import { store } from '../utils/store';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('server-setup');

/**
 * Service responsible for creating and managing the full Discord server
 * structure including categories, channels, and roles.
 */
export class ServerSetupService {
  private guild: Guild;
  private roles: Map<string, Role> = new Map();

  constructor(guild: Guild) {
    this.guild = guild;
  }

  /**
   * Runs the full server setup: roles first, then channels.
   * Idempotent — skips existing resources.
   */
  async setup(): Promise<void> {
    logger.info(`Starting server setup for guild: ${this.guild.name} (${this.guild.id})`);

    try {
      await this.createRoles();
      await this.createChannelStructure();
      logger.info('Server setup completed successfully');
    } catch (error) {
      logger.error('Server setup failed', { error });
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────
  // Role Management
  // ─────────────────────────────────────────────────────

  /**
   * Creates all defined roles if they don't already exist.
   */
  private async createRoles(): Promise<void> {
    logger.info('Creating roles...');

    for (const roleDef of ROLE_DEFINITIONS) {
      const existing = this.guild.roles.cache.find(r => r.name === roleDef.name);

      if (existing) {
        logger.info(`Role already exists: ${roleDef.name}`);
        this.roles.set(roleDef.name, existing);
        continue;
      }

      try {
        const permissions = this.getPermissionsForRole(roleDef.name);
        const role = await this.guild.roles.create({
          name: roleDef.name,
          color: roleDef.color,
          hoist: roleDef.hoist,
          mentionable: roleDef.mentionable,
          permissions,
          reason: 'Make It Legend server setup',
        });

        this.roles.set(roleDef.name, role);
        logger.info(`Created role: ${roleDef.name} (${role.id})`);
      } catch (error) {
        logger.error(`Failed to create role: ${roleDef.name}`, { error });
      }
    }
  }

  /**
   * Returns appropriate permissions for each role type.
   */
  private getPermissionsForRole(roleName: string): bigint[] {
    const base = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ];

    switch (roleName) {
      case 'Founder':
        return [PermissionFlagsBits.Administrator];

      case 'Manus Prime':
        return [
          ...base,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.MentionEveryone,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.UseExternalEmojis,
        ];

      case 'Engineering Director':
      case 'Creative Director':
      case 'Marketing Director':
      case 'Operations Director':
      case 'Analytics Director':
        return [
          ...base,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.UseExternalEmojis,
        ];

      case 'Worker Agent':
        return [
          ...base,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ];

      default:
        return base;
    }
  }

  // ─────────────────────────────────────────────────────
  // Channel Structure
  // ─────────────────────────────────────────────────────

  /**
   * Creates the full category and channel structure.
   */
  private async createChannelStructure(): Promise<void> {
    logger.info('Creating channel structure...');

    const founderRole = this.roles.get('Founder');
    const manusPrimeRole = this.roles.get('Manus Prime');
    const everyoneRole = this.guild.roles.everyone;

    for (const [categoryName, categoryDef] of Object.entries(CHANNEL_STRUCTURE)) {
      const fullCategoryName = `${categoryDef.emoji} ${categoryName}`;

      // Find or create category
      let category = this.guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === fullCategoryName
      ) as CategoryChannel | undefined;

      if (!category) {
        try {
          category = await this.guild.channels.create({
            name: fullCategoryName,
            type: ChannelType.GuildCategory,
            reason: 'Make It Legend server setup',
          });
          logger.info(`Created category: ${fullCategoryName}`);
        } catch (error) {
          logger.error(`Failed to create category: ${fullCategoryName}`, { error });
          continue;
        }
      } else {
        logger.info(`Category already exists: ${fullCategoryName}`);
      }

      // Create channels within the category
      for (const channelDef of categoryDef.channels) {
        const existing = this.guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.name === channelDef.name
        ) as TextChannel | undefined;

        if (existing) {
          logger.info(`Channel already exists: #${channelDef.name}`);
          store.setChannelId(channelDef.name, existing.id);
          continue;
        }

        try {
          // Build permission overwrites
          const permissionOverwrites: OverwriteResolvable[] = [];

          // For read-only channels, restrict @everyone from sending
          if (channelDef.readOnly) {
            permissionOverwrites.push({
              id: everyoneRole.id,
              deny: [PermissionFlagsBits.SendMessages],
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });

            // Allow Founder and Manus Prime to send
            if (founderRole) {
              permissionOverwrites.push({
                id: founderRole.id,
                allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
              });
            }
            if (manusPrimeRole) {
              permissionOverwrites.push({
                id: manusPrimeRole.id,
                allow: [PermissionFlagsBits.SendMessages],
              });
            }

            // Allow the relevant director to send in their department channels
            const directorRole = this.getDirectorRoleForCategory(categoryName);
            if (directorRole) {
              permissionOverwrites.push({
                id: directorRole.id,
                allow: [PermissionFlagsBits.SendMessages],
              });
            }
          }

          const channel = await this.guild.channels.create({
            name: channelDef.name,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: channelDef.topic,
            permissionOverwrites,
            reason: 'Make It Legend server setup',
          });

          store.setChannelId(channelDef.name, channel.id);
          logger.info(`Created channel: #${channelDef.name} (${channel.id})`);
        } catch (error) {
          logger.error(`Failed to create channel: #${channelDef.name}`, { error });
        }
      }
    }
  }

  /**
   * Maps a category name to its corresponding director role.
   */
  private getDirectorRoleForCategory(categoryName: string): Role | undefined {
    const mapping: Record<string, string> = {
      'ENGINEERING': 'Engineering Director',
      'CREATIVE': 'Creative Director',
      'MARKETING': 'Marketing Director',
      'OPERATIONS': 'Operations Director',
      'ANALYTICS': 'Analytics Director',
    };

    const roleName = mapping[categoryName];
    return roleName ? this.roles.get(roleName) : undefined;
  }
}
