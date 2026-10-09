# api/services/transcriber.py
import os
import time
import json
import hashlib
import shutil
import tempfile
import threading
import yt_dlp
from pathlib import Path
from faster_whisper import WhisperModel
from typing import Optional, Callable
from dataclasses import dataclass
from enum import Enum

class TranscriptionType(str, Enum):
    WORD_BY_WORD = "word_by_word"
    TIMELINE = "timeline"

class JobStatus(str, Enum):
    DOWNLOADING = "downloading"
    TRANSCRIBING = "transcribing"
    COMPLETED = "completed"
    FAILED = "failed"

@dataclass
class TimelineSegment:
    start: float
    end: float
    text: str

@dataclass
class TranscriptionResult:
    type: TranscriptionType
    language: str
    duration: float
    full_text: Optional[str] = None
    segments: Optional[list] = None
    srt: Optional[str] = None
    vtt: Optional[str] = None
    title: Optional[str] = None
    error: Optional[str] = None


class VideoTranscriber:
    """Main transcription service with file-based caching"""
    
    def __init__(
        self,
        model_size: str = "base",
        cache_dir: str = None,
        cache_max_age_days: int = 7,
        cache_max_files: int = 100
    ):
        self.model_size = model_size
        self.model = None
        self.model_lock = threading.Lock()
        self.temp_dir = tempfile.mkdtemp(prefix="transcribe_")
        
        # Cache settings
        self.cache_dir = cache_dir or os.path.join(
            os.path.dirname(__file__), "..", "..", "cache", "transcriptions"
        )
        self.cache_max_age_days = cache_max_age_days
        self.cache_max_files = cache_max_files
        os.makedirs(self.cache_dir, exist_ok=True)
    
    def _load_model(self):
        """Lazy load Whisper model (only when needed)"""
        if self.model is None:
            self.model = WhisperModel(
                self.model_size,
                device="cpu",
                compute_type="int8"
            )
        return self.model
    
    def _get_cache_key(self, source: str, transcription_type: str) -> str:
        """Generate unique cache key from source URL/file + type"""
        content = f"{source}_{transcription_type}"
        return hashlib.md5(content.encode()).hexdigest()
    
    def _get_from_cache(self, cache_key: str) -> Optional[TranscriptionResult]:
        """Try to load from file cache (near-zero RAM)"""
        cache_file = os.path.join(self.cache_dir, f"{cache_key}.json")
        
        if not os.path.exists(cache_file):
            return None
        
        # Check if expired
        file_age_seconds = time.time() - os.path.getmtime(cache_file)
        if file_age_seconds > self.cache_max_age_days * 86400:
            os.remove(cache_file)  # Expired, delete it
            return None
        
        # Load from disk
        with open(cache_file, 'r') as f:
            data = json.load(f)
        
        # Update access time (for count-based cleanup)
        os.utime(cache_file, None)
        
        # Reconstruct result
        result = TranscriptionResult(
            type=TranscriptionType(data['type']),
            language=data['language'],
            duration=data['duration'],
            title=data.get('title'),
            full_text=data.get('full_text'),
            srt=data.get('srt'),
            vtt=data.get('vtt')
        )
        
        if data.get('segments'):
            result.segments = [
                TimelineSegment(**seg) for seg in data['segments']
            ]
        
        return result
    
    def _save_to_cache(self, cache_key: str, result: TranscriptionResult):
        """Save result to file cache, then run cleanup"""
        cache_file = os.path.join(self.cache_dir, f"{cache_key}.json")
        
        data = {
            'type': result.type.value,
            'language': result.language,
            'duration': result.duration,
            'title': result.title,
            'full_text': result.full_text,
            'srt': result.srt,
            'vtt': result.vtt,
        }
        
        if result.segments:
            data['segments'] = [
                {'start': s.start, 'end': s.end, 'text': s.text}
                for s in result.segments
            ]
        
        with open(cache_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        # Auto-cleanup after saving
        self._cleanup_cache()
    
    def _cleanup_cache(self):
        """Hybrid cleanup: TTL + max files limit (no Redis needed!)"""
        cache_path = Path(self.cache_dir)
        now = time.time()
        
        # Phase 1: Delete expired files (TTL-based)
        for file in cache_path.glob("*.json"):
            file_age = now - file.stat().st_mtime
            if file_age > self.cache_max_age_days * 86400:
                file.unlink()
        
        # Phase 2: Enforce max file count (keep newest)
        remaining = sorted(
            cache_path.glob("*.json"),
            key=lambda f: f.stat().st_atime,  # Sort by last access
            reverse=True
        )
        
        for file in remaining[self.cache_max_files:]:
            file.unlink()
    
    def transcribe(
        self,
        source: str,
        transcription_type: TranscriptionType = TranscriptionType.WORD_BY_WORD,
        is_url: bool = True,
        progress_callback: Optional[Callable] = None,
        use_cache: bool = True
    ) -> TranscriptionResult:
        """Main method with file-based caching"""
        
        # Check cache (disk read, near-zero RAM)
        if use_cache:
            cache_key = self._get_cache_key(source, transcription_type.value)
            cached = self._get_from_cache(cache_key)
            if cached:
                if progress_callback:
                    progress_callback(JobStatus.COMPLETED, 100)
                return cached
        
        try:
            # Download
            if progress_callback:
                progress_callback(JobStatus.DOWNLOADING, 0)
            
            if is_url:
                audio_path, title = self._download_audio(source)
            else:
                audio_path = source
                title = os.path.basename(source)
            
            # Transcribe
            if progress_callback:
                progress_callback(JobStatus.TRANSCRIBING, 50)
            
            result = self._transcribe_audio(audio_path, transcription_type, title)
            
            # Save to file cache
            if use_cache:
                self._save_to_cache(cache_key, result)
            
            # Cleanup cache leftovers (if any)
            if is_url and os.path.exists(audio_path):
                shutil.rmtree(os.path.dirname(audio_path), ignore_errors=True)
            
            if progress_callback:
                progress_callback(JobStatus.COMPLETED, 100)
            
            return result
            
        except Exception as e:
            if progress_callback:
                progress_callback(JobStatus.FAILED, 0)
            return TranscriptionResult(
                type=transcription_type,
                language="unknown",
                duration=0,
                error=str(e)
            )
    
    def _download_audio(self, url: str) -> tuple[str, str]:
        """Download audio from video URL"""
        import uuid
        job_dir = os.path.join(self.temp_dir, uuid.uuid4().hex)
        os.makedirs(job_dir, exist_ok=True)
        output_template = os.path.join(job_dir, "%(id)s.%(ext)s")

        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': output_template,
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }],
            'quiet': True,
            'no_warnings': True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', 'Unknown')
            video_id = info.get('id', 'unknown')

        audio_path = os.path.join(job_dir, f"{video_id}.mp3")
        return audio_path, title
    
    def _transcribe_audio(
        self, audio_path: str,
        transcription_type: TranscriptionType,
        title: str
    ) -> TranscriptionResult:
        """Run Whisper transcription"""
        with self.model_lock:
            model = self._load_model()
            segments, info = model.transcribe(audio_path, beam_size=5)
            segments = list(segments)
        
        if transcription_type == TranscriptionType.WORD_BY_WORD:
            return self._format_word_by_word(segments, info, title)
        else:
            return self._format_timeline(segments, info, title)

    def translate_to_english(self, source: str, is_url: bool = True) -> dict:
        """Translate source speech into English using Whisper's audio translation task."""
        audio_path = None
        is_temporary = False
        try:
            if is_url:
                audio_path, title = self._download_audio(source)
                is_temporary = True
            else:
                audio_path = source
                title = os.path.basename(source)

            with self.model_lock:
                model = self._load_model()
                segments, info = model.transcribe(audio_path, beam_size=5, task="translate")
                translated_segments = [
                    {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                    for segment in segments
                ]

            full_text = " ".join(segment["text"] for segment in translated_segments)
            srt = self._generate_srt([TimelineSegment(**segment) for segment in translated_segments])
            vtt = self._generate_vtt([TimelineSegment(**segment) for segment in translated_segments])
            return {
                "language": "en",
                "source_language": info.language,
                "duration": info.duration,
                "title": title,
                "full_text": full_text,
                "segments": translated_segments,
                "srt": srt,
                "vtt": vtt,
            }
        finally:
            if is_temporary and audio_path and os.path.exists(audio_path):
                import shutil
                shutil.rmtree(os.path.dirname(audio_path), ignore_errors=True)
    
    def _format_word_by_word(self, segments, info, title) -> TranscriptionResult:
        full_text = " ".join([s.text.strip() for s in segments])
        return TranscriptionResult(
            type=TranscriptionType.WORD_BY_WORD,
            language=info.language,
            duration=info.duration,
            full_text=full_text,
            title=title
        )
    
    def _format_timeline(self, segments, info, title) -> TranscriptionResult:
        timeline_segments = [
            TimelineSegment(start=s.start, end=s.end, text=s.text.strip())
            for s in segments
        ]
        srt = self._generate_srt(timeline_segments)
        vtt = self._generate_vtt(timeline_segments)
        
        return TranscriptionResult(
            type=TranscriptionType.TIMELINE,
            language=info.language,
            duration=info.duration,
            segments=timeline_segments,
            srt=srt,
            vtt=vtt,
            title=title
        )
    
    def _generate_srt(self, segments: list[TimelineSegment]) -> str:
        srt = ""
        for i, seg in enumerate(segments, 1):
            start = self._format_timestamp(seg.start)
            end = self._format_timestamp(seg.end)
            srt += f"{i}\n{start} --> {end}\n{seg.text}\n\n"
        return srt
    
    def _generate_vtt(self, segments: list[TimelineSegment]) -> str:
        vtt = "WEBVTT\n\n"
        for seg in segments:
            start = self._format_timestamp(seg.start, vtt=True)
            end = self._format_timestamp(seg.end, vtt=True)
            vtt += f"{start} --> {end}\n{seg.text}\n\n"
        return vtt
    
    @staticmethod
    def _format_timestamp(seconds: float, vtt: bool = False) -> str:
        total_milliseconds = round(seconds * 1000)
        hours, remainder = divmod(total_milliseconds, 3_600_000)
        minutes, remainder = divmod(remainder, 60_000)
        secs, millis = divmod(remainder, 1000)
        
        if vtt:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
    
    def __del__(self):
        """Cleanup temp directory"""
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def get_cache_stats(self) -> dict:
        """Get cache stats (for dashboard/analytics)"""
        cache_path = Path(self.cache_dir)
        files = list(cache_path.glob("*.json"))
        total_size = sum(f.stat().st_size for f in files)
        
        return {
            "cache_dir": str(self.cache_dir),
            "file_count": len(files),
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / 1024 / 1024, 2),
            "max_files": self.cache_max_files,
            "max_age_days": self.cache_max_age_days
        }