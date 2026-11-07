/** Readers for Minecraft's JSON access lists (whitelist.json, ops.json, banned-*.json). */

export interface WhitelistEntry { uuid: string; name: string }
export interface OpEntry { uuid: string; name: string; level: number; bypassesPlayerLimit: boolean }
export interface BanEntry { uuid?: string; name?: string; ip?: string; created?: string; source?: string; expires?: string; reason?: string }

export function parseJsonList<T>(text: string | null): T[] {
  if (!text || !text.trim()) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
