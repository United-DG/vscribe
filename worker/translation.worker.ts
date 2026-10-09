import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { getRedisConnection } from '../api/src/config/redis';

const TRANSLATION_SERVICE = process.env.TRANSLATION_SERVICE_URL || 'http://localhost:8001';

interface TranslationJob {
  format: 'word_by_word' | 'timeline';
  sourceLanguage: string;
  targetLanguage: string;
  fullText?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  userId?: string;
}

function splitText(text: string, maxCharacters = 1200): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
  const chunks: string[] = [];
  let chunk = '';

  for (const sentence of sentences) {
    if (sentence.length > maxCharacters) {
      if (chunk) chunks.push(chunk);
      chunk = '';
      const words = sentence.split(/(\s+)/);
      for (const word of words) {
        if (chunk.length + word.length > maxCharacters && chunk) {
          chunks.push(chunk);
          chunk = '';
        }
        chunk += word;
      }
    } else if (chunk.length + sentence.length > maxCharacters && chunk) {
      chunks.push(chunk);
      chunk = sentence;
    } else {
      chunk += sentence;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.filter((value) => value.trim().length > 0);
}

async function translateBatch(texts: string[], source: string, target: string): Promise<string[]> {
  const response = await axios.post(`${TRANSLATION_SERVICE}/translate`, {
    source,
    target,
    texts
  }, { timeout: 600000 });
  if (!Array.isArray(response.data.translations) || response.data.translations.length !== texts.length) {
    throw new Error('Translation service returned an invalid response');
  }
  return response.data.translations;
}

const worker = new Worker<TranslationJob>(
  'translation',
  async (job: Job<TranslationJob>) => {
    const { format, sourceLanguage, targetLanguage } = job.data;
    await job.updateProgress(2);

    if (format === 'word_by_word') {
      const chunks = splitText(job.data.fullText || '');
      const translated: string[] = [];
      for (let i = 0; i < chunks.length; i += 12) {
        const batch = chunks.slice(i, i + 12);
        translated.push(...await translateBatch(batch, sourceLanguage, targetLanguage));
        await job.updateProgress(Math.min(99, Math.round(((i + batch.length) / chunks.length) * 100)));
      }
      return {
        language: targetLanguage,
        full_text: translated.join('')
      };
    }

    const segments = job.data.segments || [];
    const translatedSegments: Array<{ start: number; end: number; text: string }> = [];
    for (let i = 0; i < segments.length; i += 12) {
      const batch = segments.slice(i, i + 12);
      const translations = await translateBatch(batch.map((segment) => segment.text), sourceLanguage, targetLanguage);
      translatedSegments.push(...batch.map((segment, index) => ({ ...segment, text: translations[index] })));
      await job.updateProgress(Math.min(99, Math.round(((i + batch.length) / segments.length) * 100)));
    }

    return { language: targetLanguage, segments: translatedSegments };
  },
  {
    connection: getRedisConnection(),
    concurrency: Number.parseInt(process.env.TRANSLATION_CONCURRENCY || '1', 10),
    lockDuration: 900000,
  }
);

worker.on('completed', (job) => console.log(`✅ Translation ${job.id}: completed`));
worker.on('failed', (job, error) => console.error(`❌ Translation ${job?.id}: ${error.message}`));

console.log('🌍 Translation worker started');

export { worker };
