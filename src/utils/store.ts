import { v4 as uuidv4 } from 'uuid';
import { ApprovalRequest, Task, DepartmentStatus, Alert, SystemHealth, DailyBriefingData } from '../types';
import { DEPARTMENTS, Department } from '../config';
import { createModuleLogger } from './logger';

const logger = createModuleLogger('store');

/**
 * In-memory data store for the Make It Legend bot.
 * In production, this would be backed by a database (e.g., PostgreSQL, Redis).
 * This implementation provides the full interface so the bot is functional
 * and can be swapped out for a persistent store later.
 */
class Store {
  private approvals: Map<string, ApprovalRequest> = new Map();
  private tasks: Map<string, Task> = new Map();
  private alerts: Map<string, Alert> = new Map();
  private departmentStatuses: Map<string, DepartmentStatus> = new Map();
  private channelMap: Map<string, string> = new Map(); // channelName -> channelId
  private pausedDepartments: Set<string> = new Set();
  private lastBriefing: Date | null = null;
  private startTime: Date = new Date();

  constructor() {
    this.initializeDepartments();
  }

  /**
   * Initialize default department statuses.
   */
  private initializeDepartments(): void {
    for (const dept of DEPARTMENTS) {
      this.departmentStatuses.set(dept, {
        name: dept.charAt(0).toUpperCase() + dept.slice(1),
        status: 'active',
        activeTasks: 0,
        completedToday: 0,
        failedToday: 0,
        lastActivity: new Date(),
        health: 'healthy',
        alerts: 0,
      });
    }
  }

  // ─────────────────────────────────────────────────────
  // Channel Map
  // ─────────────────────────────────────────────────────

  setChannelId(name: string, id: string): void {
    this.channelMap.set(name, id);
  }

  getChannelId(name: string): string | undefined {
    return this.channelMap.get(name);
  }

  getAllChannelIds(): Map<string, string> {
    return new Map(this.channelMap);
  }

  // ─────────────────────────────────────────────────────
  // Approvals
  // ─────────────────────────────────────────────────────

  createApproval(data: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'status'>): ApprovalRequest {
    const approval: ApprovalRequest = {
      ...data,
      id: uuidv4().slice(0, 8),
      requestedAt: new Date(),
      status: 'pending',
    };
    this.approvals.set(approval.id, approval);
    logger.info(`Approval created: ${approval.id} — ${approval.title}`);
    return approval;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  getApprovalByMessageId(messageId: string): ApprovalRequest | undefined {
    for (const approval of this.approvals.values()) {
      if (approval.messageId === messageId) return approval;
    }
    return undefined;
  }

  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.approvals.values()).filter(a => a.status === 'pending');
  }

  updateApproval(id: string, updates: Partial<ApprovalRequest>): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval) return undefined;
    Object.assign(approval, updates);
    logger.info(`Approval updated: ${id} — status: ${approval.status}`);
    return approval;
  }

  // ─────────────────────────────────────────────────────
  // Tasks
  // ─────────────────────────────────────────────────────

  createTask(department: string, description: string, priority: Task['priority'] = 'medium'): Task {
    const task: Task = {
      id: uuidv4().slice(0, 8),
      department,
      description,
      status: 'pending',
      priority,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.set(task.id, task);

    // Update department stats
    const dept = this.departmentStatuses.get(department);
    if (dept) {
      dept.activeTasks++;
      dept.lastActivity = new Date();
    }

    logger.info(`Task created: ${task.id} — ${department} — ${description}`);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getTasksByDepartment(department: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.department === department);
  }

  updateTask(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: new Date() });

    if (updates.status === 'completed' || updates.status === 'failed') {
      const dept = this.departmentStatuses.get(task.department);
      if (dept) {
        dept.activeTasks = Math.max(0, dept.activeTasks - 1);
        if (updates.status === 'completed') dept.completedToday++;
        if (updates.status === 'failed') dept.failedToday++;
        dept.lastActivity = new Date();
      }
    }

    return task;
  }

  // ─────────────────────────────────────────────────────
  // Alerts
  // ─────────────────────────────────────────────────────

  createAlert(data: Omit<Alert, 'id' | 'timestamp' | 'resolved'>): Alert {
    const alert: Alert = {
      ...data,
      id: uuidv4().slice(0, 8),
      timestamp: new Date(),
      resolved: false,
    };
    this.alerts.set(alert.id, alert);

    const dept = this.departmentStatuses.get(data.department);
    if (dept) {
      dept.alerts++;
      if (data.severity === 'critical') dept.health = 'degraded';
    }

    logger.warn(`Alert created: ${alert.id} [${alert.severity}] — ${alert.title}`);
    return alert;
  }

  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(a => !a.resolved);
  }

  resolveAlert(id: string): Alert | undefined {
    const alert = this.alerts.get(id);
    if (!alert) return undefined;
    alert.resolved = true;
    alert.resolvedAt = new Date();

    const dept = this.departmentStatuses.get(alert.department);
    if (dept) {
      dept.alerts = Math.max(0, dept.alerts - 1);
      if (dept.alerts === 0) dept.health = 'healthy';
    }

    return alert;
  }

  // ─────────────────────────────────────────────────────
  // Departments
  // ─────────────────────────────────────────────────────

  getDepartmentStatus(name: string): DepartmentStatus | undefined {
    return this.departmentStatuses.get(name);
  }

  getAllDepartmentStatuses(): DepartmentStatus[] {
    return Array.from(this.departmentStatuses.values());
  }

  pauseDepartment(name: string): boolean {
    const dept = this.departmentStatuses.get(name);
    if (!dept) return false;
    dept.status = 'paused';
    this.pausedDepartments.add(name);
    logger.info(`Department paused: ${name}`);
    return true;
  }

  resumeDepartment(name: string): boolean {
    const dept = this.departmentStatuses.get(name);
    if (!dept) return false;
    dept.status = 'active';
    this.pausedDepartments.delete(name);
    logger.info(`Department resumed: ${name}`);
    return true;
  }

  isDepartmentPaused(name: string): boolean {
    return this.pausedDepartments.has(name);
  }

  // ─────────────────────────────────────────────────────
  // System Health
  // ─────────────────────────────────────────────────────

  getSystemHealth(): SystemHealth {
    const departments = this.getAllDepartmentStatuses();
    const activeAlerts = this.getActiveAlerts();
    const pendingApprovals = this.getPendingApprovals();

    const hasCritical = activeAlerts.some(a => a.severity === 'critical');
    const hasWarning = activeAlerts.some(a => a.severity === 'warning');
    const hasPausedDept = departments.some(d => d.status === 'paused');

    let overall: SystemHealth['overall'] = 'healthy';
    if (hasCritical) overall = 'critical';
    else if (hasWarning || hasPausedDept) overall = 'degraded';

    const uptimeMs = Date.now() - this.startTime.getTime();
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);

    return {
      overall,
      uptime: `${hours}h ${minutes}m`,
      departments,
      pendingApprovals: pendingApprovals.length,
      activeAlerts: activeAlerts.length,
      lastBriefing: this.lastBriefing,
    };
  }

  // ─────────────────────────────────────────────────────
  // Briefing
  // ─────────────────────────────────────────────────────

  setLastBriefing(date: Date): void {
    this.lastBriefing = date;
  }

  /**
   * Generates placeholder briefing data.
   * In production, this would aggregate real data from all systems.
   */
  generateBriefingData(): DailyBriefingData {
    const departments = this.getAllDepartmentStatuses();
    const alerts = this.getActiveAlerts();
    const pending = this.getPendingApprovals();

    return {
      date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      revenue: {
        today: this.revenueToday,
        yesterday: 0,
        mtd: this.revenueToday,
        target: 10000,
      },
      orders: {
        new: this.ordersNew,
        processing: 0,
        completed: this.ordersCompleted || departments.find(d => d.name.toLowerCase() === 'operations')?.completedToday || 0,
        failed: this.ordersFailed || departments.find(d => d.name.toLowerCase() === 'operations')?.failedToday || 0,
      },
      portraits: {
        generated: this.portraitsCompleted || departments.find(d => d.name.toLowerCase() === 'creative')?.completedToday || 0,
        approved: this.portraitsCompleted,
        rejected: this.portraitsFailed,
        avgGenerationTime: 'N/A',
      },
      marketing: {
        visitors: 0,
        conversions: 0,
        conversionRate: 'N/A',
        adSpend: 0,
        roas: 'N/A',
      },
      engineering: {
        uptime: '99.9%',
        deployments: 0,
        openBugs: departments.find(d => d.name.toLowerCase() === 'engineering')?.activeTasks || 0,
        resolvedBugs: departments.find(d => d.name.toLowerCase() === 'engineering')?.completedToday || 0,
      },
      support: {
        newTickets: 0,
        resolved: 0,
        avgResponseTime: 'N/A',
        satisfaction: 'N/A',
      },
      alerts: {
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
        resolved: Array.from(this.alerts.values()).filter(a => a.resolved).length,
      },
      pendingApprovals: pending.length,
      topPriorities: [
        'Connect Stripe webhook for live payment tracking',
        'Configure portrait generation pipeline',
        'Set up marketing analytics integration',
        'Review and approve pending agent requests',
      ],
    };
  }

  // ─────────────────────────────────────────────────────
  // Revenue & Order Tracking
  // ─────────────────────────────────────────────────────

  private revenueToday: number = 0;
  private ordersNew: number = 0;
  private ordersCompleted: number = 0;
  private ordersFailed: number = 0;
  private ordersRefunded: number = 0;
  private portraitsCompleted: number = 0;
  private portraitsFailed: number = 0;

  trackRevenue(amount: number): void {
    this.revenueToday += amount;
  }

  trackOrder(type: 'new' | 'completed' | 'failed' | 'refund'): void {
    switch (type) {
      case 'new': this.ordersNew++; break;
      case 'completed': this.ordersCompleted++; break;
      case 'failed': this.ordersFailed++; break;
      case 'refund': this.ordersRefunded++; break;
    }
  }

  trackPortrait(type: 'completed' | 'failed'): void {
    if (type === 'completed') this.portraitsCompleted++;
    if (type === 'failed') this.portraitsFailed++;
  }

  getRevenueToday(): number { return this.revenueToday; }
  getOrderStats(): { new: number; completed: number; failed: number; refunded: number } {
    return { new: this.ordersNew, completed: this.ordersCompleted, failed: this.ordersFailed, refunded: this.ordersRefunded };
  }
  getPortraitStats(): { completed: number; failed: number } {
    return { completed: this.portraitsCompleted, failed: this.portraitsFailed };
  }

  // ─────────────────────────────────────────────────────
  // Reset daily counters (called by scheduler)
  // ─────────────────────────────────────────────────────

  resetDailyCounters(): void {
    for (const dept of this.departmentStatuses.values()) {
      dept.completedToday = 0;
      dept.failedToday = 0;
    }
    this.revenueToday = 0;
    this.ordersNew = 0;
    this.ordersCompleted = 0;
    this.ordersFailed = 0;
    this.ordersRefunded = 0;
    this.portraitsCompleted = 0;
    this.portraitsFailed = 0;
    logger.info('Daily counters reset');
  }
}

/** Singleton store instance */
export const store = new Store();
