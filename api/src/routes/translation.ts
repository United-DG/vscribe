import { Router, Request, Response } from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { translationQueue, PRIORITY } from '../config/translationQueue';

const router: Router = Router();
const translationServiceUrl = process.env.TRANSLATION_SERVICE_URL || 'http://localhost:8001';
const generateJobId = (): string => `trn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

async function ensureTranslationAvailable(): Promise<void> {
  await axios.get(`${translationServiceUrl}/health`, { timeout: 5000 });
  if (await translationQueue.getWorkersCount() === 0) {
    throw new Error('Translation worker is not running');
  }
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

function isSegment(value: unknown): value is TranscriptSegment {
  if (!value || typeof value !== 'object') return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.start === 'number'
    && typeof segment.end === 'number'
    && Number.isFinite(segment.start)
    && Number.isFinite(segment.end)
    && segment.start >= 0
    && segment.end >= segment.start
    && typeof segment.text === 'string';
}

router.get('/translations/languages', async (req: Request, res: Response) => {
  const source = req.query.source;
  if (typeof source !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(source)) {
    return res.status(400).json({ error: 'A valid source language code is required' });
  }

  try {
    await ensureTranslationAvailable();
    const response = await axios.get(`${translationServiceUrl}/languages`, {
      params: { source },
      timeout: 15000
    });
    return res.json(response.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Translation language lookup failed:', message);
    return res.status(503).json({ error: 'Translation service unavailable' });
  }
});

router.post('/translations', async (req: Request, res: Response) => {
  const { target, format, full_text, segments, language } = req.body || {};
  if (typeof target !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(target)) {
    return res.status(400).json({ error: 'A valid target language code is required' });
  }
  if (format !== 'word_by_word' && format !== 'timeline') {
    return res.status(400).json({ error: 'Format must be word_by_word or timeline' });
  }
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(language)) {
    return res.status(400).json({ error: 'A valid source language code is required' });
  }
  if (format === 'word_by_word' && (typeof full_text !== 'string' || !full_text.trim())) {
    return res.status(400).json({ error: 'Transcript text is required' });
  }
  if (format === 'timeline' && (!Array.isArray(segments) || !segments.length || !segments.every(isSegment))) {
    return res.status(400).json({ error: 'Valid transcript segments are required' });
  }

  try {
    await ensureTranslationAvailable();
    const jobId = generateJobId();
    const priority = req.user?.tier === 'premium' ? PRIORITY.HIGH : PRIORITY.NORMAL;
    await translationQueue.add('translate-transcript', {
      format,
      sourceLanguage: language,
      targetLanguage: target,
      fullText: format === 'word_by_word' ? full_text : undefined,
      segments: format === 'timeline' ? segments : undefined,
      userId: req.user?.apiKey
    }, { priority, jobId });

    return res.status(202).json({ job_id: jobId, status: 'queued' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Translation service unavailable:', message);
    return res.status(503).json({ error: 'Translation service unavailable' });
  }
});

router.get('/translations/:jobId', async (req: Request, res: Response) => {
  try {
    const job = await translationQueue.getJob(req.params.jobId as string);
    if (!job) return res.status(404).json({ error: 'Translation job not found' });
    if (job.data.userId !== req.user?.apiKey) return res.status(404).json({ error: 'Translation job not found' });

    const status = await job.getState();
    return res.json({
      job_id: job.id,
      status,
      progress: job.progress,
      result: status === 'completed' ? job.returnvalue : null,
      error: status === 'failed' ? job.failedReason : null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Translation status lookup failed:', message);
    return res.status(502).json({ error: 'Translation queue unavailable' });
  }
});

export { router as translationRoutes };
