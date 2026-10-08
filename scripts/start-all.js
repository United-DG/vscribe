const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');

const hasCloudRedis = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL;

console.log('🔗 Redis:', hasCloudRedis ? 'CLOUD' : 'LOCAL');
console.log('🚀 Starting vscribe services...\n');

// yt-dlp update
const ytdlp = spawn('yt-dlp', ['-U', '--no-progress'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: true,
});
ytdlp.unref();
console.log('🔄 yt-dlp update running in background\n');

// Python
const python = spawn('python3', ['api/services/server.py'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});

// Redis
let redis = null;
if (!hasCloudRedis) {
  redis = spawn('redis-server', [
    '--requirepass',
    process.env.REDIS_PASSWORD || 'node',
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
} else {
  console.log('☁️  Skipping local Redis (using cloud)\n');
}

// Worker
const worker = spawn('pnpm', [
  'exec',
  'ts-node',
  'worker/transcription.worker.ts',
], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

// API
const api = spawn('pnpm', [
  'exec',
  'ts-node',
  'api/src/index.ts',
], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

// Frontend
const frontend = spawn(process.execPath, ['scripts/frontend-server.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});

console.log('🌐 Frontend starting...\n');

// Aggressive shutdown - kill process group
function shutdown() {
  console.log('\n🛑 Shutting down...');

  if (python.pid) process.kill(-python.pid, 'SIGTERM');
  if (redis && redis.pid) process.kill(-redis.pid, 'SIGTERM');
  if (worker.pid) process.kill(-worker.pid, 'SIGTERM');
  if (api.pid) process.kill(-api.pid, 'SIGTERM');
  if (frontend.pid) process.kill(-frontend.pid, 'SIGTERM');

  // Force kill after 2 seconds
  setTimeout(() => {
    if (python.pid) {
      try { process.kill(-python.pid, 'SIGKILL'); } catch (e) {}
    }

    if (redis && redis.pid) {
      try { process.kill(-redis.pid, 'SIGKILL'); } catch (e) {}
    }

    if (worker.pid) {
      try { process.kill(-worker.pid, 'SIGKILL'); } catch (e) {}
    }

    if (api.pid) {
      try { process.kill(-api.pid, 'SIGKILL'); } catch (e) {}
    }

    if (frontend.pid) {
      try { process.kill(-frontend.pid, 'SIGKILL'); } catch (e) {}
    }

    process.exit(0);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
