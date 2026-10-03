/**
 * The account: discovery of the cars and one scheduler per car.
 */

import { RenaultError } from "./api/errors.js";
import type { Kamereon } from "./api/kamereon.js";
import type { Session } from "./api/session.js";
import { ELECTRIC_ENGINES } from "./models.js";
import { Scheduler } from "./scheduler.js";
import type { Logger } from "./sowel-api.js";
import { sourceIdOf, Vehicle, type VehicleContext, type VehicleLink } from "./vehicle.js";

export type AccountContext = Omit<VehicleContext, "accountId" | "kamereon"> & {
  kamereon: Kamereon;
  session: Session;
};

interface Entry {
  vehicle: Vehicle;
  scheduler: Scheduler;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The electric links of a vehicles answer; others are skipped. */
export function electricLinks(body: unknown): VehicleLink[] {
  const links = rec(body).vehicleLinks;
  if (!Array.isArray(links)) return [];
  const out: VehicleLink[] = [];
  for (const raw of links) {
    const link = rec(raw);
    const vin = str(link.vin);
    const details = link.vehicleDetails;
    if (!vin || details === null || typeof details !== "object") continue;
    const d = rec(details);
    const engine = str(d.engineEnergyType) ?? str(rec(d.energy).code);
    if (!engine || !ELECTRIC_ENGINES.has(engine)) continue;
    const model = rec(d.model);
    out.push({ vin, modelCode: str(model.code), label: str(model.label) ?? "Renault", engine });
  }
  return out;
}

export class Account {
  private readonly cars = new Map<string, Entry>();
  private readonly logger: Logger;
  private stopped = false;

  constructor(private readonly ctx: AccountContext) {
    this.logger = ctx.logger;
  }

  vehicle(sourceId: string): { vehicle: Vehicle; scheduler: Scheduler } | undefined {
    return this.cars.get(sourceId);
  }

  get size(): number {
    return this.cars.size;
  }

  /**
   * Person → MyRenault accounts → electric cars. Throws on failure, and only a
   * complete discovery removes the devices of cars that left the account.
   */
  async discover(): Promise<void> {
    const personId = await this.ctx.session.personId();
    const person = rec(await this.ctx.kamereon.get(`/persons/${personId}`));
    const accounts = (Array.isArray(person.accounts) ? person.accounts : [])
      .map(rec)
      .filter((a) => a.accountType === "MYRENAULT")
      .map((a) => str(a.accountId))
      .filter((id): id is string => id !== undefined);
    if (accounts.length === 0) throw new RenaultError("unexpected", "no MyRenault account found");

    const seen = new Set<string>();
    for (const accountId of accounts) {
      const links = electricLinks(await this.ctx.kamereon.get(`/accounts/${accountId}/vehicles`));
      // Stopped while waiting: create nothing, publish nothing.
      if (this.stopped) throw new RenaultError("stopped", "the Renault integration is stopping");
      for (const link of links) {
        const id = sourceIdOf(link);
        if (seen.has(id)) continue;
        seen.add(id);
        const existing = this.cars.get(id);
        if (existing) {
          existing.vehicle.update(link);
          existing.vehicle.declare();
          continue;
        }
        const vehicle = new Vehicle(link, { ...this.ctx, accountId });
        const scheduler = new Scheduler((err) =>
          this.logger.error({ err, vehicle: id }, "Renault poll crashed"),
        );
        vehicle.declare();
        vehicle.schedule(scheduler);
        this.cars.set(id, { vehicle, scheduler });
        this.logger.info({ vehicle: id, engine: link.engine }, "Renault car published");
      }
    }

    for (const [id, entry] of this.cars) {
      if (seen.has(id)) continue;
      entry.scheduler.stop();
      this.cars.delete(id);
      this.logger.info({ vehicle: id }, "Renault car left the account");
    }
    this.ctx.deviceManager.removeStaleDevices(this.ctx.integrationId, seen);
  }

  /** One battery read per car, through the budget (the "refresh" button). */
  async refreshBatteries(): Promise<void> {
    await Promise.all([...this.cars.values()].map((e) => e.vehicle.pollBattery()));
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.cars.values()) entry.scheduler.stop();
    this.cars.clear();
  }
}
