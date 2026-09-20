import type { Interaction } from 'discord.js';
import type { ComponentHandler } from './module.js';

/**
 * Registry for buttons / select menus.
 *
 * customIds use the format `<module>:<action>` — the module prefix is how
 * the interaction router attributes a component to the owning module and
 * enforces that module's enabled state.
 */
export class UiRegistry {
  private buttons = new Map<string, ComponentHandler>();
  private selects = new Map<string, ComponentHandler>();

  onButton(customId: string, handler: ComponentHandler): void {
    this.assertId(customId);
    this.buttons.set(customId, handler);
  }

  onSelect(customId: string, handler: ComponentHandler): void {
    this.assertId(customId);
    this.selects.set(customId, handler);
  }

  getButton(customId: string): { module: string; handler: ComponentHandler } | undefined {
    const handler = this.buttons.get(customId);
    if (!handler) return undefined;
    return { module: customId.split(':')[0]!, handler };
  }

  getSelect(customId: string): { module: string; handler: ComponentHandler } | undefined {
    const handler = this.selects.get(customId);
    if (!handler) return undefined;
    return { module: customId.split(':')[0]!, handler };
  }

  private assertId(customId: string): void {
    if (!/^[a-z0-9_-]+:[a-z0-9_.:-]*$/i.test(customId)) {
      throw new Error(`invalid component customId: ${customId} (expected 'module:action')`);
    }
  }
}

export type { Interaction };
