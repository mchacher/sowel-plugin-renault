/**
 * Sowel plugin: Renault
 *
 * Renault cars through the MyRenault cloud, each published as a device
 * carrying the electric vehicle contract of core spec 183.
 *
 * This is the skeleton: it starts, stops and reports its status. The account,
 * the cars and the wake order arrive with spec 001.
 */

import type {
  Device,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
} from "./sowel-api.js";

export const INTEGRATION_ID = "renault";

class RenaultPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Renault";
  readonly description =
    "Renault cars through the MyRenault cloud: battery level, range, charging state, and a remote wake";
  readonly icon = "Car";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private status: IntegrationStatus = "not_configured";

  constructor(private readonly deps: PluginDeps) {
    this.logger = deps.logger.child({ module: "renault" });
  }

  getStatus(): IntegrationStatus {
    return this.status;
  }

  /** No account can be declared yet: the settings arrive with spec 001. */
  isConfigured(): boolean {
    return false;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [];
  }

  async start(): Promise<void> {
    this.status = "not_configured";
    this.logger.info({ pluginDir: this.deps.pluginDir }, "Renault plugin started (no account yet)");
  }

  async stop(): Promise<void> {
    this.status = "disconnected";
    this.logger.info("Renault plugin stopped");
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    this.logger.debug(
      { deviceId: device.id, orderKey, value },
      "Order received (no client yet, ignored)",
    );
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new RenaultPlugin(deps);
}
