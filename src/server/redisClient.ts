import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

// Upstash Redis credentials provided by user
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://fond-koi-285614.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAABFuuAAIgcDE4MDFkODk4NWViZDU0ODllOGNhNDkzNmUyODY3ZWM3Mw';

export const redis = new Redis({
  url: UPSTASH_URL,
  token: UPSTASH_TOKEN,
});

/**
 * Determine if current instance is 'published' (production) or 'dev' (preview)
 * The user requirement:
 * "preview bot in here and published bot on my adress apexion.ai.studio isn't like interfering with each other"
 * "ALSO THE data shouldn't mix with the preview server and published server okay in dev server users data shouldn't come okay"
 */
export function detectEnvironment(): 'dev' | 'published' {
  // Check explicit environment variables
  if (process.env.APPLET_ENV === 'production' || process.env.NODE_ENV === 'production') {
    return 'published';
  }
  if (process.env.APPLET_ENV === 'dev' || process.env.NODE_ENV === 'development') {
    return 'dev';
  }
  // Check if running bundled server without vite source
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

/**
 * Safe Redis helpers with error recovery and logging
 */
export async function getRedisJson<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const raw = await redis.get<any>(key);
    if (raw === null || raw === undefined) return defaultValue;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }
    return raw as T;
  } catch (err: any) {
    console.warn(`[Upstash Redis] Error reading key "${key}":`, err?.message);
    return defaultValue;
  }
}

export async function setRedisJson(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await redis.set(key, serialized, { ex: ttlSeconds });
    } else {
      await redis.set(key, serialized);
    }
    return true;
  } catch (err: any) {
    console.warn(`[Upstash Redis] Error writing key "${key}":`, err?.message);
    return false;
  }
}
