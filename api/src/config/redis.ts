import { ConnectionOptions } from 'bullmq';

export function getRedisConnection(): ConnectionOptions {
  if (process.env.UPSTASH_REDIS_URL) {
    console.log('🔗 Using Upstash Redis');
    return { url: process.env.UPSTASH_REDIS_URL, tls: {} };
  }
  if (process.env.REDIS_URL) {
    console.log('🔗 Using Redis URL');
    return {
      url: process.env.REDIS_URL,
      tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    };
  }
  console.log('🔗 Using local Redis');
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || 'node',
  };
}
