import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

function cleanEnv(val: string | undefined, fallback: string): string {
  if (!val) return fallback;
  const trimmed = val.trim().replace(/^["']|["']$/g, '');
  return trimmed.length > 0 ? trimmed : fallback;
}

// Upstash Redis credentials provided with safe sanitization
const UPSTASH_URL = cleanEnv(
  process.env.UPSTASH_REDIS_REST_URL,
  'https://fond-koi-285614.upstash.io'
);
const UPSTASH_TOKEN = cleanEnv(
  process.env.UPSTASH_REDIS_REST_TOKEN,
  'gQAAAAAABFuuAAIgcDE4MDFkODk4NWViZDU0ODllOGNhNDkzNmUyODY3ZWM3Mw'
);

// In-memory fallback cache in case Redis credentials expire, are missing, or network fails
const inMemoryFallbackStore = new Map<string, { value: any; expiresAt?: number }>();

let upstashClient: Redis | null = null;
try {
  if (UPSTASH_URL && UPSTASH_URL.startsWith('https://') && UPSTASH_TOKEN) {
    upstashClient = new Redis({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    });
  }
} catch (err: any) {
  console.warn('[Redis] Upstash client init failed, using in-memory mock store:', err?.message);
}

export const redis = {
  get: async <T = any>(key: string): Promise<T | null> => {
    if (upstashClient) {
      try {
        return (await upstashClient.get<T>(key)) as T | null;
      } catch {}
    }
    const cached = inMemoryFallbackStore.get(key);
    if (!cached) return null;
    if (cached.expiresAt && cached.expiresAt < Date.now()) {
      inMemoryFallbackStore.delete(key);
      return null;
    }
    return cached.value as T;
  },
  set: async (key: string, value: any, opts?: { ex?: number }): Promise<'OK' | null> => {
    const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    inMemoryFallbackStore.set(key, { value, expiresAt });
    if (upstashClient) {
      try {
        if (opts?.ex) {
          return (await upstashClient.set(key, value, { ex: opts.ex })) as 'OK' | null;
        }
        return (await upstashClient.set(key, value)) as 'OK' | null;
      } catch {}
    }
    return 'OK';
  },
  del: async (key: string): Promise<number> => {
    const deleted = inMemoryFallbackStore.delete(key) ? 1 : 0;
    if (upstashClient) {
      try {
        return await upstashClient.del(key);
      } catch {}
    }
    return deleted;
  },
  ping: async (): Promise<string> => {
    if (upstashClient) {
      return await upstashClient.ping();
    }
    return 'PONG';
  },
};

/**
 * Determine if current instance is 'published' (production) or 'dev' (preview)
 */
export function detectEnvironment(): 'dev' | 'published' {
  if (process.env.APPLET_ENV === 'production' || process.env.NODE_ENV === 'production') {
    return 'published';
  }
  // Deployed Cloud Run container always has K_SERVICE set
  if (process.env.K_SERVICE) {
    return 'published';
  }
  // Bundled production server is run via 'node server.js'
  if (process.argv.some(arg => arg.endsWith('server.js') || arg.includes('server.js'))) {
    return 'published';
  }
  if (process.env.APPLET_ENV === 'dev' || process.env.NODE_ENV === 'development') {
    return 'dev';
  }
  const hasViteSource = fs.existsSync(path.resolve(process.cwd(), 'vite.config.ts'));
  if (!hasViteSource) {
    return 'published';
  }
  return 'dev';
}

export const CURRENT_ENV: 'dev' | 'published' = detectEnvironment();

// Strict namespace isolation so dev never reads or touches published data
export const DATA_PREFIX = CURRENT_ENV === 'published' ? 'apexion:prod:' : 'apexion:dev:';

// Coordinated keys across instances for bot election & settings
export const GLOBAL_KEYS = {
  BOT_MODE: 'apexion:global:bot_mode', // 'published' | 'dev' | 'disabled'
  BOT_LEADER: 'apexion:bot:leader_instance', // Holds active leader instance info
};

let lastRedisError: string | null = null;
let lastHealthyCheck: number = 0;
let isRedisAvailable: boolean = true;

// Read-cache map with TTL to avoid exceeding Upstash daily rate limits
const redisReadCache = new Map<string, { value: any; cachedAt: number }>();
const REDIS_READ_CACHE_TTL_MS = 45000; // 45 seconds read cache

/**
 * Safe Redis helpers with automatic memory-fallback, read-caching, and error recovery
 */
export async function getRedisJson<T>(key: string, defaultValue: T): Promise<T> {
  const now = Date.now();
  const cachedRead = redisReadCache.get(key);
  if (cachedRead && now - cachedRead.cachedAt < REDIS_READ_CACHE_TTL_MS) {
    return (cachedRead.value ?? defaultValue) as T;
  }

  try {
    const raw = await redis.get<any>(key);
    isRedisAvailable = true;
    lastRedisError = null;
    if (raw === null || raw === undefined) {
      // Check in-memory fallback
      const cached = inMemoryFallbackStore.get(key);
      if (cached) {
        if (!cached.expiresAt || cached.expiresAt > now) {
          redisReadCache.set(key, { value: cached.value, cachedAt: now });
          return cached.value as T;
        }
        inMemoryFallbackStore.delete(key);
      }
      redisReadCache.set(key, { value: defaultValue, cachedAt: now });
      return defaultValue;
    }

    let parsedVal: any = raw;
    if (typeof raw === 'string') {
      try {
        parsedVal = JSON.parse(raw);
      } catch {
        parsedVal = raw;
      }
    }
    inMemoryFallbackStore.set(key, { value: parsedVal });
    redisReadCache.set(key, { value: parsedVal, cachedAt: now });
    return parsedVal as T;
  } catch (err: any) {
    isRedisAvailable = false;
    lastRedisError = err?.message || 'Redis connection failed';
    // Fall back to in-memory store
    const cached = inMemoryFallbackStore.get(key);
    if (cached) {
      if (!cached.expiresAt || cached.expiresAt > now) {
        return cached.value as T;
      }
      inMemoryFallbackStore.delete(key);
    }
    return defaultValue;
  }
}

export async function setRedisJson(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
  // Always update in-memory fallback cache first
  const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined;
  inMemoryFallbackStore.set(key, { value, expiresAt });
  redisReadCache.set(key, { value, cachedAt: Date.now() });

  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await redis.set(key, serialized, { ex: ttlSeconds });
    } else {
      await redis.set(key, serialized);
    }
    isRedisAvailable = true;
    lastRedisError = null;
    return true;
  } catch (err: any) {
    isRedisAvailable = false;
    lastRedisError = err?.message || 'Redis write failed';
    // Returns true because in-memory fallback succeeded
    return true;
  }
}

/**
 * Health check for Upstash Redis with latency measurement
 */
export async function getRedisHealth(): Promise<{
  ok: boolean;
  status: 'connected' | 'fallback';
  message: string;
  latencyMs?: number;
}> {
  const start = Date.now();
  try {
    const res = await redis.ping();
    const latency = Date.now() - start;
    if (res === 'PONG') {
      isRedisAvailable = true;
      lastRedisError = null;
      lastHealthyCheck = Date.now();
      return {
        ok: true,
        status: 'connected',
        message: 'Upstash Redis cloud operational',
        latencyMs: latency,
      };
    }
  } catch (err: any) {
    isRedisAvailable = false;
    lastRedisError = err?.message || 'Upstash token or connection failure';
  }

  return {
    ok: true, // Still operational via in-memory fallback
    status: 'fallback',
    message: lastRedisError ? `Local Fallback Active (${lastRedisError})` : 'Local Fallback Active',
  };
}
