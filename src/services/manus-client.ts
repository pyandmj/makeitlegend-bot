import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { CreditDatabase } from './credit-database';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('manus-client');

// ─────────────────────────────────────────────────────────
// Types — Manus Open API
// ─────────────────────────────────────────────────────────

export type AgentProfile = 'manus-1.6' | 'manus-1.6-lite' | 'manus-1.6-max';
export type TaskMode = 'chat' | 'adaptive' | 'agent';
export type ManusTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** POST /v1/tasks — request body */
export interface ManusTaskRequest {
  prompt: string;
  agentProfile?: AgentProfile;
  taskMode?: TaskMode;
  attachments?: ManusAttachment[];
  connectors?: string[];
  hideInTaskList?: boolean;
  createShareableLink?: boolean;
  taskId?: string;          // for multi-turn continuation
  locale?: string;
  projectId?: string;
  interactiveMode?: boolean;
}

export type ManusAttachment =
  | { type: 'file_id'; fileId: string }
  | { type: 'url'; url: string }
  | { type: 'base64'; data: string; mimeType: string; fileName?: string };

/** POST /v1/tasks — response */
export interface ManusTaskResponse {
  task_id: string;
  task_title: string;
  task_url: string;
  share_url?: string;
}

/** GET /v1/tasks/{id} — response */
export interface ManusTaskDetail {
  id: string;
  object: string;
  created_at: string;
  updated_at: string;
  status: ManusTaskStatus;
  error?: string;
  incomplete_details?: string;
  instructions?: string;
  max_output_tokens?: number;
  model: string;
  metadata: {
    task_title: string;
    task_url: string;
    [key: string]: unknown;
  };
  output: ManusOutputMessage[];
  locale?: string;
  credit_usage?: number;
}

export interface ManusOutputMessage {
  id: string;
  status: string;
  role: 'user' | 'assistant';
  type: string;
  content?: ManusContentItem[];
}

export interface ManusContentItem {
  type: 'output_text';
  text?: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
}

/** GET /v1/tasks — paginated list response */
export interface ManusTaskListResponse {
  data: ManusTaskDetail[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

// ─── Webhook event types (inbound from Manus) ───

export interface ManusWebhookEvent {
  event_id: string;
  event_type: 'task_created' | 'task_progress' | 'task_stopped';
}

export interface ManusTaskCreatedEvent extends ManusWebhookEvent {
  event_type: 'task_created';
  task_detail: {
    task_id: string;
    task_title: string;
    task_url: string;
  };
}

export interface ManusTaskProgressEvent extends ManusWebhookEvent {
  event_type: 'task_progress';
  progress_detail: {
    task_id: string;
    progress_type: 'plan_update';
    message: string;
  };
}

export interface ManusTaskStoppedEvent extends ManusWebhookEvent {
  event_type: 'task_stopped';
  task_detail: {
    task_id: string;
    task_title: string;
    task_url: string;
    message: string;
    attachments: Array<{
      file_name: string;
      url: string;
      size_bytes: number;
    }>;
    stop_reason: 'finish' | 'ask';
  };
}

export type ManusWebhookPayload =
  | ManusTaskCreatedEvent
  | ManusTaskProgressEvent
  | ManusTaskStoppedEvent;

// ─── Discord context stored per task ───

export interface TaskDiscordContext {
  internalTaskId: string;
  manusTaskId: string;
  department: string;
  channelId: string;
  userId: string;
  userTag: string;
  agent: string;
  priority: string;
  promptSummary: string;
  createdAt: number;
}

// ─── Fail-fast types ───

export interface FailFastResult {
  blocked: boolean;
  reason?: string;
  existingError?: {
    errorCode: string;
    errorMessage: string;
    occurrenceCount: number;
    firstSeen: string;
  };
  creditsSaved?: number;
}

// ─── Error classification ───

const HARD_ERROR_CODES = new Set([
  '20001', '50001', '50013', '40001', '40003',
  '10001', '10004', '403', '401',
  'ENOTFOUND', 'INVALID_API_KEY', 'ACCOUNT_SUSPENDED',
  'QUOTA_EXCEEDED', 'FEATURE_NOT_AVAILABLE', 'PERMISSION_DENIED',
]);

const TRANSIENT_ERROR_CODES = new Set([
  '429', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'RATE_LIMITED', '500', '502', '503', '504',
]);

// ─── Department prompt context ───

const DEPARTMENT_CONTEXT: Record<string, string> = {
  engineering: `You are working as an engineering agent for Make It Legend (AI Pet Portraits). Focus on code quality, bug fixes, infrastructure, and technical implementation. Be precise and provide code snippets, file paths, and actionable steps.`,
  creative: `You are working as a creative agent for Make It Legend (AI Pet Portraits). Focus on visual design, content creation, social media posts, copywriting, and brand voice. Be creative, on-brand, and deliver ready-to-use content.`,
  marketing: `You are working as a marketing agent for Make It Legend (AI Pet Portraits). Focus on growth strategy, SEO, ad copy, campaign planning, and analytics insights. Provide data-driven recommendations.`,
  operations: `You are working as an operations agent for Make It Legend (AI Pet Portraits). Focus on customer support, order management, process optimization, and operational efficiency. Be thorough and customer-focused.`,
  analytics: `You are working as an analytics agent for Make It Legend (AI Pet Portraits). Focus on data analysis, metrics tracking, reporting, and actionable insights. Provide clear visualizations and recommendations.`,
  prime: '', // Prime has its own context in the prompt — no department prefix needed
};

// ─────────────────────────────────────────────────────────
// ManusClient — Full API integration
// ─────────────────────────────────────────────────────────

export class ManusClient {
  private apiKey: string;
  private baseUrl: string;
  private creditDb: CreditDatabase;
  private maxRetries: number;

  /** Maps manus_task_id → Discord context for routing webhook results */
  private taskContextMap: Map<string, TaskDiscordContext> = new Map();

  /** Cached RSA public key for webhook signature verification */
  private cachedPublicKey: string | null = null;
  private publicKeyFetchedAt: number = 0;
  private readonly PUBLIC_KEY_TTL_MS = 3600_000; // 1 hour

  /** Registered webhook ID (so we can clean up) */
  private webhookId: string | null = null;

  constructor(
    apiKey: string,
    creditDb: CreditDatabase,
    options?: { baseUrl?: string; maxRetries?: number },
  ) {
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl || 'https://api.manus.ai';
    this.creditDb = creditDb;
    this.maxRetries = options?.maxRetries || 2;
    logger.info('ManusClient initialized', { baseUrl: this.baseUrl });
  }

  // ═══════════════════════════════════════════════════════
  //  TASK CONTEXT MAP — links Manus tasks to Discord
  // ═══════════════════════════════════════════════════════

  /** Store Discord context so webhooks can route results back. */
  storeTaskContext(ctx: TaskDiscordContext): void {
    this.taskContextMap.set(ctx.manusTaskId, ctx);
    logger.debug(`Stored task context: ${ctx.manusTaskId} → #${ctx.department} (${ctx.userTag})`);
  }

  /** Retrieve Discord context for a Manus task ID. */
  getTaskContext(manusTaskId: string): TaskDiscordContext | undefined {
    return this.taskContextMap.get(manusTaskId);
  }

  /** Remove context after task is fully handled. */
  removeTaskContext(manusTaskId: string): void {
    this.taskContextMap.delete(manusTaskId);
  }

  /** Get all active task contexts (for status commands). */
  getActiveTaskContexts(): TaskDiscordContext[] {
    return Array.from(this.taskContextMap.values());
  }

  // ═══════════════════════════════════════════════════════
  //  CREATE TASK — with credit tracking & fail-fast
  // ═══════════════════════════════════════════════════════

  async createTask(params: {
    department: string;
    agent?: string;
    operation: string;
    request: ManusTaskRequest;
    estimatedCredits?: number;
    parentTaskId?: string;
    discordContext?: {
      channelId: string;
      userId: string;
      userTag: string;
      priority: string;
    };
  }): Promise<{
    success: boolean;
    taskResponse?: ManusTaskResponse;
    creditRecord: ReturnType<CreditDatabase['getRecord']>;
    failFast?: FailFastResult;
    error?: string;
  }> {
    const internalTaskId = uuidv4().slice(0, 12);
    const isRetry = !!params.parentTaskId;

    // ─── STEP 1: Fail-Fast Check ───
    const failFastResult = this.checkFailFast(
      params.operation, params.department, isRetry, params.parentTaskId,
    );
    if (failFastResult.blocked) {
      const record = this.creditDb.recordTaskCreation({
        taskId: internalTaskId,
        department: params.department,
        agent: params.agent,
        operation: params.operation,
        promptSummary: params.request.prompt,
        estimatedCredits: params.estimatedCredits,
        isRetry,
        parentTaskId: params.parentTaskId,
      });

      this.creditDb.updateTaskCompletion(internalTaskId, {
        status: 'blocked',
        isWaste: false,
        wasteReason: `Blocked by fail-fast: ${failFastResult.reason}`,
        creditsSaved: failFastResult.creditsSaved || params.estimatedCredits || 1.0,
      });

      logger.warn(`FAIL-FAST BLOCKED: ${params.operation} in ${params.department} — ${failFastResult.reason}`);

      return {
        success: false,
        creditRecord: this.creditDb.getRecord(internalTaskId),
        failFast: failFastResult,
        error: `Blocked by fail-fast enforcement: ${failFastResult.reason}`,
      };
    }

    // ─── STEP 2: Record the task creation ───
    this.creditDb.recordTaskCreation({
      taskId: internalTaskId,
      department: params.department,
      agent: params.agent,
      operation: params.operation,
      promptSummary: params.request.prompt,
      estimatedCredits: params.estimatedCredits,
      isRetry,
      parentTaskId: params.parentTaskId,
    });

    // ─── STEP 3: Build the enriched prompt ───
    const enrichedRequest = this.buildEnrichedRequest(params.department, params.request);

    // ─── STEP 4: Call the Manus API ───
    try {
      const response = await this.callCreateTask(enrichedRequest);

      // Update credit record with Manus task ID
      this.creditDb.updateTaskCompletion(internalTaskId, {
        status: 'completed',
        actualCredits: params.estimatedCredits || 1.0,
        outcome: `Task created: ${response.task_id}`,
      });

      // Link manus_task_id in the database
      const db = (this.creditDb as any).db;
      if (db?.prepare) {
        db.prepare('UPDATE credit_records SET manus_task_id = ?, status = ? WHERE task_id = ?')
          .run(response.task_id, 'running', internalTaskId);
      }

      // Store Discord context for webhook routing
      if (params.discordContext) {
        this.storeTaskContext({
          internalTaskId,
          manusTaskId: response.task_id,
          department: params.department,
          channelId: params.discordContext.channelId,
          userId: params.discordContext.userId,
          userTag: params.discordContext.userTag,
          agent: params.agent || 'manus-agent',
          priority: params.discordContext.priority,
          promptSummary: params.request.prompt.slice(0, 200),
          createdAt: Date.now(),
        });
      }

      logger.info(`Manus task created: ${response.task_id} (internal: ${internalTaskId})`);

      return {
        success: true,
        taskResponse: response,
        creditRecord: this.creditDb.getRecord(internalTaskId),
      };
    } catch (error: any) {
      const errorCode = this.extractErrorCode(error);
      const errorMessage = error.message || String(error);
      const isHardError = this.isHardError(errorCode);

      if (isHardError) {
        this.creditDb.recordHardError(errorCode, errorMessage, params.operation, params.department);
      }

      const isWaste = isHardError ||
        (isRetry && this.creditDb.getRecentRetryCount(params.operation, params.department) > this.maxRetries);

      this.creditDb.updateTaskCompletion(internalTaskId, {
        status: 'failed',
        actualCredits: params.estimatedCredits || 1.0,
        errorCode,
        errorMessage,
        isWaste,
        wasteReason: isHardError
          ? `Hard error (${errorCode}): should never have been attempted`
          : isWaste
            ? `Exceeded max retries (${this.maxRetries}) for ${params.operation}`
            : undefined,
      });

      logger.error(`Manus task failed: ${errorCode} — ${errorMessage}`, {
        taskId: internalTaskId, operation: params.operation, isHardError, isWaste,
      });

      return {
        success: false,
        creditRecord: this.creditDb.getRecord(internalTaskId),
        error: errorMessage,
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  GET TASK — retrieve full task detail + output
  // ═══════════════════════════════════════════════════════

  async getTask(taskId: string): Promise<ManusTaskDetail | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/tasks/${taskId}`, {
        headers: { 'API_KEY': this.apiKey },
      });
      if (!response.ok) {
        logger.warn(`getTask ${taskId}: HTTP ${response.status}`);
        return null;
      }
      return await response.json() as ManusTaskDetail;
    } catch (error) {
      logger.error(`getTask ${taskId} failed`, { error });
      return null;
    }
  }

  /**
   * Extracts the final assistant text output from a completed task.
   * Concatenates all assistant output_text content items.
   */
  extractTaskOutput(task: ManusTaskDetail): {
    text: string;
    files: Array<{ fileName: string; fileUrl: string; mimeType: string }>;
  } {
    const textParts: string[] = [];
    const files: Array<{ fileName: string; fileUrl: string; mimeType: string }> = [];

    for (const msg of task.output) {
      if (msg.role !== 'assistant' || !msg.content) continue;
      for (const item of msg.content) {
        if (item.text) textParts.push(item.text);
        if (item.fileUrl && item.fileName) {
          files.push({
            fileName: item.fileName,
            fileUrl: item.fileUrl,
            mimeType: item.mimeType || 'application/octet-stream',
          });
        }
      }
    }

    return { text: textParts.join('\n\n'), files };
  }

  // ═══════════════════════════════════════════════════════
  //  LIST TASKS — paginated
  // ═══════════════════════════════════════════════════════

  async listTasks(options?: {
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<ManusTaskListResponse | null> {
    try {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.after) params.set('after', options.after);
      if (options?.before) params.set('before', options.before);

      const url = `${this.baseUrl}/v1/tasks${params.toString() ? '?' + params.toString() : ''}`;
      const response = await fetch(url, {
        headers: { 'API_KEY': this.apiKey },
      });

      if (!response.ok) {
        logger.warn(`listTasks: HTTP ${response.status}`);
        return null;
      }
      return await response.json() as ManusTaskListResponse;
    } catch (error) {
      logger.error('listTasks failed', { error });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  CONTINUE TASK — multi-turn (reply to "ask" events)
  // ═══════════════════════════════════════════════════════

  async continueTask(taskId: string, userReply: string): Promise<ManusTaskResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'API_KEY': this.apiKey,
        },
        body: JSON.stringify({
          prompt: userReply,
          taskId,  // continues the existing task
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`continueTask ${taskId}: HTTP ${response.status} — ${errorBody}`);
        return null;
      }

      return await response.json() as ManusTaskResponse;
    } catch (error) {
      logger.error(`continueTask ${taskId} failed`, { error });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  DELETE TASK
  // ═══════════════════════════════════════════════════════

  async deleteTask(taskId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'API_KEY': this.apiKey },
      });
      return response.ok || response.status === 204;
    } catch (error) {
      logger.error(`deleteTask ${taskId} failed`, { error });
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  WEBHOOKS — register, delete, verify signatures
  // ═══════════════════════════════════════════════════════

  async registerWebhook(webhookUrl: string): Promise<{ webhook_id: string } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/webhooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'API_KEY': this.apiKey,
        },
        body: JSON.stringify({ webhook: { url: webhookUrl } }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`registerWebhook: HTTP ${response.status} — ${errorBody}`);
        return null;
      }

      const data = await response.json() as { webhook_id: string };
      this.webhookId = data.webhook_id;
      logger.info(`Webhook registered: ${data.webhook_id} → ${webhookUrl}`);
      return data;
    } catch (error) {
      logger.error('registerWebhook failed', { error });
      return null;
    }
  }

  async deleteWebhook(webhookId?: string): Promise<boolean> {
    const id = webhookId || this.webhookId;
    if (!id) return false;

    try {
      const response = await fetch(`${this.baseUrl}/v1/webhooks/${id}`, {
        method: 'DELETE',
        headers: { 'API_KEY': this.apiKey },
      });
      if (response.ok || response.status === 204) {
        if (id === this.webhookId) this.webhookId = null;
        logger.info(`Webhook deleted: ${id}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error(`deleteWebhook ${id} failed`, { error });
      return false;
    }
  }

  /** Fetch and cache the Manus webhook public key for signature verification. */
  async getWebhookPublicKey(): Promise<string | null> {
    const now = Date.now();
    if (this.cachedPublicKey && (now - this.publicKeyFetchedAt) < this.PUBLIC_KEY_TTL_MS) {
      return this.cachedPublicKey;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/webhook/public_key`, {
        headers: { 'API_KEY': this.apiKey },
      });

      if (!response.ok) {
        logger.error(`getWebhookPublicKey: HTTP ${response.status}`);
        return this.cachedPublicKey; // return stale key if available
      }

      const data = await response.json() as { public_key: string; algorithm: string };
      this.cachedPublicKey = data.public_key;
      this.publicKeyFetchedAt = now;
      logger.info('Webhook public key refreshed');
      return this.cachedPublicKey;
    } catch (error) {
      logger.error('getWebhookPublicKey failed', { error });
      return this.cachedPublicKey;
    }
  }

  /**
   * Verify an incoming Manus webhook request signature.
   * Returns true if the signature is valid, false otherwise.
   *
   * Headers expected:
   *   X-Webhook-Signature: base64-encoded RSA signature
   *   X-Webhook-Timestamp: unix timestamp string
   */
  async verifyWebhookSignature(
    url: string,
    body: Buffer | string,
    signature: string,
    timestamp: string,
  ): Promise<boolean> {
    try {
      // 1. Check timestamp freshness (5 minute window)
      const requestTime = parseInt(timestamp, 10);
      const currentTime = Math.floor(Date.now() / 1000);
      if (Math.abs(currentTime - requestTime) > 300) {
        logger.warn(`Webhook timestamp too old: ${requestTime} (current: ${currentTime})`);
        return false;
      }

      // 2. Get the public key
      const publicKeyPem = await this.getWebhookPublicKey();
      if (!publicKeyPem) {
        logger.error('No public key available for webhook verification');
        return false;
      }

      // 3. Reconstruct the signed content
      const bodyBuffer = typeof body === 'string' ? Buffer.from(body) : body;
      const bodyHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
      const signatureContent = `${timestamp}.${url}.${bodyHash}`;

      // 4. Hash the content (this is what was actually signed)
      const contentHash = crypto.createHash('sha256').update(signatureContent).digest();

      // 5. Verify the RSA signature
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(contentHash);
      const signatureBuffer = Buffer.from(signature, 'base64');

      return verifier.verify(publicKeyPem, signatureBuffer);
    } catch (error) {
      logger.error('Webhook signature verification error', { error });
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  FILES — upload files for task attachments
  // ═══════════════════════════════════════════════════════

  async uploadFile(
    filePath: string,
    fileName: string,
    mimeType: string,
  ): Promise<{ file_id: string } | null> {
    try {
      const fs = await import('fs');
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: mimeType });

      const formData = new FormData();
      formData.append('file', blob, fileName);

      const response = await fetch(`${this.baseUrl}/v1/files`, {
        method: 'POST',
        headers: { 'API_KEY': this.apiKey },
        body: formData,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`uploadFile: HTTP ${response.status} — ${errorBody}`);
        return null;
      }

      return await response.json() as { file_id: string };
    } catch (error) {
      logger.error('uploadFile failed', { error });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  POLLING FALLBACK — for when webhooks are unreliable
  // ═══════════════════════════════════════════════════════

  /**
   * Poll a task until it reaches a terminal state.
   * Use this as a fallback when webhooks don't fire.
   *
   * @param taskId  Manus task ID
   * @param options Polling configuration
   * @returns Final task detail, or null on timeout
   */
  async pollTaskUntilDone(
    taskId: string,
    options?: {
      intervalMs?: number;
      timeoutMs?: number;
      onProgress?: (task: ManusTaskDetail) => void;
    },
  ): Promise<ManusTaskDetail | null> {
    const interval = options?.intervalMs || 5_000;
    const timeout = options?.timeoutMs || 600_000; // 10 minutes default
    const startTime = Date.now();

    logger.info(`Polling task ${taskId} (interval: ${interval}ms, timeout: ${timeout}ms)`);

    while (Date.now() - startTime < timeout) {
      const task = await this.getTask(taskId);
      if (!task) {
        logger.warn(`pollTaskUntilDone: task ${taskId} not found`);
        await this.sleep(interval);
        continue;
      }

      if (options?.onProgress) {
        options.onProgress(task);
      }

      if (task.status === 'completed' || task.status === 'failed') {
        logger.info(`Task ${taskId} reached terminal state: ${task.status} (${Date.now() - startTime}ms)`);
        return task;
      }

      await this.sleep(interval);
    }

    logger.warn(`pollTaskUntilDone: timeout for task ${taskId}`);
    return null;
  }

  // ═══════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════

  /** Build an enriched request with department context. */
  private buildEnrichedRequest(department: string, request: ManusTaskRequest): ManusTaskRequest {
    const context = DEPARTMENT_CONTEXT[department.toLowerCase()];
    if (!context) return request;

    return {
      ...request,
      prompt: `${context}\n\n---\n\nTASK:\n${request.prompt}`,
    };
  }

  /** POST /v1/tasks */
  private async callCreateTask(request: ManusTaskRequest): Promise<ManusTaskResponse> {
    const url = `${this.baseUrl}/v1/tasks`;

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      agentProfile: request.agentProfile || 'manus-1.6',
    };

    if (request.taskMode) body.taskMode = request.taskMode;
    if (request.attachments) body.attachments = request.attachments;
    if (request.connectors) body.connectors = request.connectors;
    if (request.hideInTaskList !== undefined) body.hideInTaskList = request.hideInTaskList;
    if (request.createShareableLink !== undefined) body.createShareableLink = request.createShareableLink;
    if (request.taskId) body.taskId = request.taskId;
    if (request.locale) body.locale = request.locale;
    if (request.projectId) body.projectId = request.projectId;
    if (request.interactiveMode !== undefined) body.interactiveMode = request.interactiveMode;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API_KEY': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorData: any;
      try { errorData = JSON.parse(errorBody); } catch { errorData = { message: errorBody }; }

      const error = new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
      (error as any).statusCode = response.status;
      (error as any).code = String(response.status);
      (error as any).responseBody = errorData;
      throw error;
    }

    return await response.json() as ManusTaskResponse;
  }

  /** Fail-fast enforcement check. */
  private checkFailFast(
    operation: string, department: string, isRetry: boolean, parentTaskId?: string,
  ): FailFastResult {
    const hardError = this.creditDb.hasHardErrorForOperation(operation);
    if (hardError) {
      return {
        blocked: true,
        reason: `Hard error previously recorded for "${operation}": ${hardError.error_code} — ${hardError.error_message} (seen ${hardError.occurrence_count}× since ${hardError.first_seen})`,
        existingError: {
          errorCode: hardError.error_code,
          errorMessage: hardError.error_message,
          occurrenceCount: hardError.occurrence_count,
          firstSeen: hardError.first_seen,
        },
        creditsSaved: 1.0,
      };
    }

    if (isRetry && parentTaskId) {
      const retryCount = this.creditDb.getRecentRetryCount(operation, department, 60);
      if (retryCount >= this.maxRetries) {
        return {
          blocked: true,
          reason: `Retry limit exceeded (${retryCount}/${this.maxRetries}) for "${operation}" in ${department}.`,
          creditsSaved: 1.0,
        };
      }
    }

    return { blocked: false };
  }

  private isHardError(errorCode: string): boolean {
    if (HARD_ERROR_CODES.has(errorCode)) return true;
    if (TRANSIENT_ERROR_CODES.has(errorCode)) return false;
    const code = parseInt(errorCode, 10);
    if (!isNaN(code) && code >= 400 && code < 500 && code !== 429) return true;
    return false;
  }

  private extractErrorCode(error: any): string {
    if (error.code) return String(error.code);
    if (error.statusCode) return String(error.statusCode);
    if (error.response?.status) return String(error.response.status);
    if (error.message?.includes('ENOTFOUND')) return 'ENOTFOUND';
    if (error.message?.includes('ECONNREFUSED')) return 'ECONNREFUSED';
    if (error.message?.includes('ETIMEDOUT')) return 'ETIMEDOUT';
    return 'UNKNOWN';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
