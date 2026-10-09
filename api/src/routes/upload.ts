import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';

export const maxUploadSizeMb = Number.parseInt(process.env.MAX_UPLOAD_SIZE_MB || '500', 10);
if (!Number.isSafeInteger(maxUploadSizeMb) || maxUploadSizeMb < 1) {
  throw new Error('MAX_UPLOAD_SIZE_MB must be a positive integer');
}

export const mediaExtensions = new Set([
  '.3g2', '.3gp', '.aac', '.aif', '.aiff', '.alac', '.amr', '.asf', '.au',
  '.avi', '.caf', '.flac', '.flv', '.m2ts', '.m2v', '.m4a', '.m4b', '.m4p',
  '.m4v', '.mka', '.mkv', '.mov', '.mp2', '.mp3', '.mp4', '.mpe', '.mpeg',
  '.mpg', '.mts', '.oga', '.ogg', '.ogv', '.opus', '.ra', '.ram', '.ts',
  '.wav', '.weba', '.webm', '.wma', '.wmv'
]);

const receiveUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxUploadSizeMb * 1024 * 1024 }
}).single('file');

export function handleUpload(req: Request, res: Response, next: NextFunction) {
  receiveUpload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: error.message });
    }
    return next(error);
  });
}
