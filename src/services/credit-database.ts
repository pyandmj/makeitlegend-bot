import Database from 'better-sqlite3';
import path from 'path';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('credit-db');

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface CreditRecord {
  id: number;
  task_id: string;
  manus_task_id: string | null;
  department: string;
  agent: string;
  operation: string;
  prompt_summary: string;
  estimated_credits: number;
  actual_credits: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  outcome: string | null;
  error_code: string | null;
  error_message: string | null;
  is_retry: boolean;
  retry_count: number;
  parent_task_id: string | null;
  is_waste: boolean;
  waste_reason: string | null;
  credits_saved: number;
  created_at: string;
  completed_at: string | null;
}

export interface HardErrorRecord {
  id: number;
  error_code: string;
  error_message: string;
  operation: string;
  department: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  is_permanent: boolean;
}

export interface DailySpendRecord {
  department: string;
  date: string;
  total_credits: number;
  successful_credits: number;
  wasted_credits: number;
  task_count: number;
  success_count: number;
  failure_count: number;
  blocked_count: number;
}

export interface AgentEfficiency {
  agent: string;
  department: string;
  total_credits: number;
  successful_outcomes: number;
  total_tasks: number;
  failed_tasks: number;
  waste_flags: number;
  efficiency_score: number;
  credits_saved: number;
}

// ─────────────────────────────────────────────────────────
// Database Class
// ─────────────────────────────────────────────────────────

export class CreditDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || path.resolve(__dirname, '../../data/credits.db');
    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
    logger.info(`Credit database initialized at ${resolvedPath}`);
  }

  /**
   * Creates all required tables and indexes.
   */
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        manus_task_id TEXT,
        department TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'manus-agent',
        operation TEXT NOT NULL,
        prompt_summary TEXT NOT NULL,
        estimated_credits REAL NOT NULL DEFAULT 1.0,
        actual_credits REAL NOT NULL DEFAULT 0.0,
        status TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT,
        error_code TEXT,
        error_message TEXT,
        is_retry INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        parent_task_id TEXT,
        is_waste INTEGER NOT NULL DEFAULT 0,
        waste_reason TEXT,
        credits_saved REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS hard_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        operation TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT 'unknown',
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        is_permanent INTEGER NOT NULL DEFAULT 1,
        UNIQUE(error_code, operation)
      );

      CREATE TABLE IF NOT EXISTS daily_spend_cache (
        department TEXT NOT NULL,
        date TEXT NOT NULL,
        total_credits REAL NOT NULL DEFAULT 0,
        successful_credits REAL NOT NULL DEFAULT 0,
        wasted_credits REAL NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (department, date)
      );

      CREATE INDEX IF NOT EXISTS idx_credit_records_department ON credit_records(department);
      CREATE INDEX IF NOT EXISTS idx_credit_records_agent ON credit_records(agent);
      CREATE INDEX IF NOT EXISTS idx_credit_records_status ON credit_records(status);
      CREATE INDEX IF NOT EXISTS idx_credit_records_created ON credit_records(created_at);
      CREATE INDEX IF NOT EXISTS idx_credit_records_waste ON credit_records(is_waste);
      CREATE INDEX IF NOT EXISTS idx_hard_errors_code_op ON hard_errors(error_code, operation);
    `);
  }

  // ─────────────────────────────────────────────────────
  // Credit Records
  // ─────────────────────────────────────────────────────

  /**
   * Records a new credit usage entry when a Manus task is created.
   */
  recordTaskCreation(params: {
    taskId: string;
    manusTaskId?: string;
    department: string;
    agent?: string;
    operation: string;
    promptSummary: string;
    estimatedCredits?: number;
    isRetry?: boolean;
    parentTaskId?: string;
  }): CreditRecord {
    const stmt = this.db.prepare(`
      INSERT INTO credit_records (
        task_id, manus_task_id, department, agent, operation,
        prompt_summary, estimated_credits, is_retry, parent_task_id, retry_count
      ) VALUES (
        @taskId, @manusTaskId, @department, @agent, @operation,
        @promptSummary, @estimatedCredits, @isRetry, @parentTaskId, @retryCount
      )
    `);

    // Count existing retries for this operation
    const retryCount = params.parentTaskId
      ? (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM credit_records WHERE parent_task_id = ? OR task_id = ?`
        ).get(params.parentTaskId, params.parentTaskId) as any)?.cnt || 0
      : 0;

    stmt.run({
      taskId: params.taskId,
      manusTaskId: params.manusTaskId || null,
      department: params.department,
      agent: params.agent || 'manus-agent',
      operation: params.operation,
      promptSummary: params.promptSummary.slice(0, 500),
      estimatedCredits: params.estimatedCredits || 1.0,
      isRetry: params.isRetry ? 1 : 0,
      parentTaskId: params.parentTaskId || null,
      retryCount,
    });

    logger.info(`Credit record created: ${params.taskId} [${params.department}/${params.operation}]`);
    return this.getRecord(params.taskId)!;
  }

  /**
   * Updates a credit record when a task completes or fails.
   */
  updateTaskCompletion(taskId: string, params: {
    status: 'completed' | 'failed' | 'blocked';
    actualCredits?: number;
    outcome?: string;
    errorCode?: string;
    errorMessage?: string;
    isWaste?: boolean;
    wasteReason?: string;
    creditsSaved?: number;
  }): CreditRecord | null {
    const stmt = this.db.prepare(`
      UPDATE credit_records SET
        status = @status,
        actual_credits = COALESCE(@actualCredits, actual_credits),
        outcome = @outcome,
        error_code = @errorCode,
        error_message = @errorMessage,
        is_waste = @isWaste,
        waste_reason = @wasteReason,
        credits_saved = @creditsSaved,
        completed_at = datetime('now')
      WHERE task_id = @taskId
    `);

    stmt.run({
      taskId,
      status: params.status,
      actualCredits: params.actualCredits ?? null,
      outcome: params.outcome || null,
      errorCode: params.errorCode || null,
      errorMessage: params.errorMessage || null,
      isWaste: params.isWaste ? 1 : 0,
      wasteReason: params.wasteReason || null,
      creditsSaved: params.creditsSaved || 0,
    });

    // Update daily spend cache
    const record = this.getRecord(taskId);
    if (record) {
      this.updateDailySpendCache(record);
    }

    return record;
  }

  /**
   * Gets a single credit record by task ID.
   */
  getRecord(taskId: string): CreditRecord | null {
    return this.db.prepare('SELECT * FROM credit_records WHERE task_id = ?').get(taskId) as CreditRecord | null;
  }

  /**
   * Gets a record by Manus task ID.
   */
  getRecordByManusId(manusTaskId: string): CreditRecord | null {
    return this.db.prepare('SELECT * FROM credit_records WHERE manus_task_id = ?').get(manusTaskId) as CreditRecord | null;
  }

  // ─────────────────────────────────────────────────────
  // Hard Error Tracking
  // ─────────────────────────────────────────────────────

  /**
   * Records a hard error that should never be retried.
   */
  recordHardError(errorCode: string, errorMessage: string, operation: string, department: string = 'unknown'): void {
    const stmt = this.db.prepare(`
      INSERT INTO hard_errors (error_code, error_message, operation, department)
      VALUES (@errorCode, @errorMessage, @operation, @department)
      ON CONFLICT(error_code, operation) DO UPDATE SET
        last_seen = datetime('now'),
        occurrence_count = occurrence_count + 1,
        error_message = @errorMessage
    `);

    stmt.run({ errorCode, errorMessage, operation, department });
    logger.warn(`Hard error recorded: ${errorCode} for operation ${operation}`);
  }

  /**
   * Checks if a hard error exists for a given operation.
   * Returns the error record if found, null otherwise.
   */
  checkHardError(errorCode: string, operation: string): HardErrorRecord | null {
    return this.db.prepare(
      'SELECT * FROM hard_errors WHERE error_code = ? AND operation = ? AND is_permanent = 1'
    ).get(errorCode, operation) as HardErrorRecord | null;
  }

  /**
   * Checks if any hard error exists for a given operation (regardless of code).
   */
  hasHardErrorForOperation(operation: string): HardErrorRecord | null {
    return this.db.prepare(
      'SELECT * FROM hard_errors WHERE operation = ? AND is_permanent = 1 ORDER BY last_seen DESC LIMIT 1'
    ).get(operation) as HardErrorRecord | null;
  }

  /**
   * Gets the retry count for a specific operation type in a department.
   */
  getRecentRetryCount(operation: string, department: string, windowMinutes: number = 60): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM credit_records
      WHERE operation = ? AND department = ? AND is_retry = 1
      AND created_at >= datetime('now', '-' || ? || ' minutes')
    `).get(operation, department, windowMinutes) as any;
    return result?.cnt || 0;
  }

  // ─────────────────────────────────────────────────────
  // Daily Spend Tracking
  // ─────────────────────────────────────────────────────

  private updateDailySpendCache(record: CreditRecord): void {
    const date = record.created_at.split('T')[0] || record.created_at.split(' ')[0];
    const credits = record.actual_credits || record.estimated_credits;

    this.db.prepare(`
      INSERT INTO daily_spend_cache (department, date, total_credits, successful_credits, wasted_credits, task_count, success_count, failure_count, blocked_count)
      VALUES (@dept, @date, @credits, @successCredits, @wasteCredits, 1, @isSuccess, @isFailure, @isBlocked)
      ON CONFLICT(department, date) DO UPDATE SET
        total_credits = total_credits + @credits,
        successful_credits = successful_credits + @successCredits,
        wasted_credits = wasted_credits + @wasteCredits,
        task_count = task_count + 1,
        success_count = success_count + @isSuccess,
        failure_count = failure_count + @isFailure,
        blocked_count = blocked_count + @isBlocked
    `).run({
      dept: record.department,
      date,
      credits,
      successCredits: record.status === 'completed' ? credits : 0,
      wasteCredits: record.is_waste ? credits : 0,
      isSuccess: record.status === 'completed' ? 1 : 0,
      isFailure: record.status === 'failed' ? 1 : 0,
      isBlocked: record.status === 'blocked' ? 1 : 0,
    });
  }

  // ─────────────────────────────────────────────────────
  // Reporting Queries
  // ─────────────────────────────────────────────────────

  /**
   * Gets today's credit usage summary by department.
   */
  getDailySpend(date?: string): DailySpendRecord[] {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.db.prepare(
      'SELECT * FROM daily_spend_cache WHERE date = ? ORDER BY total_credits DESC'
    ).all(targetDate) as DailySpendRecord[];
  }

  /**
   * Gets the 7-day average spend for a department.
   */
  get7DayAverage(department: string): number {
    const result = this.db.prepare(`
      SELECT AVG(total_credits) as avg_credits
      FROM daily_spend_cache
      WHERE department = ? AND date >= date('now', '-7 days')
    `).get(department) as any;
    return result?.avg_credits || 0;
  }

  /**
   * Gets weekly credit usage summary.
   */
  getWeeklySpend(): DailySpendRecord[] {
    return this.db.prepare(`
      SELECT
        department,
        'week' as date,
        SUM(total_credits) as total_credits,
        SUM(successful_credits) as successful_credits,
        SUM(wasted_credits) as wasted_credits,
        SUM(task_count) as task_count,
        SUM(success_count) as success_count,
        SUM(failure_count) as failure_count,
        SUM(blocked_count) as blocked_count
      FROM daily_spend_cache
      WHERE date >= date('now', '-7 days')
      GROUP BY department
      ORDER BY total_credits DESC
    `).all() as DailySpendRecord[];
  }

  /**
   * Gets agent-level efficiency data.
   */
  getAgentEfficiency(agent?: string, days: number = 7): AgentEfficiency[] {
    let query = `
      SELECT
        agent,
        department,
        SUM(COALESCE(actual_credits, estimated_credits)) as total_credits,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_outcomes,
        COUNT(*) as total_tasks,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
        SUM(CASE WHEN is_waste = 1 THEN 1 ELSE 0 END) as waste_flags,
        CASE
          WHEN SUM(COALESCE(actual_credits, estimated_credits)) > 0
          THEN ROUND(
            CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) /
            SUM(COALESCE(actual_credits, estimated_credits)) * 100, 1
          )
          ELSE 0
        END as efficiency_score,
        SUM(credits_saved) as credits_saved
      FROM credit_records
      WHERE created_at >= datetime('now', '-' || @days || ' days')
    `;

    if (agent) {
      query += ` AND agent = @agent`;
    }

    query += ` GROUP BY agent, department ORDER BY efficiency_score DESC`;

    return this.db.prepare(query).all({ days, agent: agent || null }) as AgentEfficiency[];
  }

  /**
   * Gets recent credit records for display.
   */
  getRecentRecords(limit: number = 20, department?: string): CreditRecord[] {
    let query = 'SELECT * FROM credit_records';
    if (department) {
      query += ' WHERE department = @department';
    }
    query += ' ORDER BY created_at DESC LIMIT @limit';
    return this.db.prepare(query).all({ limit, department: department || null }) as CreditRecord[];
  }

  /**
   * Gets all waste-flagged records for a time period.
   */
  getWasteRecords(days: number = 1): CreditRecord[] {
    return this.db.prepare(`
      SELECT * FROM credit_records
      WHERE is_waste = 1 AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `).all(days) as CreditRecord[];
  }

  /**
   * Gets total credits saved by the fail-fast system.
   */
  getTotalCreditsSaved(days: number = 30): number {
    const result = this.db.prepare(`
      SELECT SUM(credits_saved) as total
      FROM credit_records
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `).get(days) as any;
    return result?.total || 0;
  }

  /**
   * Gets a summary for the daily briefing.
   */
  getCreditBriefingSummary(): {
    todayTotal: number;
    todayWaste: number;
    todaySaved: number;
    todayTasks: number;
    todaySuccessRate: number;
    weeklyTotal: number;
    weeklyEfficiency: number;
    topWaster: string | null;
    topEfficient: string | null;
  } {
    const today = new Date().toISOString().split('T')[0];

    const todayStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(COALESCE(actual_credits, estimated_credits)), 0) as total,
        COALESCE(SUM(CASE WHEN is_waste = 1 THEN COALESCE(actual_credits, estimated_credits) ELSE 0 END), 0) as waste,
        COALESCE(SUM(credits_saved), 0) as saved,
        COUNT(*) as tasks,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1)
          ELSE 0
        END as success_rate
      FROM credit_records
      WHERE date(created_at) = ?
    `).get(today) as any;

    const weeklyStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(total_credits), 0) as total,
        CASE WHEN SUM(task_count) > 0
          THEN ROUND(CAST(SUM(success_count) AS REAL) / SUM(task_count) * 100, 1)
          ELSE 0
        END as efficiency
      FROM daily_spend_cache
      WHERE date >= date('now', '-7 days')
    `).get() as any;

    const topWaster = this.db.prepare(`
      SELECT agent FROM credit_records
      WHERE is_waste = 1 AND date(created_at) >= date('now', '-7 days')
      GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1
    `).get() as any;

    const topEfficient = this.db.prepare(`
      SELECT agent FROM credit_records
      WHERE status = 'completed' AND date(created_at) >= date('now', '-7 days')
      GROUP BY agent
      ORDER BY CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) DESC
      LIMIT 1
    `).get() as any;

    return {
      todayTotal: todayStats?.total || 0,
      todayWaste: todayStats?.waste || 0,
      todaySaved: todayStats?.saved || 0,
      todayTasks: todayStats?.tasks || 0,
      todaySuccessRate: todayStats?.success_rate || 0,
      weeklyTotal: weeklyStats?.total || 0,
      weeklyEfficiency: weeklyStats?.efficiency || 0,
      topWaster: topWaster?.agent || null,
      topEfficient: topEfficient?.agent || null,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    logger.info('Credit database closed');
  }
}
