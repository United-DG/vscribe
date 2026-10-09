```markdown
# 🎬 vscribe — Video Transcription API

> Transcribe any video. Instantly.  
> `https://vscribe.frionode.online/api/v1`

---

## What is vscribe?

vscribe is a powerful video transcription API that converts speech to text from virtually any video source — Facebook, Instagram, TikTok, YouTube, or direct file upload.

- **Word-by-word** transcription (full text)
- **Timeline** transcription (SRT/VTT subtitles)
- **File-based caching** — repeat requests return in under 1ms
- **Async processing** — submit a job, poll for results
- **Multiple formats** — JSON, SRT, VTT

---

## 🚀 Quick Start

The dashboard's default API endpoint is configured with `API_BASE_URL` in the
server environment (see `env.example`). The dashboard's **API endpoint** setting
can still override that default in the browser. Local audio and video uploads are
limited to 500 MB by default; configure `MAX_UPLOAD_SIZE_MB` to change the limit.
The dashboard can also ask Faster-Whisper to translate the original speech into
English. Whisper speech translation only targets English; it is not arbitrary
text-to-language translation. Translation jobs reuse the existing Python
transcription service and run in a dedicated queue worker. If that worker is
unavailable, transcription continues normally and the dashboard reports that
translation is unavailable.

```bash
# Submit a video URL
curl -X POST https://vscribe.frionode.online/api/v1/transcribe \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"url":"https://www.facebook.com/share/v/14aqDQRKonw/"}'

# Response
{
  "message": "Transcription queued",
  "job_id": "txr_709bf6ec2b8e4512",
  "status": "queued",
  "_links": {
    "status": "/api/v1/transcribe/txr_709bf6ec2b8e4512",
    "result": "/api/v1/transcribe/txr_709bf6ec2b8e4512/result"
  }
}

# Poll for result
curl -H "X-API-Key: YOUR_API_KEY" \
  https://vscribe.frionode.online/api/v1/transcribe/txr_709bf6ec2b8e4512

# Download as SRT subtitles
curl -H "X-API-Key: YOUR_API_KEY" \
  https://vscribe.frionode.online/api/v1/transcribe/txr_709bf6ec2b8e4512/srt
```

---

## 📚 API Reference

### Authentication

All endpoints require an API key passed in the `X-API-Key` header.

```
X-API-Key: txr_your_key_here
```

[Get your free API key →](#-getting-an-api-key)

### Rate Limits

| Tier | Requests/Hour |
|------|---------------|
| Free | 10 |
| Premium | 100 |

Rate limit headers are included in every response:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

---

### Endpoints

#### `POST /api/v1/transcribe`
Submit a video URL for transcription.

```json
{
  "url": "https://example.com/video",
  "format": "word_by_word",
  "use_cache": true
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | *required* | Video URL (FB, IG, TikTok, YT) |
| `format` | string | `word_by_word` | `word_by_word` or `timeline` |
| `use_cache` | boolean | `true` | Skip processing if already transcribed |

#### `POST /api/v1/transcribe/upload`
Upload a local audio or video file as `multipart/form-data`. Include a `file`
field and an optional `format` field (`word_by_word` or `timeline`). Uploads are
limited to 500 MB by default; set `MAX_UPLOAD_SIZE_MB` to change the limit.

#### `POST /api/v1/translations`
Queue Whisper speech translation to English. Send a JSON `url` for an existing
media URL, or upload the original media again as multipart field `file`. Poll
`GET /api/v1/translations/{job_id}` for progress and the translated result.

#### `GET /api/v1/transcribe/{job_id}`
Get job status and result.

#### `GET /api/v1/transcribe/{job_id}/srt`
Download transcription as SRT subtitle file.

#### `GET /api/v1/transcribe/{job_id}/vtt`
Download transcription as WebVTT subtitle file.

#### `GET /api/v1/queue/stats`
Get current queue statistics (waiting, active, completed, failed).

#### `POST /api/v1/auth/register`
Create an account. Two-step verification via email.

#### `POST /api/v1/auth/login`
Login to manage API keys.

---

## 🔑 Getting an API Key

### 1. Register
```bash
curl -X POST https://vscribe.frionode.online/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your_password"}'
```

### 2. Verify Email
Check your inbox for a verification code, then:
```bash
curl -X POST https://vscribe.frionode.online/api/v1/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","otp":"123456"}'
```

### 3. Get Your Key
The API key is returned upon verification. Keep it safe!

---

## ⚠️ Pre-Release Notice

vscribe is currently in **pre-release**. The API is fully functional but:

- Rate limits are enforced (free: 10/hr)
- Billing system coming soon
- URL may change upon full public release
- [Subscribe for updates](#) | [Watch on GitHub](https://github.com/frionode)

**Need full access now?**  
Email `admin@frionode.online` for unrestricted API access during pre-release.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Speech-to-Text | faster-whisper (base model, CPU int8) |
| Video Download | yt-dlp (1000+ sites) |
| API Gateway | Node.js + Express + TypeScript |
| Transcription Service | Python + FastAPI |
| Queue | BullMQ + Redis |
| Database | SQLite (WAL mode) |
| Email | Brevo |
| Deployment | Docker Compose (4 services) |

---

## 📦 More Projects by frionode

- **[Luna](https://github.com/frionode/Luna)** — WhatsApp bot with 400+ commands, multi-instance automation powerhouse. `JavaScript`
- **IMS** — Inventory management system. `SQLite + JS + EJS` *(Private)*
- **Pulse-HQ** — Hospital management API. `PostgreSQL + TypeScript` *(Private)*
- **[kb-758](https://github.com/frionode/kb-758)** — School management system with role-based access. `MongoDB + JS + EJS`
- **[YouTify](https://github.com/frionode/youtify)** — Discord music & gaming bot with 400+ commands. `JavaScript`
- **[Bloom-v2](https://github.com/frionode/Bloom-v2)** — Triple instance WhatsApp bot with rotation management. `JavaScript`
- **[pysession](https://github.com/frionode/pysession)** — Telegram session string generator. `Python`
- **[Dark](https://github.com/frionode/Dark)** — HTTP client / DOS attack tool. `Python`
- **[mismo](https://github.com/frionode/mismo)** — String similarity algorithm. `JavaScript`

---

## 🔗 Links

| Platform | Handle |
|----------|--------|
| GitHub | [github.com/frionode](https://github.com/frionode) |
| Portfolio | [frionode.online](https://frionode.online) |
| Telegram | [@frionode](https://t.me/frionode) |
| Email | [admin@frionode.online](mailto:admin@frionode.online) |

---

## 📄 License

MIT © 2026 [frionode](https://github.com/frionode)

---

*Built with ❤️ and too much caffeine.*
```