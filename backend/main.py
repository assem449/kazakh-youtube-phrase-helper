import os
import json
import hashlib
import logging
import asyncio
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq

from dotenv import load_dotenv
load_dotenv()

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
CACHE_DIR   = BASE_DIR / "cache"
TEMP_DIR    = BASE_DIR / "temp_audio"
CACHE_DIR.mkdir(exist_ok=True)
TEMP_DIR.mkdir(exist_ok=True)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Kazakh YouTube Phrase Helper API",
    version="1.0.0",
    description="Transcribe YouTube videos locally using Whisper",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # Chrome extensions send requests from chrome-extension://
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────────────────
class TranscribeRequest(BaseModel):
    url: str
    language: str = "kk"           # Default: Kazakh


class Segment(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    title: str
    language: str
    segments: list[Segment]
    cached: bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────
def url_to_cache_key(url: str, language: str) -> str:
    """Stable cache key based on URL + language."""
    raw = f"{url}|{language}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def get_cache_path(cache_key: str) -> Path:
    return CACHE_DIR / f"{cache_key}.json"


def load_cache(cache_key: str) -> Optional[dict]:
    path = get_cache_path(cache_key)
    if path.exists():
        try:
            with open(path) as f:
                logger.info(f"Cache HIT for key {cache_key}")
                return json.load(f)
        except Exception:
            pass
    return None


def save_cache(cache_key: str, data: dict):
    path = get_cache_path(cache_key)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"Cache saved for key {cache_key}")


def check_dependency(name: str) -> bool:
    return shutil.which(name) is not None


def download_audio(url: str, output_path: Path) -> tuple:
    if not check_dependency("yt-dlp"):
        raise RuntimeError("yt-dlp is not installed or not in PATH.")
    if not check_dependency("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed. Install via: brew install ffmpeg")

    template = str(output_path / "%(id)s.%(ext)s")

    # Step 1: get title and ID without downloading
    info_cmd = [
        "yt-dlp",
        "--no-playlist",
        "--print", "%(title)s|||%(id)s",
        url,
    ]
    info_result = subprocess.run(info_cmd, capture_output=True, text=True, timeout=30)
    title, video_id = "Unknown Title", "unknown"
    for line in info_result.stdout.strip().splitlines():
        if "|||" in line:
            parts = line.split("|||", 1)
            title = parts[0].strip()
            video_id = parts[1].strip()
            break

    # Step 2: download audio separately
    dl_cmd = [
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "5",
        "--no-playlist",
        "--output", template,
        url,
    ]
    logger.info(f"Downloading audio to: {output_path}")
    dl_result = subprocess.run(dl_cmd, capture_output=True, text=True, timeout=300)

    if dl_result.returncode != 0:
        stderr = dl_result.stderr.strip()
        logger.error(f"yt-dlp failed: {stderr}")
        if "Video unavailable" in stderr:
            raise RuntimeError("Video is unavailable or private.")
        raise RuntimeError(f"yt-dlp failed: {stderr[-300:]}")

    # Find the downloaded file
    logger.info(f"Files in temp dir: {list(output_path.glob('*'))}")
    audio_file = output_path / f"{video_id}.mp3"
    if not audio_file.exists():
        all_audio = (
            list(output_path.glob("*.mp3")) +
            list(output_path.glob("*.webm")) +
            list(output_path.glob("*.m4a")) +
            list(output_path.glob("*.opus"))
        )
        if not all_audio:
            raise RuntimeError("Audio file not found after yt-dlp download.")
        audio_file = all_audio[0]

    logger.info(f"Downloaded: {audio_file} (title: {title})")
    return str(audio_file), title

def trim_audio(input_path: str, output_path: str, duration_seconds: int = 300):
    """Trim audio to first N seconds using ffmpeg."""
    cmd = [
        "ffmpeg", "-i", input_path,
        "-t", str(duration_seconds),
        "-acodec", "copy",
        output_path,
        "-y"
    ]
    subprocess.run(cmd, capture_output=True, timeout=60)
    return output_path


def transcribe_audio(audio_path: str, language: str) -> tuple:
    client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
    
    lang = None if language == "auto" else language
    
    with open(audio_path, "rb") as f:
        result = client.audio.transcriptions.create(
            file=f,
            model="whisper-large-v3",
            language="kk",
            response_format="verbose_json",
        )
    
    segments = []
    for seg in result.segments:
        segments.append({
            "start": round(seg["start"], 2),
            "end":   round(seg["end"],   2),
            "text":  seg["text"].strip(),
        })
    
    return segments, result.language

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Health check — confirms backend is running and deps are available."""
    issues = []
    if not check_dependency("yt-dlp"):
        issues.append("yt-dlp not found in PATH")
    if not check_dependency("ffmpeg"):
        issues.append("ffmpeg not found in PATH")

    whisper_backend = None
    try:
        from faster_whisper import WhisperModel
        whisper_backend = "faster-whisper"
    except ImportError:
        try:
            import whisper
            whisper_backend = "openai-whisper"
        except ImportError:
            issues.append("No Whisper backend installed")

    return {
        "status": "ok" if not issues else "degraded",
        "whisper_backend": whisper_backend,
        "yt_dlp":  check_dependency("yt-dlp"),
        "ffmpeg":  check_dependency("ffmpeg"),
        "issues":  issues,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest):
    """
    Main transcription endpoint.
    Downloads audio with yt-dlp, transcribes with Whisper.
    Results are cached by (url, language) hash.
    """
    url      = req.url.strip()
    language = req.language.strip() or "kk"

    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")
    if "youtube.com" not in url and "youtu.be" not in url:
        raise HTTPException(status_code=400, detail="Only YouTube URLs are supported.")

    # ── Cache check ───────────────────────────────────────────────────────────
    cache_key = url_to_cache_key(url, language)
    cached    = load_cache(cache_key)
    if cached:
        cached["cached"] = True
        return TranscribeResponse(**cached)

    # ── Per-request temp directory ────────────────────────────────────────────
    job_dir = TEMP_DIR / cache_key
    job_dir.mkdir(exist_ok=True)

    try:
        # ── Download audio ────────────────────────────────────────────────────
        logger.info(f"Downloading audio for: {url}")
        try:
            audio_path, title = await asyncio.to_thread(
                download_audio, url, job_dir
            )
        except RuntimeError as e:
            raise HTTPException(status_code=422, detail=str(e))

        # Trim to first 5 minutes
        trimmed_path = audio_path.replace(".mp3", "_trimmed.mp3")
        audio_path = await asyncio.to_thread(
            trim_audio, audio_path, trimmed_path, 300
)
        # ── Transcribe ────────────────────────────────────────────────────────
        logger.info(f"Transcribing: {audio_path}")
        try:
            segments, detected_lang = await asyncio.to_thread(
                transcribe_audio, audio_path, language
            )
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

        # ── Build response ────────────────────────────────────────────────────
        response_data = {
            "title":    title,
            "language": detected_lang,
            "segments": segments,
            "cached":   False,
        }

        save_cache(cache_key, response_data)
        return TranscribeResponse(**response_data)

    finally:
        # ── Cleanup temp audio ────────────────────────────────────────────────
        if job_dir.exists():
            shutil.rmtree(job_dir, ignore_errors=True)
            logger.info(f"Cleaned up temp dir: {job_dir}")


@app.delete("/cache")
async def clear_cache():
    """Clear all cached transcripts."""
    count = 0
    for f in CACHE_DIR.glob("*.json"):
        f.unlink()
        count += 1
    return {"cleared": count}
