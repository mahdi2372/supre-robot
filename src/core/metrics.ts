/**
 * In-process metrics: command counts, error accounting, ring buffer of
 * recent errors. Intentionally dependency-free; exposed via /status command
 * and the API status endpoint.
 */

export interface RecentError {
  code: string;
  module: string;
  at: Date;
}

const ERROR_WINDOW_MS = 30 * 60 * 1000;

export class Metrics {
  private readonly startedAt = Date.now();
  private commandCount = 0;
  private commandByModule = new Map<string, number>();
  private commandByName = new Map<string, number>();
  private errors: RecentError[] = [];
  private readonly recentErrorLimit = 100;

  recordCommand(moduleName: string, commandName: string): void {
    this.commandCount += 1;
    this.commandByModule.set(moduleName, (this.commandByModule.get(moduleName) ?? 0) + 1);
    this.commandByName.set(commandName, (this.commandByName.get(commandName) ?? 0) + 1);
  }

  recordError(moduleName: string, code: string): void {
    this.errors.push({ code, module: moduleName, at: new Date() });
    if (this.errors.length > this.recentErrorLimit) this.errors.shift();
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  errorsInLast30Min(): RecentError[] {
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    return this.errors.filter((e) => e.at.getTime() >= cutoff);
  }

  errorRatePerMinute(): number {
    return this.errorsInLast30Min().length / 30;
  }

  snapshot() {
    const recent = this.errors.slice(-10).map((e) => ({
      code: e.code,
      module: e.module,
      at: e.at.toISOString()
    }));
    return {
      total: this.errors.length,
      last30Min: this.errorsInLast30Min().length,
      ratePerMinute: Math.round(this.errorRatePerMinute() * 100) / 100,
      recent
    };
  }

  commandsSnapshot() {
    return {
      total: this.commandCount,
      byName: Object.fromEntries(
        [...this.commandByName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      )
    };
  }
}
