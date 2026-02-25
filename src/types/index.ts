import { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';

// ─────────────────────────────────────────────────────────
// Slash Command Types
// ─────────────────────────────────────────────────────────

export interface SlashCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ─────────────────────────────────────────────────────────
// Approval System Types
// ─────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: string;
  title: string;
  description: string;
  department: string;
  requestedBy: string;
  requestedAt: Date;
  status: ApprovalStatus;
  messageId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
  resolvedAt?: Date;
  resolvedBy?: string;
  denyReason?: string;
}

// ─────────────────────────────────────────────────────────
// Task Types
// ─────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  department: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: Date;
  updatedAt: Date;
  assignedTo?: string;
  completedAt?: Date;
  result?: string;
}

// ─────────────────────────────────────────────────────────
// Department Status Types
// ─────────────────────────────────────────────────────────

export interface DepartmentStatus {
  name: string;
  status: 'active' | 'paused' | 'error';
  activeTasks: number;
  completedToday: number;
  failedToday: number;
  lastActivity: Date;
  health: 'healthy' | 'degraded' | 'down';
  alerts: number;
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'critical';
  uptime: string;
  departments: DepartmentStatus[];
  pendingApprovals: number;
  activeAlerts: number;
  lastBriefing: Date | null;
}

// ─────────────────────────────────────────────────────────
// Webhook Payload Types
// ─────────────────────────────────────────────────────────

export interface StripeWebhookPayload {
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      customer?: string;
      customer_email?: string;
      status?: string;
      metadata?: Record<string, string>;
      [key: string]: unknown;
    };
  };
}

export interface ManusWebhookPayload {
  event: string;
  taskId: string;
  department: string;
  status: string;
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface WebsiteWebhookPayload {
  event: string;
  data: {
    orderId?: string;
    portraitId?: string;
    customerId?: string;
    email?: string;
    petName?: string;
    style?: string;
    status?: string;
    error?: string;
    [key: string]: unknown;
  };
  timestamp: string;
}

// ─────────────────────────────────────────────────────────
// Briefing Types
// ─────────────────────────────────────────────────────────

export interface DailyBriefingData {
  date: string;
  revenue: {
    today: number;
    yesterday: number;
    mtd: number;
    target: number;
  };
  orders: {
    new: number;
    processing: number;
    completed: number;
    failed: number;
  };
  portraits: {
    generated: number;
    approved: number;
    rejected: number;
    avgGenerationTime: string;
  };
  marketing: {
    visitors: number;
    conversions: number;
    conversionRate: string;
    adSpend: number;
    roas: string;
  };
  engineering: {
    uptime: string;
    deployments: number;
    openBugs: number;
    resolvedBugs: number;
  };
  support: {
    newTickets: number;
    resolved: number;
    avgResponseTime: string;
    satisfaction: string;
  };
  alerts: {
    critical: number;
    warning: number;
    resolved: number;
  };
  pendingApprovals: number;
  topPriorities: string[];
}

// ─────────────────────────────────────────────────────────
// Alert Types
// ─────────────────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  department: string;
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
}

// ─────────────────────────────────────────────────────────
// Channel Routing
// ─────────────────────────────────────────────────────────

export type ChannelName =
  | 'ceo-briefing' | 'approvals' | 'announcements'
  | 'alerts-critical' | 'alerts-warning'
  | 'eng-general' | 'eng-deployments' | 'eng-bugs'
  | 'creative-general' | 'creative-portraits' | 'creative-content'
  | 'mkt-general' | 'mkt-campaigns' | 'mkt-analytics'
  | 'ops-orders' | 'ops-support' | 'ops-quality'
  | 'analytics-dashboard' | 'analytics-credits' | 'analytics-anomalies' | 'analytics-self-healing';
