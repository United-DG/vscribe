import { Router, Request, Response } from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PRIORITY } from '../config/queue';
import { translationQueue } from '../config/translationQueue';
import { handleUpload, mediaExtensions } from './upload';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const router: Router = Router();
const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
const generateJobId = (): string => `trn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

router.post('/translations', handleUpload, async (req: Request, res: Response) => {
  const uploadedFile = req.file;
  const sourceUrl = req.body?.url;
  if (!uploadedFile && (typeof sourceUrl !== 'string' || !sourceUrl.trim())) {
    return res.status(400).json({ error: 'A media URL or uploaded file is required' });
  }
  if (!uploadedFile) {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid media URL');
    } catch {
      return res.status(400).json({ error: 'A valid HTTP or HTTPS media URL is required' });
    }
  }

  try {
    if (await translationQueue.getWorkersCount() === 0) {
      return res.status(503).json({ error: 'Translation service unavailable' });
    }

    let pythonJobId: string | undefined;
    let safeFilename: string | undefined;
    if (uploadedFile) {
      const extension = path.extname(uploadedFile.originalname).toLowerCase();
      if (!mediaExtensions.has(extension)) {
        return res.status(400).json({ error: 'Unsupported media file type' });
      }

      safeFilename = path.basename(uploadedFile.originalname).replace(/[^\w.-]/g, '_') || 'media';
      const form = new FormData();
      form.append('file', fs.createReadStream(uploadedFile.path), safeFilename);
      const response = await axios.post(`${pythonServiceUrl}/translate/upload`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000
      });
      pythonJobId = response.data.job_id;
      if (typeof pythonJobId !== 'string' || !pythonJobId) {
        throw new Error('Transcription service returned an invalid translation job ID');
      }
    }

    const jobId = generateJobId();
    const priority = req.user?.tier === 'premium' ? PRIORITY.HIGH : PRIORITY.NORMAL;
    await translationQueue.add('whisper-translate-to-english', {
      source: uploadedFile ? safeFilename : sourceUrl,
      pythonJobId,
      userId: req.user?.apiKey
    }, { priority, jobId });

    return res.status(202).json({ job_id: jobId, status: 'queued', language: 'en' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to queue Whisper translation:', message);
    return res.status(503).json({ error: 'Translation service unavailable' });
  } finally {
    if (uploadedFile) {
      await fs.promises.unlink(uploadedFile.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') console.error('Failed to remove temporary upload:', error.message);
      });
    }
  }
});

router.get('/translations/:jobId', async (req: Request, res: Response) => {
  try {
    const job = await translationQueue.getJob(req.params.jobId as string);
    if (!job || job.data.userId !== req.user?.apiKey) {
      return res.status(404).json({ error: 'Translation job not found' });
    }

    const status = await job.getState();
    if (status !== 'completed' && status !== 'failed' && await translationQueue.getWorkersCount() === 0) {
      return res.status(503).json({ error: 'Translation service unavailable' });
    }
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
    return res.status(503).json({ error: 'Translation service unavailable' });
  }
});

export { router as translationRoutes };
