import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  savePendingRegistration, getPendingRegistration, deletePendingRegistration,
  getUserByEmail, createUser, updateUserPassword,
  savePasswordResetOTP, verifyPasswordResetOTP,
  createApiKey, getUserApiKeys, revokeApiKey, rotateApiKey
} from '../db/queries';
import {
  sendRegistrationOTP, sendWelcome, sendPasswordResetOTP,
  sendPasswordChanged, sendNewKey, sendKeyRotated
} from '../services/mailer';
import { apiKeyMiddleware } from '../middleware/apiKey';

const router: Router = Router();

// ── PUBLIC ROUTES (no API key needed) ────

router.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    savePendingRegistration(email, hashedPassword, otp);
    sendRegistrationOTP({ to: email, otp }).catch(() => {});

    console.log(`📧 Registration OTP for ${email}: ${otp}`);
    return res.status(200).json({ message: 'Check your email for verification code.' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/auth/verify', async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const pending = getPendingRegistration(email);
    if (!pending || pending.otp !== otp) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const userId = createUser(email, pending.password);
    deletePendingRegistration(email);

    const apiKey = createApiKey(userId, 'Default', 'free');
    sendWelcome({ to: email, apiKey }).catch(() => {});

    return res.status(201).json({ message: 'Email verified. Your API key is ready.', user_id: userId, api_key: apiKey, plan: 'free', limit_hr: 20 });
  } catch (err: any) {
    return res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = getUserByEmail(email) as any;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const keys = getUserApiKeys(user.id);
    return res.json({ message: 'Login successful', user: { id: user.id, email: user.email, plan: user.plan }, api_keys: keys });
  } catch (err: any) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = getUserByEmail(email);
    if (!user) return res.status(200).json({ message: 'If the email exists, a reset code has been sent.' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    savePasswordResetOTP(email, otp);
    sendPasswordResetOTP({ to: email, otp }).catch(() => {});
    console.log(`📧 Password reset OTP for ${email}: ${otp}`);
    return res.status(200).json({ message: 'If the email exists, a reset code has been sent.' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed' });
  }
});

router.post('/auth/reset-password/confirm', async (req: Request, res: Response) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: 'Email, OTP, and new password required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const valid = verifyPasswordResetOTP(email, otp);
    if (!valid) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const hashed = await bcrypt.hash(newPassword, 10);
    updateUserPassword(email, hashed);
    sendPasswordChanged({ to: email }).catch(() => {});
    return res.json({ message: 'Password updated successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── PROTECTED ROUTES (API key required) ───

router.get('/auth/keys', apiKeyMiddleware, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Auth required' });
  return res.json({ keys: getUserApiKeys(userId) });
});

router.post('/auth/keys', apiKeyMiddleware, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Auth required' });

  const { label } = req.body;
  const tier = req.user?.tier || 'free';
  const apiKey = createApiKey(userId, label || 'New Key', tier);
  sendNewKey({ to: req.user?.email || '', apiKey, label: label || 'New Key' }).catch(() => {});
  return res.status(201).json({ message: 'Key created', api_key: apiKey });
});

router.delete('/auth/keys/:key', apiKeyMiddleware, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Auth required' });

  const keys = getUserApiKeys(userId) as any[];
  
  // Prevent deleting the last key
  if (keys.length <= 1) {
    return res.status(400).json({ 
      error: 'Cannot delete last key', 
      message: 'You must have at least one API key. Create a new key first, then delete this one.',
      hint: 'POST /api/v1/auth/keys to create a new key'
    });
  }

  revokeApiKey(req.params.key as string, userId);
  return res.json({ message: 'Key revoked' });
});

router.post('/auth/keys/:key/rotate', apiKeyMiddleware, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Auth required' });

  const newKey = rotateApiKey(req.params.key as string, userId);
  if (!newKey) return res.status(404).json({ error: 'Key not found' });

  sendKeyRotated({ to: req.user?.email || '', newKey }).catch(() => {});
  return res.json({ message: 'Key rotated', api_key: newKey });
});

export { router as authRoutes };
