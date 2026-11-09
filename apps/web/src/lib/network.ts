import type { ConnectAddress } from "@craftpanel/shared";

/** Connection addresses as returned by the server overview and network endpoints. */
export interface ConnectionAddresses {
  local: string;
  lan: string[];
  /** Labelled addresses, real LAN first; absent from APIs older than the adapter classification. */
  network?: ConnectAddress[];
}

/** Labelled addresses, falling back to the plain `lan` list (all shown as "Local network"). */
export function connectEntries(a: ConnectionAddresses): ConnectAddress[] {
  return a.network ?? a.lan.map((address) => ({ address, kind: "lan", label: "Local network" }));
}
