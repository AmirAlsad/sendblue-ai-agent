import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import type { AgentMetrics } from '../metrics/registry.js';

export type BufferHandler = (
  conversationKey: string,
  options?: { traceId?: string }
) => Promise<void>;

export type BufferScheduler = {
  setHandler(handler: BufferHandler): void;
  schedule(conversationKey: string, delayMs: number, options?: { traceId?: string }): Promise<void>;
  cancel(conversationKey: string): Promise<void>;
  close(): Promise<void>;
  /** Implementation kind for /ready introspection. */
  kind: 'in_memory' | 'bullmq';
  /** Returns counts for the buffer queue. Implementations may approximate. */
  getStats?(): Promise<BufferSchedulerStats>;
};

export type BufferSchedulerStats = {
  active?: number;
  waiting?: number;
  delayed?: number;
  failed?: number;
  /** Locally-pending timers (in_memory only). */
  pending?: number;
};

export class InMemoryBufferScheduler implements BufferScheduler {
  readonly kind = 'in_memory' as const;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingTraceIds = new Map<string, string>();
  private handler: BufferHandler | undefined;

  constructor(private readonly metrics?: AgentMetrics) {}

  async getStats(): Promise<BufferSchedulerStats> {
    return { pending: this.timers.size };
  }

  setHandler(handler: BufferHandler): void {
    this.handler = handler;
  }

  async schedule(
    conversationKey: string,
    delayMs: number,
    options?: { traceId?: string }
  ): Promise<void> {
    await this.cancel(conversationKey);
    if (!this.handler) throw new Error('Buffer scheduler handler not configured');

    if (options?.traceId) this.pendingTraceIds.set(conversationKey, options.traceId);
    this.metrics?.bufferJobsTotal.inc({ event: 'scheduled' });

    if (delayMs <= 0) {
      const traceId = this.pendingTraceIds.get(conversationKey);
      this.pendingTraceIds.delete(conversationKey);
      this.metrics?.bufferJobsTotal.inc({ event: 'fired' });
      await this.handler(conversationKey, traceId ? { traceId } : undefined);
      return;
    }

    const handle = setTimeout(() => {
      this.timers.delete(conversationKey);
      const traceId = this.pendingTraceIds.get(conversationKey);
      this.pendingTraceIds.delete(conversationKey);
      this.metrics?.bufferJobsTotal.inc({ event: 'fired' });
      this.handler?.(conversationKey, traceId ? { traceId } : undefined).catch(() => {
        this.metrics?.bufferJobsTotal.inc({ event: 'failed' });
      });
    }, delayMs);
    this.timers.set(conversationKey, handle);
  }

  async cancel(conversationKey: string): Promise<void> {
    const handle = this.timers.get(conversationKey);
    if (handle) {
      clearTimeout(handle);
      this.metrics?.bufferJobsTotal.inc({ event: 'cancelled' });
    }
    this.timers.delete(conversationKey);
    this.pendingTraceIds.delete(conversationKey);
  }

  async close(): Promise<void> {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.pendingTraceIds.clear();
  }
}

type BufferJobPayload = {
  conversationKey: string;
  traceId?: string;
};

export class BullMqBufferScheduler implements BufferScheduler {
  readonly kind = 'bullmq' as const;
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | undefined;
  private handler: BufferHandler | undefined;

  async getStats(): Promise<BufferSchedulerStats> {
    const counts = await this.queue.getJobCounts('active', 'waiting', 'delayed', 'failed');
    return {
      active: counts.active ?? 0,
      waiting: counts.waiting ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0
    };
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly logger?: pino.Logger,
    private readonly metrics?: AgentMetrics
  ) {
    this.connection = new Redis(config.redisUrl!, { maxRetriesPerRequest: null });
    this.queue = new Queue(config.bufferQueueName, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 1
      }
    });
  }

  setHandler(handler: BufferHandler): void {
    this.handler = handler;
    if (this.worker) return;

    this.worker = new Worker(
      this.config.bufferQueueName,
      async (job: Job<BufferJobPayload>) => {
        this.metrics?.bufferJobsTotal.inc({ event: 'fired' });
        const options = job.data.traceId ? { traceId: job.data.traceId } : undefined;
        await this.handler?.(job.data.conversationKey, options);
      },
      { connection: new Redis(this.config.redisUrl!, { maxRetriesPerRequest: null }), concurrency: 1 }
    );
    this.worker.on('failed', (job, error) => {
      this.metrics?.bufferJobsTotal.inc({ event: 'failed' });
      this.logger?.warn({ err: error, jobId: job?.id }, 'buffer timer job failed');
    });
  }

  async schedule(
    conversationKey: string,
    delayMs: number,
    options?: { traceId?: string }
  ): Promise<void> {
    await this.cancel(conversationKey);
    const payload: BufferJobPayload = { conversationKey };
    if (options?.traceId) payload.traceId = options.traceId;
    await this.queue.add('process-buffer', payload, {
      jobId: this.jobId(conversationKey),
      delay: delayMs
    });
    this.metrics?.bufferJobsTotal.inc({ event: 'scheduled' });
  }

  async cancel(conversationKey: string): Promise<void> {
    const job = await this.queue.getJob(this.jobId(conversationKey));
    if (job) {
      await job.remove();
      this.metrics?.bufferJobsTotal.inc({ event: 'cancelled' });
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }

  private jobId(conversationKey: string): string {
    return `buffer:${conversationKey}`;
  }
}
