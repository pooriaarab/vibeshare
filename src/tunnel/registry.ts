/**
 * TunnelRegistry — named lookup + detect-cascade over TunnelProviders.
 *
 *   resolve('ngrok')     → that provider (throws if unknown / undetected)
 *   resolve()            → first provider whose detect() is true
 *   list() / available() → diagnostics for `vibeshare tunnels`
 */
import type { ProviderDeps, TunnelProvider } from './provider.js';
import { createDefaultProviders } from './providers/index.js';

export class TunnelRegistry {
  private readonly byName: Map<string, TunnelProvider>;
  private readonly order: string[];

  /**
   * @param providers Optional explicit list (preserves order). Defaults to
   *   the stock ~12-provider set.
   */
  constructor(providers?: readonly TunnelProvider[]) {
    const list = providers ? [...providers] : createDefaultProviders();
    this.byName = new Map();
    this.order = [];
    for (const p of list) {
      if (this.byName.has(p.name)) {
        throw new Error(`duplicate tunnel provider name: ${p.name}`);
      }
      this.byName.set(p.name, p);
      this.order.push(p.name);
    }
  }

  /** All registered providers in cascade order. */
  list(): TunnelProvider[] {
    return this.order.map((n) => this.byName.get(n)!);
  }

  /** Providers whose `detect()` currently returns true. */
  async available(): Promise<TunnelProvider[]> {
    const out: TunnelProvider[] = [];
    for (const p of this.list()) {
      if (await p.detect()) out.push(p);
    }
    return out;
  }

  /**
   * Pick a provider.
   *
   * - With `preferred`: that name must be registered and `detect()` true.
   * - Without: first provider in cascade order with `detect()` true.
   */
  async resolve(preferred?: string): Promise<TunnelProvider> {
    if (preferred !== undefined && preferred !== '') {
      const p = this.byName.get(preferred);
      if (!p) {
        const known = this.order.join(', ');
        throw new Error(`unknown tunnel provider "${preferred}" (known: ${known})`);
      }
      if (!(await p.detect())) {
        throw new Error(`tunnel provider "${preferred}" is not available on this machine`);
      }
      return p;
    }

    for (const p of this.list()) {
      if (await p.detect()) return p;
    }
    throw new Error('no tunnel provider available on this machine');
  }

  /** Lookup without detect() — useful for tests / help text. */
  get(name: string): TunnelProvider | undefined {
    return this.byName.get(name);
  }
}

/** Convenience: stock registry, optional shared ProviderDeps. */
export function createTunnelRegistry(deps?: ProviderDeps): TunnelRegistry {
  return new TunnelRegistry(createDefaultProviders(deps ?? {}));
}
