import { Worker, Job, ConnectionOptions } from 'bullmq';
import axios from 'axios';

const PYTHON_SERVICE = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

function getRedisConnection(): ConnectionOptions {
  if (process.env.UPSTASH_REDIS_URL) {
    console.log('🔗 Worker using Upstash Redis');
    return { url: process.env.UPSTASH_REDIS_URL, tls: {} };
  }
  if (process.env.REDIS_URL) {
    console.log('🔗 Worker using Redis URL');
    return { url: process.env.REDIS_URL, tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined };
  }
  console.log('🔗 Worker using local Redis');
  return { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379'), password: process.env.REDIS_PASSWORD || 'node' };
}

interface TranscriptionJob {
  source: string;
  format: 'word_by_word' | 'timeline';
  isUrl: boolean;
  pythonJobId?: string;
  userId?: string;
  webhookUrl?: string;
}

// Throttled logger - only log when value actually changes
function createThrottledLogger(jobId: string) {
  let lastProgress = -1;
  let lastLog = '';

  return {
    progress(percent: number, label: string) {
      if (percent !== lastProgress) {
        lastProgress = percent;
        console.log(`📊 ${jobId}: ${percent}% - ${label}`);
      }
    },
    log(msg: string) {
      if (msg !== lastLog) {
        lastLog = msg;
        console.log(`📝 ${jobId}: ${msg}`);
      }
    }
  };
}

const worker = new Worker(
  'transcription',
  async (job: Job<TranscriptionJob>) => {
    const { source, format, isUrl, webhookUrl } = job.data;
    const log = createThrottledLogger(job.id!);

    console.log(`🎯 ${job.id}: ${source.slice(0, 60)}...`);
    
    await job.updateProgress(5);
    log.progress(5, 'Starting download...');

    try {
      let pythonJobId = job.data.pythonJobId;
      if (!pythonJobId) {
        const response = await axios.post(`${PYTHON_SERVICE}/transcribe`, {
          url: isUrl ? source : undefined,
          format,
          use_cache: true,
        }, { timeout: 600000 });
        pythonJobId = response.data.job_id;
        log.progress(10, 'Submitted to transcriber');
      } else {
        log.progress(10, 'Upload received by transcriber');
      }

      let result = null;
      let attempts = 0;
      const maxAttempts = 300;

      while (attempts < maxAttempts) {
        const statusResponse = await axios.get(`${PYTHON_SERVICE}/transcribe/${pythonJobId}`);
        const data = statusResponse.data;

        if (data.status === 'completed') {
          result = data.result;
          log.progress(100, 'Done!');
          await job.updateProgress(100);
          break;
        }
        if (data.status === 'failed') {
          throw new Error(data.error || 'Transcription failed');
        }

        // Map Python progress (0-100) to our range (10-95)
        const pythonProgress = data.progress || 0;
        const mappedProgress = Math.round(10 + (pythonProgress * 0.85));
        
        // Only log meaningful stages
        let label = 'Processing...';
        if (pythonProgress < 20) label = 'Downloading video...';
        else if (pythonProgress < 50) label = 'Extracting audio...';
        else if (pythonProgress < 90) label = 'Transcribing...';
        else label = 'Finalizing...';

        log.progress(mappedProgress, label);
        await job.updateProgress(mappedProgress);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s instead of 1s
        attempts++;
      }

      if (!result) throw new Error('Transcription timed out');

      if (webhookUrl) {
        axios.post(webhookUrl, { jobId: job.id, status: 'completed', result }).catch(() => {});
      }

      return result;
    } catch (error: any) {
      console.error(`❌ ${job.id}: ${error.message}`);
      throw error;
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 2,
    limiter: { max: 5, duration: 60000 },
    lockDuration: 300000,
  }
);

worker.on('completed', (job) => console.log(`✅ ${job.id}: completed`));
worker.on('failed', (job, err) => console.error(`❌ ${job?.id}: failed - ${err.message}`));

console.log('👷 Transcription worker started');
console.log('   Concurrency: 2 | Rate limit: 5/min | Poll interval: 2s');

export { worker };
