export interface SystemGeoStatus {
  configured: boolean;
  source: 'system' | 'env' | 'none';
  maskedKey: string;
  updatedAt: number | null;
  cacheEntries: number;
}

export interface AmapProbeResult {
  ok: boolean;
  message: string;
  sampleAddress?: string;
}

export interface ReverseGeoResult {
  valid: boolean;
  inChina: boolean;
  gcjLat: number | null;
  gcjLon: number | null;
  address: string | null;
  shortAddress: string | null;
  poiName: string | null;
  source: 'amap' | 'amap-cache' | null;
}

export function maskApiKey(raw: unknown): string;
export function outOfChina(lon: number, lat: number): boolean;
export function wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number; inChina: boolean };
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function resolveSystemAmapKey(opts?: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  fallbackKey?: string;
}): { key: string; source: 'system' | 'env' | 'plugin' | 'none' };
export function getSystemGeoStatus(opts?: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}): SystemGeoStatus;
export function saveSystemGeoConfig(opts?: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  amapKey?: string;
  clearAmapKey?: boolean;
}): Promise<SystemGeoStatus>;
export function probeAmapKey(opts?: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  amapKey?: string;
  requester?: (url: string) => Promise<{ status: number; body: Buffer | string }>;
  amapUrl?: string;
}): Promise<AmapProbeResult>;
export function reverseGeocodeWithCache(opts: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  lat: number;
  lon: number;
  coordSys?: 'wgs84' | 'gcj02';
  fallbackKey?: string;
  nowMs?: number;
  requester?: (url: string) => Promise<{ status: number; body: Buffer | string }>;
  amapUrl?: string;
}): Promise<ReverseGeoResult>;
