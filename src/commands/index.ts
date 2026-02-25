import { Collection } from 'discord.js';
import { SlashCommand } from '../types';
import { briefingCommand } from './briefing';
import { approveCommand } from './approve';
import { denyCommand } from './deny';
import { statusCommand } from './status';
import { taskCommand } from './task';
import { pauseCommand } from './pause';
import { resumeCommand } from './resume';
import { reportCommand } from './report';
import { creditsCommand } from './credits';
import { replyCommand } from './reply';
import { tasksStatusCommand } from './tasks-status';

/**
 * Registry of all slash commands.
 * Add new commands here to register them with the bot.
 */
const commands = new Collection<string, SlashCommand>();

const allCommands: SlashCommand[] = [
  briefingCommand,
  approveCommand,
  denyCommand,
  statusCommand,
  taskCommand,
  pauseCommand,
  resumeCommand,
  reportCommand,
  creditsCommand,
  replyCommand,
  tasksStatusCommand,
];

for (const command of allCommands) {
  commands.set(command.data.name, command);
}

export { commands };

/**
 * Returns the raw command data for registration with Discord API.
 */
export function getCommandData() {
  return allCommands.map(cmd => cmd.data.toJSON());
}
