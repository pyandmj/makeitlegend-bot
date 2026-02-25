import { ChannelRouter } from './channel-router';
import { CreditDatabase } from './credit-database';
import { CreditReporter } from './credit-reporter';
import { ManusClient } from './manus-client';
import { WasteDetector } from './waste-detector';

/**
 * Simple service registry to avoid circular dependencies.
 * Services register themselves here and other modules can look them up.
 */
let channelRouter: ChannelRouter | null = null;
let creditDb: CreditDatabase | null = null;
let creditReporter: CreditReporter | null = null;
let manusClient: ManusClient | null = null;
let wasteDetector: WasteDetector | null = null;

// ─── Channel Router ───
export function registerChannelRouter(router: ChannelRouter): void {
  channelRouter = router;
}
export function getChannelRouter(): ChannelRouter | null {
  return channelRouter;
}

// ─── Credit Database ───
export function registerCreditDb(db: CreditDatabase): void {
  creditDb = db;
}
export function getCreditDb(): CreditDatabase | null {
  return creditDb;
}

// ─── Credit Reporter ───
export function registerCreditReporter(reporter: CreditReporter): void {
  creditReporter = reporter;
}
export function getCreditReporter(): CreditReporter | null {
  return creditReporter;
}

// ─── Manus Client ───
export function registerManusClient(client: ManusClient): void {
  manusClient = client;
}
export function getManusClient(): ManusClient | null {
  return manusClient;
}

// ─── Waste Detector ───
export function registerWasteDetector(detector: WasteDetector): void {
  wasteDetector = detector;
}
export function getWasteDetector(): WasteDetector | null {
  return wasteDetector;
}
