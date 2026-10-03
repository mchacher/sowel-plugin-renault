/**
 * What each model is known to accept, seeded from hacf-fr/renault-api and from
 * what was measured. Anything else is probed, and a refusal is remembered per
 * car (see `capabilities.ts`).
 */

/** Where the charge-start action lives, or `null` when the model refuses it. */
export type ChargeStartRoute = "kca" | "kcm" | null;

export interface ModelCapabilities {
  chargeStart: ChargeStartRoute;
}

const KNOWN: Record<string, ModelCapabilities> = {
  // Renault Rafale E-Tech plug-in hybrid: charging-start is forbidden (measured 2026-10-03).
  XHN1CP: { chargeStart: null },
  // Megane E-Tech electric: KCM charge/start (renault-api).
  XCB1VE: { chargeStart: "kcm" },
};

const DEFAULT: ModelCapabilities = { chargeStart: "kca" };

export function capabilitiesOf(modelCode: string | undefined): ModelCapabilities {
  return (modelCode && KNOWN[modelCode]) || DEFAULT;
}

/** Engine types published as electric vehicles. */
export const ELECTRIC_ENGINES = new Set(["ELEC", "ELECX", "PHEV"]);
