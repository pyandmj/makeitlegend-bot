import { MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import { ApprovalService } from '../services/approval-service';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('event:reaction');

let approvalService: ApprovalService | null = null;

export function setApprovalService(service: ApprovalService): void {
  approvalService = service;
}

/**
 * Handles message reaction add events.
 * Routes approval reactions to the ApprovalService.
 */
export async function handleMessageReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  if (!approvalService) {
    logger.warn('Approval service not initialized');
    return;
  }

  try {
    await approvalService.handleReaction(reaction, user);
  } catch (error) {
    logger.error('Error handling reaction', { error });
  }
}
