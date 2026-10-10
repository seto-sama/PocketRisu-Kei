export interface TaskResult<TData> {
  success: boolean;
  data?: TData;
  error?: Error;
}

export class TaskCanceledError extends Error {
  public readonly name = "TaskCanceledError";
}

/** Runs a batch with bounded concurrency and preserves result order. */
export class TaskConcurrencyLimiter {
  public taskQueueChangeCallback: ((queuedCount: number) => void) | null = null;
  private readonly maxConcurrentTasks: number;
  private readonly failFast: boolean;
  private queuedTaskCountValue = 0;

  public constructor(options: {
    maxConcurrentTasks?: number;
    failFast?: boolean;
  } = {}) {
    this.maxConcurrentTasks = Math.max(1, Math.floor(options.maxConcurrentTasks ?? 5));
    this.failFast = options.failFast ?? true;
  }

  public get queuedTaskCount(): number {
    return this.queuedTaskCountValue;
  }

  public async executeBatch<TData>(
    tasks: Array<() => Promise<TData>>
  ): Promise<{ results: TaskResult<TData>[] }> {
    const results = new Array<TaskResult<TData>>(tasks.length);
    let nextIndex = 0;
    let failed = false;
    this.queuedTaskCountValue = tasks.length;
    this.notifyQueueChange();

    const worker = async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex++;
        this.queuedTaskCountValue--;
        this.notifyQueueChange();

        if (failed && this.failFast) {
          results[index] = {
            success: false,
            error: new TaskCanceledError("Task canceled due to previous failure"),
          };
          continue;
        }

        try {
          results[index] = { success: true, data: await tasks[index]() };
        } catch (error) {
          results[index] = {
            success: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
          failed = true;
        }
      }
    };

    const workerCount = Math.min(this.maxConcurrentTasks, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return { results };
  }

  private notifyQueueChange(): void {
    this.taskQueueChangeCallback?.(this.queuedTaskCountValue);
  }
}
