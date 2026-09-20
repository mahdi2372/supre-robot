import type { Logger } from '../logging/logger.js';
import type { ModuleContext, ModuleStatus, SupreCommand, SupreModule } from './module.js';

/**
 * Loads and boots modules in dependency order, isolating failures: a broken
 * module is marked `failed` (and its commands withheld) without taking down
 * the rest of the platform.
 */
export class ModuleManager {
  private readonly modules = new Map<string, SupreModule>();
  private readonly status = new Map<string, ModuleStatus>();
  private readonly failures = new Map<string, string>();
  private started = false;

  constructor(private readonly ctx: ModuleContext, private readonly logger: Logger) {}

  register(module: SupreModule): void {
    if (this.modules.has(module.name)) {
      throw new Error(`module '${module.name}' registered twice`);
    }
    this.modules.set(module.name, module);
    this.status.set(module.name, 'registered');
  }

  statusOf(name: string): ModuleStatus {
    return this.status.get(name) ?? 'registered';
  }

  isReady(name: string): boolean {
    return this.status.get(name) === 'ready';
  }

  snapshot(): Record<string, { status: string; version: string }> {
    const out: Record<string, { status: string; version: string }> = {};
    for (const [name, mod] of this.modules) {
      out[name] = { status: this.status.get(name) ?? 'registered', version: mod.version };
    }
    return out;
  }

  /** All commands from modules that booted successfully. */
  commands(): SupreCommand[] {
    const out: SupreCommand[] = [];
    for (const [name, mod] of this.modules) {
      if (this.status.get(name) !== 'ready') continue;
      for (const cmd of mod.commands ?? []) {
        if (cmd.module !== name) throw new Error(`command '${cmd.name}' declares module '${cmd.module}' but was registered under '${name}'`);
        out.push(cmd);
      }
    }
    return out;
  }

  private order(): SupreModule[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: SupreModule[] = [];

    const visit = (mod: SupreModule, chain: string[]): void => {
      if (visited.has(mod.name)) return;
      if (visiting.has(mod.name)) {
        throw new Error(`module dependency cycle: ${[...chain, mod.name].join(' -> ')}`);
      }
      visiting.add(mod.name);
      for (const dep of mod.dependencies ?? []) {
        const depModule = this.modules.get(dep);
        if (!depModule) throw new Error(`module '${mod.name}' depends on unknown module '${dep}'`);
        visit(depModule, [...chain, mod.name]);
      }
      visiting.delete(mod.name);
      visited.add(mod.name);
      ordered.push(mod);
    };

    for (const mod of this.modules.values()) visit(mod, []);
    return ordered;
  }

  async startup(): Promise<{ ready: string[]; failed: string[] }> {
    if (this.started) throw new Error('module manager already started');
    this.started = true;
    const ready: string[] = [];
    const failed: string[] = [];

    for (const mod of this.order()) {
      this.status.set(mod.name, 'registered');
      try {
        await mod.register?.(this.ctx);
        await mod.startup?.(this.ctx);
        this.status.set(mod.name, 'ready');
        ready.push(mod.name);
        this.logger.info({ module: mod.name, version: mod.version }, 'module ready');
      } catch (err) {
        this.status.set(mod.name, 'failed');
        const msg = err instanceof Error ? err.message : String(err);
        this.failures.set(mod.name, msg);
        failed.push(mod.name);
        this.logger.error(
          { err: { message: msg, name: err instanceof Error ? err.name : 'unknown', stack: err instanceof Error ? err.stack : undefined }, module: mod.name },
          'module failed to start — its commands are disabled'
        );
      }
    }

    if (failed.length > 0) {
      this.ctx.metrics.recordError('core', 'MODULE_STARTUP_FAILED');
    }
    return { ready, failed };
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Reverse order: dependents shut down before their dependencies.
    const ordered = this.order().reverse();
    for (const mod of ordered) {
      if (this.status.get(mod.name) !== 'ready') {
        this.status.set(mod.name, 'stopped');
        continue;
      }
      try {
        await mod.shutdown?.(this.ctx);
        this.logger.info({ module: mod.name }, 'module stopped');
      } catch (err) {
        this.logger.error({ err: { message: err instanceof Error ? err.message : String(err) }, module: mod.name }, 'module shutdown error');
      }
      this.status.set(mod.name, 'stopped');
    }
  }
}
