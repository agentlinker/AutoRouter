/**
 * 进程内活跃请求计数。选择与占用必须作为不可交错的操作完成，
 * 否则并发请求会同时选中看似空闲的 Key。
 * 计数属于本地运行态，不写数据库，进程重启后重新计数。
 */
export class ActiveRequestTracker {
  private readonly counts = new Map<string, number>();

  /** 原子地获取当前计数并 +1，返回占用前的值 */
  acquire(key: string): number {
    const current = this.counts.get(key) ?? 0;
    this.counts.set(key, current + 1);
    return current;
  }

  /** 释放一次占用；已在零时保持零，不产生负数 */
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** 获取所有 key 的当前活跃数快照 */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }
}

/** 全局单例，由 runtimeManager 持有并注入到执行路径 */
export const activeRequestTracker = new ActiveRequestTracker();
