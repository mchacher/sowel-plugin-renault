/**
 * Per-car memory of what Renault refused (`forbidden` / `notFound`), so the
 * plugin stops asking. Transient errors are never written here.
 */

export type Feature = "charge_start" | "soc_read" | "soc_write" | "cockpit" | "location";

export interface CapabilityStore {
  get(): string | undefined;
  set(value: string): void;
}

export class CapabilityMemory {
  private readonly refused: Record<string, Feature[]>;

  constructor(private readonly store: CapabilityStore) {
    this.refused = CapabilityMemory.parse(store.get());
  }

  private static parse(raw: string | undefined): Record<string, Feature[]> {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, Feature[]> = {};
      for (const [car, list] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(list)) out[car] = list.filter((f): f is Feature => typeof f === "string");
      }
      return out;
    } catch {
      return {};
    }
  }

  isRefused(car: string, feature: Feature): boolean {
    return this.refused[car]?.includes(feature) ?? false;
  }

  /** Record a refusal; returns true when it is new. */
  refuse(car: string, feature: Feature): boolean {
    if (this.isRefused(car, feature)) return false;
    (this.refused[car] ??= []).push(feature);
    this.store.set(JSON.stringify(this.refused));
    return true;
  }
}
