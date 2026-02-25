import { MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import { store } from '../utils/store';
import { createApprovalEmbed, createApprovalResultEmbed } from '../utils/embeds';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter } from './service-registry';
import { ApprovalRequest } from '../types';

const logger = createModuleLogger('approval-service');

/**
 * Service that manages the approval workflow.
 * Handles creating approval requests, watching for reactions,
 * and routing decisions back to the requesting systems.
 */
export class ApprovalService {

  /**
   * Creates a new approval request and posts it to #approvals.
   * Returns the created approval or null on failure.
   */
  async createApproval(data: {
    title: string;
    description: string;
    department: string;
    requestedBy: string;
    metadata?: Record<string, unknown>;
    callbackUrl?: string;
  }): Promise<ApprovalRequest | null> {
    const router = getChannelRouter();
    if (!router) {
      logger.error('Channel router not available');
      return null;
    }

    const approval = store.createApproval(data);
    const embed = createApprovalEmbed(approval);

    const messageId = await router.sendWithReactions('approvals', embed, ['✅', '❌']);

    if (messageId) {
      store.updateApproval(approval.id, {
        messageId,
        channelId: store.getChannelId('approvals'),
      });
      logger.info(`Approval ${approval.id} posted to #approvals (message: ${messageId})`);
    } else {
      logger.error(`Failed to post approval ${approval.id} to #approvals`);
    }

    return approval;
  }

  /**
   * Handles a reaction on a message — checks if it's an approval reaction.
   */
  async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Fetch partial data if needed
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        logger.error('Failed to fetch partial reaction', { error });
        return;
      }
    }

    const emoji = reaction.emoji.name;
    if (emoji !== '✅' && emoji !== '❌') return;

    const messageId = reaction.message.id;
    const approval = store.getApprovalByMessageId(messageId);

    if (!approval) return;
    if (approval.status !== 'pending') return;

    const isApproved = emoji === '✅';
    const fullUser = user.partial ? await user.fetch() : user;

    store.updateApproval(approval.id, {
      status: isApproved ? 'approved' : 'denied',
      resolvedAt: new Date(),
      resolvedBy: fullUser.tag,
    });

    const updatedApproval = store.getApproval(approval.id)!;
    const resultEmbed = createApprovalResultEmbed(updatedApproval);

    // Reply in the same channel
    try {
      const message = reaction.message;
      if (message.channel && 'send' in message.channel) {
        await (message.channel as any).send({ embeds: [resultEmbed] });
      }
    } catch (error) {
      logger.error('Failed to send approval result', { error });
    }

    logger.info(`Approval ${approval.id} ${isApproved ? 'approved' : 'denied'} via reaction by ${fullUser.tag}`);

    // Send callback if configured
    if (approval.callbackUrl) {
      try {
        await fetch(approval.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approvalId: approval.id,
            status: isApproved ? 'approved' : 'denied',
            resolvedBy: fullUser.tag,
            resolvedAt: new Date().toISOString(),
          }),
        });
        logger.info(`Callback sent for approval ${approval.id}`);
      } catch (error) {
        logger.error(`Failed to send callback for approval ${approval.id}`, { error });
      }
    }
  }
}
