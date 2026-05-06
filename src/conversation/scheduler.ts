import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type pino from 'pino';
import type { AgentConfig } from '../config/env.js';

export type BufferHandler = (conversationKey: string) => Promise<void>;

export type BufferScheduler = {
  setHandler(handler: BufferHandler): void;
  schedule(conversationKey: string, delayMs: number): Promise<void>;
  cancel(conversationKey: string): Promise<void>;
  close(): Promise<void>;
};

export class InMemoryBufferScheduler implements BufferScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private handler: BufferHandler | undefined;

  setHandler(handler: BufferHandler): void {
    this.handler = handler;
  }

  async schedule(conversationKey: string, delayMs: number): Promise<void> {
    await this.cancel(conversationKey);
    if (!this.handler) throw new Error('Buffer scheduler handler not configured');

    if (delayMs <= 0) {
      await this.handler(conversationKey);
      return;
    }

    const handle = setTimeout(() => {
      this.timers.delete(conversationKey);
      this.handler?.(conversationKey).catch(() => {});
    }, delayMs);
    this.timers.set(conversationKey, handle);
  }

  async cancel(conversationKey: string): Promise<void> {
    const handle = this.timers.get(conversationKey);
    if (handle) clearTimeout(handle);
    this.timers.delete(conversationKey);
  }

  async close(): Promise<void> {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }
}

export class BullMqBufferScheduler implements BufferScheduler {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | undefined;
  private handler: BufferHandler | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly logger?: pino.Logger
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
      async (job: Job<{ conversationKey: string }>) => {
        await this.handler?.(job.data.conversationKey);
      },
      { connection: new Redis(this.config.redisUrl!, { maxRetriesPerRequest: null }), concurrency: 1 }
    );
    this.worker.on('failed', (job, error) => {
      this.logger?.warn({ err: error, jobId: job?.id }, 'buffer timer job failed');
    });
  }

  async schedule(conversationKey: string, delayMs: number): Promise<void> {
    await this.cancel(conversationKey);
    await this.queue.add(
      'process-buffer',
      { conversationKey },
      {
        jobId: this.jobId(conversationKey),
        delay: delayMs
      }
    );
  }

  async cancel(conversationKey: string): Promise<void> {
    const job = await this.queue.getJob(this.jobId(conversationKey));
    if (job) await job.remove();
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
