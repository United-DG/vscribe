import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { getRedisConnection } from '../api/src/config/redis';

const PYTHON_SERVICE = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

interface TranslationJob {
  source: string;
  pythonJobId?: string;
  userId: string;
}

const worker = new Worker<TranslationJob>(
  'translation',
  async (job: Job<TranslationJob>) => {
    let pythonJobId = job.data.pythonJobId;
    await job.updateProgress(5);

    if (!pythonJobId) {
      const response = await axios.post(`${PYTHON_SERVICE}/translate`, {
        url: job.data.source,
        format: 'word_by_word',
      }, { timeout: 600000 });
      pythonJobId = response.data.job_id;
      if (typeof pythonJobId !== 'string' || !pythonJobId) {
        throw new Error('Transcription service returned an invalid translation job ID');
      }
      await job.updateData({ ...job.data, pythonJobId });
    }

    for (let attempt = 0; attempt < 1800; attempt++) {
      const response = await axios.get(`${PYTHON_SERVICE}/translate/${pythonJobId}`, {
        timeout: 30000
      });
      const data = response.data;

      if (data.status === 'completed') {
        await job.updateProgress(100);
        return data.result;
      }
      if (data.status === 'failed') {
        throw new Error(data.error || 'Whisper translation failed');
      }

      await job.updateProgress(Math.min(95, Math.max(5, data.progress || 5)));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error('Whisper translation timed out');
  },
  {
    connection: getRedisConnection(),
    concurrency: 1,
    lockDuration: 900000,
  }
);

worker.on('completed', (job) => console.log(`✅ English translation ${job.id}: completed`));
worker.on('failed', (job, error) => console.error(`❌ English translation ${job?.id}: ${error.message}`));

console.log('🌍 Whisper English translation worker started');

export { worker };
