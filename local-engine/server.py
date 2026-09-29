# -*- coding: utf-8 -*-
"""Local transcription and Ollama proxy used by Skryptorium Głosów.

The server is intentionally small and local-only, but long-running work is kept
off the ASGI event loop. Transcription jobs are serialized through a one-worker
queue because a single CTranslate2 model must not be used concurrently.
"""

from __future__ import annotations

import contextlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value not in (None, "") else default


def _env_bool(name: str, default: bool = False) -> bool:
    return _env(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


def _default_cpu_threads() -> str:
    cores = os.cpu_count() or 4
    return str(max(4, min(cores - 1 if cores > 4 else cores, 12)))


# Transcription configuration. faster-whisper 1.2.1 supports the `turbo` alias.
MODEL_NAME = _env("ENGINE_MODEL", "turbo")
DEVICE_PREF = _env("ENGINE_DEVICE", "auto").lower()
COMPUTE_PREF = _env("ENGINE_COMPUTE", "auto").lower()
LANGUAGE = _env("ENGINE_LANG", "pl")
BEAM_SIZE = int(_env("ENGINE_BEAM", "2"))
BATCH_SIZE = int(_env("ENGINE_BATCH_SIZE", "8"))
CPU_THREADS = int(_env("ENGINE_CPU_THREADS", _default_cpu_threads()))
HOST = _env("ENGINE_HOST", "127.0.0.1")
PORT = int(_env("ENGINE_PORT", "8765"))
MAX_UPLOAD_BYTES = int(float(_env("ENGINE_MAX_UPLOAD_MB", "2048")) * 1024 * 1024)
UPLOAD_CHUNK_BYTES = max(64 * 1024, int(_env("ENGINE_UPLOAD_CHUNK_KB", "1024")) * 1024)
WORD_TIMESTAMPS = _env_bool("ENGINE_WORD_TIMESTAMPS", False)
HALLUCINATION_SILENCE_THRESHOLD = float(_env("ENGINE_HALLUCINATION_SILENCE", "2.0"))
LOG_PROB_THRESHOLD = float(_env("ENGINE_LOG_PROB_THRESHOLD", "-1.0"))
NO_SPEECH_THRESHOLD = float(_env("ENGINE_NO_SPEECH_THRESHOLD", "0.6"))
VAD_MIN_SILENCE_MS = int(_env("ENGINE_VAD_MIN_SILENCE_MS", "500"))
VAD_MIN_SPEECH_MS = int(_env("ENGINE_VAD_MIN_SPEECH_MS", "250"))
VAD_SPEECH_PAD_MS = int(_env("ENGINE_VAD_SPEECH_PAD_MS", "200"))
LOG_PROGRESS = _env_bool("ENGINE_LOG_PROGRESS", False)
PREPROCESS_AUDIO = _env_bool("ENGINE_PREPROCESS_AUDIO", False)
WARMUP_MODEL = _env_bool("ENGINE_WARMUP", False)

# v4 quality/speed switches. All default to the behaviour measured as best;
# each can be turned off with an env variable if it ever misbehaves.
# Fine-grained segments: BatchedInferencePipeline defaults to one segment per
# VAD chunk (up to 30 s). With timestamps on, the model splits chunks at its
# own timestamp tokens, so the timeline, SRT/VTT and search jumps get
# sentence-sized cues instead of half-minute blocks.
FINE_SEGMENTS = _env_bool("ENGINE_FINE_SEGMENTS", True)
# Remove whole-segment Whisper hallucinations (Amara.org credits, "subskrybuj")
# and collapse repetition loops. Raw removed text is reported, never silently lost.
HALLUCINATION_FILTER = _env_bool("ENGINE_HALLUCINATION_FILTER", True)
# Batched inference has no temperature fallback. Suspicious segments (loops,
# very high compression ratio) are re-decoded once with the sequential decoder,
# which does have fallback. Bounded by count and time.
REPAIR_PASS = _env_bool("ENGINE_REPAIR_PASS", True)
REPAIR_MAX_SEGMENTS = int(_env("ENGINE_REPAIR_MAX_SEGMENTS", "40"))
REPAIR_MAX_SECONDS = float(_env("ENGINE_REPAIR_MAX_SECONDS", "180"))
REPAIR_COMPRESSION_RATIO = float(_env("ENGINE_REPAIR_COMPRESSION_RATIO", "2.4"))
# Before a GPU job ask Ollama to unload its models: the measured GPU→CPU
# fallback was caused by qwen2.5:7b still holding VRAM after analysis.
FREE_OLLAMA_VRAM = _env_bool("ENGINE_FREE_OLLAMA_VRAM", True)
# After a GPU failure, stay on CPU for this long, then try the GPU again
# (v3 switched to CPU for the lifetime of the process).
GPU_RETRY_COOLDOWN_SEC = float(_env("ENGINE_GPU_RETRY_COOLDOWN_SEC", "900"))
# Models a request may select. The configured ENGINE_MODEL is always allowed.
ALLOWED_MODELS = [
    name.strip()
    for name in _env("ENGINE_ALLOWED_MODELS", "turbo,large-v3,medium,small,base").split(",")
    if name.strip()
]
if MODEL_NAME not in ALLOWED_MODELS:
    ALLOWED_MODELS.insert(0, MODEL_NAME)

PROCESSING_PROFILES: dict[str, dict[str, int]] = {
    "fast": {"beam_size": 1, "best_of": 1, "batch_size": 8},
    "balanced": {"beam_size": BEAM_SIZE, "best_of": max(1, BEAM_SIZE), "batch_size": BATCH_SIZE},
    "archive": {"beam_size": 4, "best_of": 4, "batch_size": 4},
}

# Job lifecycle.
DONE_JOB_TTL_SEC = int(_env("ENGINE_DONE_JOB_TTL_SEC", "86400"))
ERROR_JOB_TTL_SEC = int(_env("ENGINE_ERROR_JOB_TTL_SEC", "86400"))
CANCELLED_JOB_TTL_SEC = int(_env("ENGINE_CANCELLED_JOB_TTL_SEC", "3600"))
STALE_JOB_TTL_SEC = int(_env("ENGINE_STALE_JOB_TTL_SEC", "21600"))
ORPHAN_FILE_TTL_SEC = int(_env("ENGINE_ORPHAN_FILE_TTL_SEC", "3600"))
CLEANUP_INTERVAL_SEC = max(5, int(_env("ENGINE_CLEANUP_INTERVAL_SEC", "60")))
MAX_FINISHED_JOBS = max(1, int(_env("ENGINE_MAX_FINISHED_JOBS", "100")))
JOB_HEARTBEAT_INTERVAL_SEC = max(1.0, float(_env("ENGINE_JOB_HEARTBEAT_SEC", "30")))

# Ollama configuration.
OLLAMA_URL = _env("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = _env("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_NUM_CTX = int(_env("OLLAMA_NUM_CTX", "8192"))
OLLAMA_MAX_CTX = int(_env("OLLAMA_MAX_CTX", "32768"))
OLLAMA_NUM_PREDICT = int(_env("OLLAMA_NUM_PREDICT", "4096"))
OLLAMA_TEMPERATURE = float(_env("OLLAMA_TEMPERATURE", "0.1"))
OLLAMA_TIMEOUT = int(_env("OLLAMA_TIMEOUT", "900"))
OLLAMA_KEEPALIVE = _env("OLLAMA_KEEPALIVE", "10m")

# Optional defense in depth. If set, sensitive endpoints require this header.
API_TOKEN = _env("ENGINE_API_TOKEN", "")
API_TOKEN_HEADER = "X-Skryptorium-Token"

TEMP_PREFIX = "skryptorium_"
TEMP_AUDIO_SUFFIX = ".audio"
TEMP_PROCESSED_SUFFIX = ".processed.wav"
_TEMP_NAME_RE = re.compile(r"^skryptorium_[A-Za-z0-9_.-]+(?:\.audio|\.processed\.wav)$")


def _configure_logging() -> logging.Logger:
    logger = logging.getLogger("skryptorium.engine")
    if logger.handlers:
        return logger
    level = getattr(logging, _env("ENGINE_LOG_LEVEL", "INFO").upper(), logging.INFO)
    logger.setLevel(level)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)
    log_file = _env("ENGINE_LOG_FILE", "").strip()
    if log_file:
        handler = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


logger = _configure_logging()


class JobCancelled(Exception):
    """Internal cooperative-cancellation signal."""


class UploadTooLarge(Exception):
    """Raised once the configured byte limit is crossed."""


_model: Any = None
_batched_model: Any = None
_model_lock = threading.RLock()
_model_meta: dict[str, Any] = {"device": None, "compute_type": None, "name": None}
_force_cpu = False
_force_cpu_until = 0.0
_gpu_state: dict[str, Any] = {"lastFallbackAt": None, "lastFallbackReason": None, "fallbackCount": 0, "oomRetries": 0}


def _cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # optional CUDA discovery
        return 0


def _cpu_forced() -> bool:
    if _force_cpu:
        return True
    return _timestamp() < _force_cpu_until


def _pick_device_compute() -> tuple[str, str]:
    device = DEVICE_PREF
    if _cpu_forced():
        device = "cpu"
    elif device == "auto":
        device = "cuda" if _cuda_device_count() > 0 else "cpu"
    compute = COMPUTE_PREF
    if compute == "auto" or (device == "cpu" and compute in {"float16", "int8_float16"}):
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


def _resolve_model_name(requested: str | None) -> str:
    name = (requested or "").strip()
    return name if name in ALLOWED_MODELS else MODEL_NAME


def _unload_model_locked() -> None:
    global _model, _batched_model
    _model = None
    _batched_model = None
    _model_meta.update(device=None, compute_type=None, name=None)
    with contextlib.suppress(Exception):
        import gc

        gc.collect()


def get_model(model_name: str | None = None):
    """Return the loaded Whisper model, (re)loading it when the requested model
    or the preferred device changed (e.g. the CPU cool-down after a GPU failure
    expired)."""
    global _model
    name = _resolve_model_name(model_name)
    device, compute = _pick_device_compute()
    with _model_lock:
        if _model is not None and (_model_meta.get("name") != name or _model_meta.get("device") != device):
            logger.info("phase=loading_model switching model %s/%s -> %s/%s", _model_meta.get("name"), _model_meta.get("device"), name, device)
            _unload_model_locked()
        if _model is None:
            from faster_whisper import WhisperModel

            logger.info("phase=loading_model loading model=%s device=%s compute=%s", name, device, compute)
            kwargs: dict[str, Any] = {"device": device, "compute_type": compute}
            if device == "cpu" and CPU_THREADS > 0:
                kwargs["cpu_threads"] = CPU_THREADS
            _model = WhisperModel(name, **kwargs)
            _model_meta.update(device=device, compute_type=compute, name=name)
            logger.info("phase=loading_model model ready")
    return _model


def get_transcription_model(model_name: str | None = None):
    global _batched_model
    model = get_model(model_name)
    if BATCH_SIZE <= 1:
        return model
    with _model_lock:
        if _batched_model is None or getattr(_batched_model, "model", None) is not model:
            from faster_whisper import BatchedInferencePipeline

            _batched_model = BatchedInferencePipeline(model=model)
    return _batched_model


def _is_cuda_lib_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(key in text for key in ("cublas", "cudnn", "cuda", "libcu", "nvinfer", "gpu", "out of memory"))


def _is_oom_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "out of memory" in text or "cuda_error_out_of_memory" in text or "cudamalloc" in text


def _fallback_to_cpu(reason: str = ""):
    """Switch to CPU for GPU_RETRY_COOLDOWN_SEC (not forever, as in v3)."""
    global _force_cpu_until
    with _model_lock:
        _force_cpu_until = _timestamp() + max(0.0, GPU_RETRY_COOLDOWN_SEC)
        _gpu_state.update(lastFallbackAt=_timestamp(), lastFallbackReason=(reason or "")[:300])
        _gpu_state["fallbackCount"] += 1
        _unload_model_locked()
    logger.warning(
        "phase=fallback_cpu GPU unavailable (%s); CPU int8 for the next %.0fs, then GPU is retried",
        (reason or "unknown")[:160],
        GPU_RETRY_COOLDOWN_SEC,
    )


def _free_ollama_vram(job: dict[str, Any] | None = None) -> list[str]:
    """Ask Ollama to unload every resident model. Best effort, never raises."""
    unloaded: list[str] = []
    try:
        running = _ollama_request("/api/ps", timeout=3).get("models") or []
    except Exception:
        return unloaded
    for item in running:
        name = item.get("name") or item.get("model")
        if not name:
            continue
        try:
            _ollama_request("/api/generate", {"model": name, "keep_alive": 0}, timeout=10)
            unloaded.append(name)
        except Exception as exc:  # Ollama may be busy; transcription continues anyway
            logger.warning("phase=free_vram could not unload %s: %s", name, exc)
    if unloaded:
        logger.info("job=%s phase=free_vram unloaded ollama models=%s", (job or {}).get("jobId"), ",".join(unloaded))
    return unloaded


_warmup_state: dict[str, Any] = {
    "enabled": WARMUP_MODEL,
    "status": "pending" if WARMUP_MODEL else "off",
    "finishedAt": None,
    "error": None,
}


def _warmup_model() -> None:
    """Optionally load the configured model without making startup fatal."""
    if not WARMUP_MODEL:
        return
    _warmup_state.update(status="running", error=None)
    logger.info("phase=warmup model warm-up started")
    try:
        get_transcription_model(MODEL_NAME)
    except Exception as exc:  # warm-up must never terminate the server
        _warmup_state.update(status="error", error=type(exc).__name__, finishedAt=_timestamp())
        logger.exception("phase=warmup model warm-up failed; server remains available")
    else:
        _warmup_state.update(status="done", finishedAt=_timestamp())
        logger.info("phase=warmup model warm-up complete")


def _start_warmup_worker() -> threading.Thread | None:
    if not WARMUP_MODEL:
        return None
    worker = threading.Thread(target=_warmup_model, name="skryptorium-warmup", daemon=True)
    worker.start()
    return worker


_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.RLock()
_job_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="skryptorium-transcribe")
_cleanup_stop = threading.Event()
_cleanup_thread: threading.Thread | None = None


def _timestamp() -> float:
    return time.time()


def _new_job() -> dict[str, Any]:
    now = _timestamp()
    job_id = uuid.uuid4().hex[:12]
    job: dict[str, Any] = {
        "jobId": job_id,
        "status": "queued",
        "phase": "queued",
        "progress": 0.0,
        "durationSec": None,
        "language": None,
        "transcript": None,
        "segments": None,
        "error": None,
        "message": "W kolejce.",
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "finished_at": None,
        "filename": None,
        "bytes": 0,
        "initialPromptUsed": False,
        "hotwordsUsed": False,
        "processingProfile": "balanced",
        "beamSize": BEAM_SIZE,
        "batchSize": BATCH_SIZE,
        "modelName": MODEL_NAME,
        "preprocess": False,
        # live progress (v4)
        "processedSec": 0.0,
        "speedX": None,
        "etaSec": None,
        "transcribeStartedAt": None,
        "speechSec": None,
        "quality": None,
        "events": [],
        "_tmp": None,
        "_tmp_files": [],
        "_cleanup_done": False,
        "_cleanup_in_progress": False,
        "_cancel": threading.Event(),
        "_future": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
        _prune_jobs_locked()
    return job


def _queue_position(job: dict[str, Any]) -> int | None:
    if job.get("status") != "queued":
        return None
    with _jobs_lock:
        queued = sorted(
            (item for item in _jobs.values() if item.get("status") == "queued"),
            key=lambda item: item["created_at"],
        )
        for index, item in enumerate(queued, 1):
            if item["jobId"] == job["jobId"]:
                return index
    return None


def _public_job(job: dict[str, Any], since: int | None = None) -> dict[str, Any]:
    """Serializable job view. `since` returns only segments from that index,
    so a 90-minute job is not re-sent in full on every poll."""
    with _jobs_lock:
        created_at = job["created_at"]
        segments = job.get("segments")
        segment_count = len(segments) if isinstance(segments, list) else 0
        payload_segments = segments
        segments_from = 0
        if since is not None and isinstance(segments, list):
            segments_from = max(0, min(int(since), segment_count))
            payload_segments = segments[segments_from:]
        return {
            "jobId": job["jobId"],
            "status": job["status"],
            "phase": job.get("phase"),
            "progress": round(float(job.get("progress") or 0), 4),
            "queuePosition": _queue_position(job),
            "durationSec": job.get("durationSec"),
            "language": job.get("language"),
            "transcript": job.get("transcript") if since is None or job["status"] == "done" else None,
            "segments": payload_segments,
            "segmentsFrom": segments_from,
            "segmentCount": segment_count,
            "error": job.get("error"),
            "message": job.get("message"),
            "createdAt": created_at,
            "updatedAt": job.get("updated_at"),
            "startedAt": job.get("started_at"),
            "finishedAt": job.get("finished_at"),
            "elapsedSec": round(max(0.0, _timestamp() - created_at), 1),
            "filename": job.get("filename"),
            "bytes": job.get("bytes", 0),
            "model": job.get("modelName") or MODEL_NAME,
            "device": _model_meta["device"],
            "computeType": _model_meta["compute_type"],
            "processingProfile": job.get("processingProfile", "balanced"),
            "beamSize": job.get("beamSize", BEAM_SIZE),
            "batchSize": job.get("batchSize", BATCH_SIZE),
            "initialPromptUsed": job.get("initialPromptUsed", False),
            "hotwordsUsed": job.get("hotwordsUsed", False),
            "preprocess": job.get("preprocess", False),
            "processedSec": round(float(job.get("processedSec") or 0), 1),
            "speedX": job.get("speedX"),
            "etaSec": job.get("etaSec"),
            "speechSec": job.get("speechSec"),
            "quality": job.get("quality"),
            "events": list(job.get("events") or [])[-8:],
        }


def _job_event(job: dict[str, Any], text: str) -> None:
    """Human-readable milestones shown in the UI (GPU recovery, repairs…)."""
    with _jobs_lock:
        job.setdefault("events", []).append({"at": round(_timestamp(), 1), "text": text})
        job["updated_at"] = _timestamp()


def _mark_job(
    job: dict[str, Any],
    message: str,
    progress: float | None = None,
    phase: str | None = None,
    status: str | None = None,
) -> None:
    with _jobs_lock:
        job["message"] = message
        if phase:
            job["phase"] = phase
        if status:
            job["status"] = status
        if progress is not None:
            job["progress"] = max(float(job.get("progress") or 0), progress)
        job["updated_at"] = _timestamp()


def _finish_job(job: dict[str, Any], status: str, message: str, error: str | None = None) -> None:
    now = _timestamp()
    with _jobs_lock:
        job["status"] = status
        job["phase"] = status
        job["message"] = message
        job["error"] = error
        job["updated_at"] = now
        job["finished_at"] = now
        if status == "done":
            job["progress"] = 1.0


def _cleanup_tmp(job: dict[str, Any]) -> None:
    with _jobs_lock:
        if job.get("_cleanup_done") or job.get("_cleanup_in_progress"):
            return
        job["_cleanup_in_progress"] = True
        paths = list(dict.fromkeys([job.get("_tmp"), *(job.get("_tmp_files") or [])]))
        job["_tmp"] = None
        job["_tmp_files"] = []
    failed: list[str] = []
    for raw_path in paths:
        if not raw_path:
            continue
        try:
            Path(raw_path).unlink(missing_ok=True)
        except OSError as exc:
            failed.append(raw_path)
            logger.warning("job=%s phase=cleanup could not remove tempfile: %s", job.get("jobId"), exc)
    with _jobs_lock:
        job["_cleanup_in_progress"] = False
        job["_cleanup_done"] = not failed
        if failed:
            job["_tmp"] = failed[0]
            job["_tmp_files"] = failed


def _prune_jobs_locked() -> None:
    finished = [item for item in _jobs.values() if item.get("status") in {"done", "error", "cancelled"}]
    if len(finished) <= MAX_FINISHED_JOBS:
        return
    finished.sort(key=lambda item: item.get("finished_at") or item.get("updated_at") or 0)
    for item in finished[: len(finished) - MAX_FINISHED_JOBS]:
        _cleanup_tmp(item)
        _jobs.pop(item["jobId"], None)


def _cleanup_expired_jobs(now: float | None = None) -> dict[str, int]:
    now = _timestamp() if now is None else now
    removed = 0
    cancel_requested = 0
    ttl_by_status = {
        "done": DONE_JOB_TTL_SEC,
        "error": ERROR_JOB_TTL_SEC,
        "cancelled": CANCELLED_JOB_TTL_SEC,
    }
    with _jobs_lock:
        for job_id, job in list(_jobs.items()):
            status = job.get("status")
            age = now - float(job.get("updated_at") or job.get("created_at") or now)
            if status in ttl_by_status and age >= ttl_by_status[status]:
                _cleanup_tmp(job)
                _jobs.pop(job_id, None)
                removed += 1
            elif status in {"queued", "running"} and age >= STALE_JOB_TTL_SEC:
                job["_cancel"].set()
                cancel_requested += 1
                if status == "queued":
                    future: Future | None = job.get("_future")
                    if future is None or future.cancel():
                        _finish_job(job, "cancelled", "Anulowano przeterminowane zadanie.")
                        _cleanup_tmp(job)
        _prune_jobs_locked()
    return {"removed": removed, "cancelRequested": cancel_requested}


def _cleanup_orphan_tempfiles(now: float | None = None, temp_dir: str | None = None) -> int:
    now = _timestamp() if now is None else now
    root = Path(temp_dir or tempfile.gettempdir())
    removed = 0
    try:
        candidates = list(root.iterdir())
    except OSError:
        return 0
    live_paths: set[str] = set()
    with _jobs_lock:
        for job in _jobs.values():
            live_paths.update(str(Path(path).resolve()) for path in job.get("_tmp_files", []) if path)
            if job.get("_tmp"):
                live_paths.add(str(Path(job["_tmp"]).resolve()))
    for path in candidates:
        if not path.is_file() or not _TEMP_NAME_RE.match(path.name):
            continue
        try:
            if str(path.resolve()) in live_paths or now - path.stat().st_mtime < ORPHAN_FILE_TTL_SEC:
                continue
            path.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("phase=cleanup orphan tempfile cleanup failed for %s: %s", path.name, exc)
    return removed


def _cleanup_loop() -> None:
    while not _cleanup_stop.wait(CLEANUP_INTERVAL_SEC):
        result = _cleanup_expired_jobs()
        orphan_count = _cleanup_orphan_tempfiles()
        if result["removed"] or result["cancelRequested"] or orphan_count:
            logger.info(
                "phase=cleanup jobs_removed=%d cancel_requested=%d orphan_files_removed=%d",
                result["removed"],
                result["cancelRequested"],
                orphan_count,
            )


def _job_heartbeat_loop(job: dict[str, Any], stop: threading.Event) -> None:
    """Keep a genuinely active worker from being mistaken for a stale job."""
    while not stop.wait(JOB_HEARTBEAT_INTERVAL_SEC):
        with _jobs_lock:
            if job.get("status") not in {"running"}:
                return
            job["updated_at"] = _timestamp()


def _start_cleanup_worker() -> None:
    global _cleanup_thread
    _cleanup_stop.clear()
    _cleanup_orphan_tempfiles()
    if _cleanup_thread is None or not _cleanup_thread.is_alive():
        _cleanup_thread = threading.Thread(target=_cleanup_loop, name="skryptorium-cleanup", daemon=True)
        _cleanup_thread.start()


def _stop_cleanup_worker() -> None:
    _cleanup_stop.set()
    if _cleanup_thread and _cleanup_thread.is_alive():
        _cleanup_thread.join(timeout=2)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _start_cleanup_worker()
    _start_warmup_worker()
    try:
        yield
    finally:
        _stop_cleanup_worker()


app = FastAPI(title="Skryptorium Local Whisper Engine v4", lifespan=lifespan)

# `null` is the Origin sent by a file:// page. Local web servers can use any port.
# Arbitrary internet origins are deliberately not allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=r"^https?://(?:localhost|127\.0\.0\.1)(?::\d+)?$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", API_TOKEN_HEADER],
)


@app.middleware("http")
async def require_optional_token(request: Request, call_next):
    sensitive = request.url.path.startswith("/api/transcribe") or request.url.path in {
        "/api/ollama/generate",
    }
    if request.method != "OPTIONS" and sensitive and API_TOKEN:
        supplied = request.headers.get(API_TOKEN_HEADER, "")
        if not hmac.compare_digest(supplied, API_TOKEN):
            return JSONResponse(status_code=401, content={"error": "Brak lub niepoprawny token lokalnego silnika."})
    return await call_next(request)


def _check_cancelled(job: dict[str, Any]) -> None:
    if job["_cancel"].is_set():
        raise JobCancelled()


# Speech-oriented clean-up: cut rumble below 70 Hz, drop content Whisper never
# hears (it resamples to 16 kHz), then even out quiet and loud speakers.
PREPROCESS_FILTER = _env(
    "ENGINE_PREPROCESS_FILTER",
    "highpass=f=70,lowpass=f=7800,dynaudnorm=f=200:g=11:p=0.9",
)


def _preprocess_audio(job: dict[str, Any], source_path: str) -> str:
    if not (PREPROCESS_AUDIO or job.get("preprocess")):
        return source_path
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        logger.warning("job=%s phase=preprocessing ffmpeg unavailable; using original audio", job["jobId"])
        return source_path
    fd, output_path = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=TEMP_PROCESSED_SUFFIX)
    os.close(fd)
    Path(output_path).unlink(missing_ok=True)
    job["_tmp_files"].append(output_path)
    command = [
        ffmpeg,
        "-nostdin",
        "-y",
        "-i",
        source_path,
        "-af",
        PREPROCESS_FILTER,
        "-ar",
        "16000",
        "-ac",
        "1",
        output_path,
    ]
    _mark_job(job, "Opcjonalne przygotowanie audio…", 0.01, "preprocessing")
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while process.poll() is None:
        if job["_cancel"].wait(0.2):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            raise JobCancelled()
    if process.returncode == 0 and Path(output_path).is_file() and Path(output_path).stat().st_size > 0:
        logger.info("job=%s phase=preprocessing audio preprocessing complete", job["jobId"])
        return output_path
    Path(output_path).unlink(missing_ok=True)
    logger.warning("job=%s phase=preprocessing ffmpeg failed; using original audio", job["jobId"])
    return source_path


def _segment_payload(segment: Any, offset: float = 0.0) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "start": round(float(segment.start) + offset, 2),
        "end": round(float(segment.end) + offset, 2),
        "text": str(segment.text).strip(),
    }
    for source, target in (
        ("avg_logprob", "avgLogProb"),
        ("compression_ratio", "compressionRatio"),
        ("no_speech_prob", "noSpeechProb"),
    ):
        value = getattr(segment, source, None)
        if value is not None:
            payload[target] = round(float(value), 5)
    if WORD_TIMESTAMPS and getattr(segment, "words", None):
        payload["words"] = [
            {
                "start": round(float(word.start) + offset, 2),
                "end": round(float(word.end) + offset, 2),
                "word": str(word.word),
                "probability": round(float(word.probability), 5),
            }
            for word in segment.words
        ]
    return payload


# ---------------------------------------------------------------------------
# Quality: hallucinations and repetition loops
# ---------------------------------------------------------------------------
# Whole-segment phrases Whisper is known to invent on silence/music, learnt
# from subtitle credits in its training data. Matched only against the WHOLE
# segment, so a lecturer saying "napisy" mid-sentence is never touched.
_HALLUCINATION_ALWAYS = [
    re.compile(r"^\W*napisy\s+(?:stworzone|wykonane|przygotowane|zrobione)\s+przez\s+spo[łl]eczno[śs][ćc]\s+amara\.org\W*$", re.IGNORECASE),
    re.compile(r"^.{0,40}\bamara\.org\b.{0,40}$", re.IGNORECASE),
    # "Napisy: Jan Kowalski", "Tłumaczenie i napisy: Anna Nowak" — a credit line:
    # keyword, colon, then only capitalised name-like words.
    re.compile(
        r"^\W*(?:[Nn]apisy|[Tt]łumaczenie|[Kk]orekta)(?:\s+i\s+(?:napisy|tłumaczenie|korekta))?\s*:\s*"
        r"[A-ZŁŚŻŹĆŃÓĘĄ][\w.-]*(?:\s+[A-ZŁŚŻŹĆŃÓĘĄ][\w.-]*){0,3}\W*$"
    ),
    re.compile(
        r"^\W*(?:zapraszam\s+do\s+subskrypcji|subskrybuj(?:cie)?(?:\s+(?:kanał|nas))?|"
        r"nie\s+zapomnij(?:cie)?\s+zasubskrybować.*|zostaw(?:cie)?\s+łapkę\s+w\s+górę.*)\W*$",
        re.IGNORECASE,
    ),
    re.compile(r"^\W*(?:sous-titres\s+réalisés|subtitles\s+by|untertitel\s+(?:von|im\s+auftrag)).{0,80}$", re.IGNORECASE),
]
# Plausible in real speech, so removed only when the model itself was unsure.
# ("Dziękuję za uwagę" is deliberately NOT here: lectures really end with it.)
_HALLUCINATION_IF_UNSURE = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"^\W*(?:dzięki|dziękuję|dziękujemy)\s+za\s+(?:obejrzenie|oglądanie)\W*$",
        r"^\W*do\s+zobaczenia\s+w\s+(?:następnym|kolejnym)\s+(?:odcinku|filmie)\W*$",
        r"^\W*(?:\[muzyka\]|\(muzyka\)|muzyka|♪+)\W*$",
    )
]


def _segment_unsure(segment: dict[str, Any]) -> bool:
    return float(segment.get("noSpeechProb") or 0) >= 0.35 or float(segment.get("avgLogProb") or 0) <= -0.85


def _collapse_repetitions(text: str, min_repeats: int = 4) -> tuple[str, bool]:
    """Collapse a phrase (1–12 words) repeated back-to-back >= min_repeats times.

    "i to jest i to jest i to jest i to jest" -> "i to jest". Real speech
    repeats a word twice, sometimes three times; four identical runs in a row
    is the classic decoder loop.
    """
    words = text.split()
    if len(words) < min_repeats * 1:
        return text, False
    changed = False
    size = 12
    while size >= 1:
        i = 0
        out: list[str] = []
        while i < len(words):
            unit = words[i:i + size]
            if len(unit) < size:
                out.extend(words[i:])
                break
            norm_unit = [w.lower().strip(".,;:!?…") for w in unit]
            repeats = 1
            j = i + size
            while j + size <= len(words) and [w.lower().strip(".,;:!?…") for w in words[j:j + size]] == norm_unit:
                repeats += 1
                j += size
            if repeats >= min_repeats:
                out.extend(unit)
                i = j
                changed = True
            else:
                out.append(words[i])
                i += 1
        words = out
        size -= 1
    return " ".join(words), changed


def _clean_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Drop hallucinated segments, collapse loops, drop 3+ identical repeats.

    Returns (kept_segments, report). Every removal is listed in the report with
    its time and text, so the UI can show what was filtered."""
    report: dict[str, Any] = {"removed": [], "collapsed": 0, "suspicious": 0}
    if not HALLUCINATION_FILTER:
        return segments, report
    kept: list[dict[str, Any]] = []
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        if any(rx.match(text) for rx in _HALLUCINATION_ALWAYS) or (
            _segment_unsure(segment) and any(rx.match(text) for rx in _HALLUCINATION_IF_UNSURE)
        ):
            report["removed"].append({"start": segment.get("start"), "text": text[:160], "reason": "hallucination"})
            continue
        collapsed, changed = _collapse_repetitions(text)
        if changed:
            segment = {**segment, "text": collapsed, "collapsedLoop": True}
            report["collapsed"] += 1
        # identical text three or more times in a row (e.g. "Dziękuję." x5)
        if (
            len(kept) >= 2
            and len(collapsed) > 3
            and kept[-1].get("text", "").strip().lower() == collapsed.lower()
            and kept[-2].get("text", "").strip().lower() == collapsed.lower()
        ):
            report["removed"].append({"start": segment.get("start"), "text": collapsed[:160], "reason": "repeat"})
            continue
        kept.append(segment)
    report["suspicious"] = sum(1 for seg in kept if _needs_repair(seg))
    return kept, report


def _needs_repair(segment: dict[str, Any]) -> bool:
    return bool(segment.get("collapsedLoop")) or float(segment.get("compressionRatio") or 0) > REPAIR_COMPRESSION_RATIO


def _decode_audio(path: str):
    """Decode once to 16 kHz mono float32 so resume/repair can slice it.

    Batched inference decodes the whole file into memory anyway, so this does
    not add peak memory; it only avoids decoding twice."""
    from faster_whisper import decode_audio

    return decode_audio(path, sampling_rate=16000)


def _repair_segments(
    job: dict[str, Any],
    audio: Any,
    segments: list[dict[str, Any]],
    base_kwargs: dict[str, Any],
) -> int:
    """Re-decode suspicious segments with the sequential decoder (temperature
    fallback on). A replacement is accepted only if it is non-empty and no
    longer loops. Returns the number of repaired segments."""
    if not REPAIR_PASS or audio is None or not hasattr(audio, "shape"):
        return 0
    targets = [i for i, seg in enumerate(segments) if _needs_repair(seg)][:REPAIR_MAX_SEGMENTS]
    if not targets:
        return 0
    model = get_model(job.get("modelName"))
    sr = 16000
    started = _timestamp()
    repaired = 0
    _mark_job(job, f"Naprawiam {len(targets)} podejrzany(ch) fragment(ów)…", 0.995, "repairing")
    for index in targets:
        _check_cancelled(job)
        if _timestamp() - started > REPAIR_MAX_SECONDS:
            _job_event(job, "Limit czasu naprawy — pozostałe fragmenty zostawiono do ręcznego sprawdzenia.")
            break
        seg = segments[index]
        start = max(0.0, float(seg["start"]) - 0.3)
        end = min(audio.shape[0] / sr, float(seg["end"]) + 0.3)
        if end - start < 0.4:
            continue
        clip = audio[int(start * sr):int(end * sr)]
        try:
            with _model_lock:
                pieces, _info = model.transcribe(
                    clip,
                    language=base_kwargs.get("language"),
                    beam_size=5,
                    best_of=5,
                    temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                    compression_ratio_threshold=REPAIR_COMPRESSION_RATIO,
                    condition_on_previous_text=False,
                    vad_filter=False,
                    initial_prompt=base_kwargs.get("initial_prompt"),
                    hotwords=base_kwargs.get("hotwords"),
                    without_timestamps=True,
                )
                text = " ".join(str(p.text).strip() for p in pieces).strip()
        except Exception as exc:  # a failed repair keeps the original segment
            logger.warning("job=%s phase=repairing segment %d failed: %s", job["jobId"], index, exc)
            continue
        text, looped = _collapse_repetitions(text)
        from faster_whisper.transcribe import get_compression_ratio

        if text and not looped and get_compression_ratio(text) <= REPAIR_COMPRESSION_RATIO:
            segments[index] = {
                **seg,
                "text": text,
                "repaired": True,
                "originalText": seg.get("text"),
                "compressionRatio": round(get_compression_ratio(text), 5),
            }
            segments[index].pop("collapsedLoop", None)
            repaired += 1
    if repaired:
        _job_event(job, f"Naprawiono {repaired} zapętlony(ch) fragment(ów) dekoderem z fallbackiem temperatury.")
    return repaired


def _transcription_kwargs(
    language: str,
    initial_prompt: str,
    hotwords: str,
    processing_profile: str = "balanced",
    batch_size: int | None = None,
) -> dict[str, Any]:
    profile = (
        {"beam_size": BEAM_SIZE, "best_of": max(1, BEAM_SIZE), "batch_size": BATCH_SIZE}
        if processing_profile == "balanced"
        else PROCESSING_PROFILES.get(processing_profile, PROCESSING_PROFILES["balanced"])
    )
    effective_batch = profile["batch_size"] if batch_size is None else batch_size
    lang = (language or LANGUAGE or "").strip().lower()
    kwargs: dict[str, Any] = {
        "language": None if lang in {"", "auto"} else lang,
        "beam_size": profile["beam_size"],
        "best_of": profile["best_of"],
        "vad_filter": True,
        "vad_parameters": {
            "min_silence_duration_ms": VAD_MIN_SILENCE_MS,
            "min_speech_duration_ms": VAD_MIN_SPEECH_MS,
            "speech_pad_ms": VAD_SPEECH_PAD_MS,
        },
        "initial_prompt": initial_prompt or None,
        "hotwords": hotwords or None,
        "word_timestamps": WORD_TIMESTAMPS,
        "log_prob_threshold": LOG_PROB_THRESHOLD,
        "no_speech_threshold": NO_SPEECH_THRESHOLD,
        "log_progress": LOG_PROGRESS,
    }
    if WORD_TIMESTAMPS:
        kwargs["hallucination_silence_threshold"] = HALLUCINATION_SILENCE_THRESHOLD
    if BATCH_SIZE > 1 and effective_batch > 1:
        kwargs["batch_size"] = effective_batch
        # BatchedInferencePipeline 1.2.1 forces condition_on_previous_text off
        # internally; it defaults to without_timestamps=True (one segment per
        # 30 s VAD chunk). Timestamps on = sentence-sized segments.
        kwargs["without_timestamps"] = not FINE_SEGMENTS
    else:
        kwargs["condition_on_previous_text"] = False
    return kwargs


def _run_transcription(
    job: dict[str, Any],
    language: str,
    initial_prompt: str = "",
    hotwords: str = "",
    processing_profile: str = "balanced",
) -> None:
    with _jobs_lock:
        if job["_cancel"].is_set():
            _finish_job(job, "cancelled", "Anulowano przed rozpoczęciem.")
            _cleanup_tmp(job)
            return
        job["started_at"] = _timestamp()
    _mark_job(job, "Ładuję model transkrypcji…", 0.005, "loading_model", "running")
    logger.info("job=%s phase=loading_model started filename=%r", job["jobId"], job.get("filename"))
    heartbeat_stop = threading.Event()
    heartbeat_thread = threading.Thread(
        target=_job_heartbeat_loop,
        args=(job, heartbeat_stop),
        name=f"skryptorium-heartbeat-{job['jobId']}",
        daemon=True,
    )
    heartbeat_thread.start()

    segments: list[dict[str, Any]] = []
    texts: list[str] = []
    audio_state: dict[str, Any] = {"audio": None, "path": None, "total": None, "prepared": False}
    profile = PROCESSING_PROFILES.get(processing_profile, PROCESSING_PROFILES["balanced"])
    batch_state = {"batch": int(job.get("batchSize") or profile["batch_size"]), "freed": False}

    def prepare_audio() -> None:
        audio_state["prepared"] = True
        _check_cancelled(job)
        input_path = _preprocess_audio(job, job["_tmp"])
        audio_state["path"] = input_path
        _check_cancelled(job)
        _mark_job(job, "Dekoduję audio…", 0.01, "decoding")
        try:
            audio = _decode_audio(input_path)
        except Exception as exc:  # the model call below reports a real decode error
            logger.info("job=%s phase=decoding pre-decode skipped (%s); model decodes the file", job["jobId"], type(exc).__name__)
            audio = None
        audio_state["audio"] = audio
        if audio is not None and hasattr(audio, "shape"):
            audio_state["total"] = round(audio.shape[0] / 16000, 2)
            with _jobs_lock:
                job["durationSec"] = audio_state["total"]

    def perform(offset: float = 0.0) -> None:
        """Transcribe from `offset` seconds, appending to `segments`."""
        _check_cancelled(job)
        model = get_transcription_model(job.get("modelName"))
        _check_cancelled(job)
        if not audio_state["prepared"]:
            prepare_audio()
            _check_cancelled(job)
        if (
            FREE_OLLAMA_VRAM
            and _model_meta.get("device") == "cuda"
            and not batch_state["freed"]
        ):
            batch_state["freed"] = True
            _mark_job(job, "Zwalniam pamięć GPU zajętą przez Ollamę…", 0.015, "free_vram")
            unloaded = _free_ollama_vram(job)
            if unloaded:
                _job_event(job, "Zwolniono VRAM: odładowano " + ", ".join(unloaded) + ".")
        _mark_job(job, "Czekam na dostęp do modelu…", 0.02, "waiting_for_model")
        with _model_lock:
            _check_cancelled(job)
            kwargs = _transcription_kwargs(language, initial_prompt, hotwords, processing_profile, batch_state["batch"])
            with _jobs_lock:
                job["batchSize"] = kwargs.get("batch_size", 1)
            _mark_job(job, "Transkrypcja ruszyła; czekam na segmenty…", 0.03, "transcribing")
            audio = audio_state["audio"]
            if audio is not None and hasattr(audio, "shape"):
                source = audio[int(offset * 16000):] if offset > 0 else audio
            else:
                source = audio_state["path"] or job["_tmp"]
                offset = 0.0
            segments_iter, info = model.transcribe(source, **kwargs)
            total = float(audio_state["total"] or 0.0) or (float(info.duration or 0.0) + offset)
            total = max(total, 0.001)
            with _jobs_lock:
                job["durationSec"] = round(total, 2)
                job["language"] = info.language or (language or LANGUAGE)
                after_vad = getattr(info, "duration_after_vad", None)
                if after_vad is not None and offset == 0:
                    job["speechSec"] = round(float(after_vad), 1)
                if not job.get("transcribeStartedAt"):
                    job["transcribeStartedAt"] = _timestamp()
                    job["_processed_base"] = offset
            for segment in segments_iter:
                _check_cancelled(job)
                payload = _segment_payload(segment, offset)
                if payload["text"]:
                    segments.append(payload)
                    texts.append(payload["text"])
                    # Checkpoint visible to polling/cancellation clients.
                    with _jobs_lock:
                        job["segments"] = segments
                        job["transcript"] = " ".join(texts).strip()
                processed = min(float(payload["end"]), total)
                with _jobs_lock:
                    job["processedSec"] = processed
                    spent = max(0.5, _timestamp() - float(job["transcribeStartedAt"]))
                    done_audio = max(0.0, processed - float(job.get("_processed_base") or 0.0))
                    if done_audio > 1:
                        speed = done_audio / spent
                        job["speedX"] = round(speed, 2)
                        job["etaSec"] = round(max(0.0, total - processed) / max(speed, 0.01), 0)
                _mark_job(job, "Transkrybuję audio…", min(processed / total, 0.99), "transcribing")

    def resume_offset() -> float:
        if audio_state["audio"] is None or not segments:
            segments.clear()
            texts.clear()
            with _jobs_lock:
                job["segments"] = []
                job["transcript"] = ""
            return 0.0
        return float(segments[-1]["end"])

    try:
        offset = 0.0
        attempts = 0
        while True:
            try:
                perform(offset)
                break
            except JobCancelled:
                raise
            except Exception as exc:
                attempts += 1
                if attempts > 6 or not _is_cuda_lib_error(exc) or _model_meta.get("device") == "cpu":
                    raise
                offset = resume_offset()
                where = f" od {offset:.0f} s" if offset else ""
                if _is_oom_error(exc) and not batch_state["freed"]:
                    batch_state["freed"] = True
                    unloaded = _free_ollama_vram(job)
                    _gpu_state["oomRetries"] += 1
                    _job_event(job, "Brak VRAM — zwolniono pamięć Ollamy" + (f" ({', '.join(unloaded)})" if unloaded else "") + f", ponawiam na GPU{where}.")
                    _mark_job(job, "Brak pamięci GPU — zwalniam VRAM i ponawiam…", None, "gpu_retry")
                    continue
                if _is_oom_error(exc) and batch_state["batch"] > 1:
                    batch_state["batch"] = max(1, batch_state["batch"] // 2)
                    _gpu_state["oomRetries"] += 1
                    _job_event(job, f"Brak VRAM — zmniejszam batch do {batch_state['batch']} i kontynuuję na GPU{where}.")
                    _mark_job(job, f"Brak pamięci GPU — batch {batch_state['batch']}, ponawiam…", None, "gpu_retry")
                    with contextlib.suppress(Exception):
                        import gc

                        gc.collect()
                    continue
                logger.exception("job=%s phase=fallback_cpu GPU transcription failed", job["jobId"])
                _mark_job(job, "GPU niedostępne. Przełączam na CPU i kontynuuję…", None, "fallback_cpu")
                _job_event(job, f"GPU zawiodło ({type(exc).__name__}) — kontynuuję na CPU{where}. GPU zostanie ponowione za {GPU_RETRY_COOLDOWN_SEC / 60:.0f} min.")
                _fallback_to_cpu(str(exc))
                batch_state["batch"] = int(job.get("batchSize") or profile["batch_size"]) or 1
        _check_cancelled(job)
        _mark_job(job, "Kontrola jakości transkryptu…", 0.992, "quality")
        cleaned, report = _clean_segments(segments)
        repaired = 0
        if report.get("suspicious"):
            base_kwargs = _transcription_kwargs(language, initial_prompt, hotwords, processing_profile)
            repaired = _repair_segments(job, audio_state["audio"], cleaned, base_kwargs)
        report["repaired"] = repaired
        report["unresolved"] = sum(1 for seg in cleaned if _needs_repair(seg))
        _check_cancelled(job)
        _mark_job(job, "Finalizuję transkrypt…", 0.999, "finalizing")
        with _jobs_lock:
            _check_cancelled(job)
            job["segments"] = cleaned
            job["transcript"] = " ".join(seg["text"] for seg in cleaned).strip()
            job["quality"] = {
                "removed": report["removed"][:50],
                "removedCount": len(report["removed"]),
                "collapsedLoops": report["collapsed"],
                "repaired": repaired,
                "unresolved": report["unresolved"],
                "fineSegments": FINE_SEGMENTS,
            }
            if job.get("transcribeStartedAt"):
                spent = max(0.5, _timestamp() - float(job["transcribeStartedAt"]))
                job["speedX"] = round(float(job.get("durationSec") or 0) / spent, 2) if job.get("durationSec") else job.get("speedX")
            job["etaSec"] = 0
            # Pliki tymczasowe sprzątamy PRZED publikacją statusu końcowego, żeby
            # klient widzący "done/error/cancelled" miał gwarancję zwolnionych zasobów.
            _cleanup_tmp(job)
            _finish_job(job, "done", "Transkrypcja gotowa.")
        logger.info(
            "job=%s phase=done duration=%.2fs segments=%d transcript_chars=%d removed=%d repaired=%d speed=%sx",
            job["jobId"],
            float(job.get("durationSec") or 0),
            len(cleaned),
            len(job["transcript"]),
            len(report["removed"]),
            repaired,
            job.get("speedX"),
        )
    except JobCancelled:
        _cleanup_tmp(job)
        _finish_job(job, "cancelled", "Transkrypcja anulowana przez użytkownika.")
        logger.info("job=%s phase=cancelled cancellation complete", job["jobId"])
    except Exception as exc:  # heavy worker boundary
        logger.exception("job=%s phase=error transcription failed", job["jobId"])
        _cleanup_tmp(job)
        _finish_job(job, "error", "Transkrypcja nie powiodła się.", str(exc))
    finally:
        audio_state["audio"] = None
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=1)
        _cleanup_tmp(job)


def _submit_transcription(
    job: dict[str, Any], language: str, initial_prompt: str, hotwords: str, processing_profile: str = "balanced"
) -> Future:
    future = _job_executor.submit(_run_transcription, job, language, initial_prompt, hotwords, processing_profile)
    with _jobs_lock:
        job["_future"] = future
    return future


def _copy_upload_to_temp(job: dict[str, Any], upload: UploadFile) -> tuple[str, int]:
    fd, tmp_path = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=TEMP_AUDIO_SUFFIX)
    job["_tmp"] = tmp_path
    job["_tmp_files"].append(tmp_path)
    total = 0
    try:
        with os.fdopen(fd, "wb") as output:
            while True:
                chunk = upload.file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise UploadTooLarge()
                output.write(chunk)
        if total == 0:
            raise ValueError("Pusty plik audio.")
        job["bytes"] = total
        return tmp_path, total
    except Exception:
        with contextlib.suppress(OSError):
            os.close(fd)
        _cleanup_tmp(job)
        raise
    finally:
        upload.file.close()


@app.get("/api/health")
def health():
    device, compute = _model_meta["device"], _model_meta["compute_type"]
    predicted = device is None
    if device is None:
        device, compute = _pick_device_compute()
    with _jobs_lock:
        counts = {status: sum(1 for job in _jobs.values() if job["status"] == status) for status in (
            "queued", "running", "done", "error", "cancelled"
        )}
    cpu_until = max(0.0, _force_cpu_until - _timestamp())
    return {
        "ok": True,
        "engine": "faster-whisper",
        "engineVersion": 4,
        "model": _model_meta.get("name") or MODEL_NAME,
        "defaultModel": MODEL_NAME,
        "allowedModels": ALLOWED_MODELS,
        "device": device,
        "devicePredicted": predicted,
        "computeType": compute,
        "cudaDevices": _cuda_device_count(),
        "cpuFallbackRemainingSec": round(cpu_until) if cpu_until else 0,
        "gpu": dict(_gpu_state),
        "language": LANGUAGE,
        "modelLoaded": _model is not None,
        "beamSize": BEAM_SIZE,
        "batchSize": BATCH_SIZE,
        "cpuThreads": CPU_THREADS,
        "wordTimestamps": WORD_TIMESTAMPS,
        "logProgress": LOG_PROGRESS,
        "warmup": dict(_warmup_state),
        "maxUploadBytes": MAX_UPLOAD_BYTES,
        "preprocessAudio": PREPROCESS_AUDIO,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "features": {
            "fineSegments": FINE_SEGMENTS,
            "hallucinationFilter": HALLUCINATION_FILTER,
            "repairPass": REPAIR_PASS,
            "freeOllamaVram": FREE_OLLAMA_VRAM,
            "incrementalSegments": True,
            "perJobModel": True,
            "perJobPreprocess": True,
        },
        "authRequired": bool(API_TOKEN),
        "jobs": counts,
    }


@app.post("/api/transcribe")
def transcribe(
    request: Request,
    file: UploadFile = File(...),
    background: str = Form("0"),
    language: str = Form(""),
    initial_prompt: str = Form(""),
    hotwords: str = Form(""),
    processing_profile: str = Form("balanced"),
    model: str = Form(""),
    preprocess: str = Form("0"),
):
    """Store the upload in bounded chunks, then enqueue transcription.

    This is deliberately a synchronous FastAPI endpoint, so multipart copying
    and an optional blocking compatibility wait run in Starlette's threadpool
    instead of blocking the ASGI event loop.
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            # Multipart framing is allowed a small margin; byte counting below is authoritative.
            if int(content_length) > MAX_UPLOAD_BYTES + 2 * 1024 * 1024:
                return JSONResponse(
                    status_code=413,
                    content={"error": f"Plik jest za duży. Limit audio to {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."},
                )
        except ValueError:
            pass

    job = _new_job()
    job["filename"] = file.filename
    initial_prompt = initial_prompt.strip()[:8000]
    hotwords = hotwords.strip()[:4000]
    job["initialPromptUsed"] = bool(initial_prompt)
    job["hotwordsUsed"] = bool(hotwords)
    processing_profile = processing_profile.strip().lower()
    if processing_profile not in PROCESSING_PROFILES:
        processing_profile = "balanced"
    profile = PROCESSING_PROFILES[processing_profile]
    job["processingProfile"] = processing_profile
    job["beamSize"] = profile["beam_size"]
    job["batchSize"] = profile["batch_size"]
    job["modelName"] = _resolve_model_name(model)
    job["preprocess"] = str(preprocess).strip().lower() in {"1", "true", "yes", "on"}
    try:
        _tmp_path, byte_count = _copy_upload_to_temp(job, file)
    except UploadTooLarge:
        _finish_job(job, "error", "Upload odrzucony: przekroczony limit.", "Plik jest za duży.")
        with _jobs_lock:
            _jobs.pop(job["jobId"], None)
        return JSONResponse(
            status_code=413,
            content={"error": f"Plik jest za duży. Limit audio to {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."},
        )
    except ValueError as exc:
        with _jobs_lock:
            _jobs.pop(job["jobId"], None)
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except Exception as exc:
        logger.exception("job=%s phase=upload upload failed", job["jobId"])
        _finish_job(job, "error", "Nie udało się zapisać uploadu.", str(exc))
        return JSONResponse(status_code=500, content=_public_job(job))

    lang = language.strip() or LANGUAGE
    logger.info("job=%s phase=queued filename=%r bytes=%d lang=%s", job["jobId"], file.filename, byte_count, lang)
    future = _submit_transcription(job, lang, initial_prompt, hotwords, processing_profile)
    if str(background).strip().lower() in {"1", "true", "yes"}:
        return {"jobId": job["jobId"], "status": job["status"], "queuePosition": _queue_position(job)}

    # Backward-compatible blocking mode. The request thread waits; ASGI remains responsive.
    future.result()
    status_code = 200 if job["status"] == "done" else (409 if job["status"] == "cancelled" else 500)
    return JSONResponse(status_code=status_code, content=_public_job(job))


@app.get("/api/transcribe/{job_id}")
def transcribe_status(job_id: str, since: int | None = None):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Nie ma takiego jobu."})
    return _public_job(job, since)


@app.delete("/api/transcribe/{job_id}")
def transcribe_delete(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return JSONResponse(status_code=404, content={"error": "Nie ma takiego jobu."})
        status = job["status"]
        if status in {"done", "error", "cancelled"}:
            _jobs.pop(job_id, None)
            _cleanup_tmp(job)
            return {"ok": True, "status": status, "removed": True}
        job["_cancel"].set()
        _mark_job(job, "Żądanie anulowania przyjęte; czekam na bezpieczny punkt…", phase="cancelling")
        future: Future | None = job.get("_future")
        if status == "queued" and future is not None and future.cancel():
            _finish_job(job, "cancelled", "Anulowano zadanie oczekujące w kolejce.")
            _cleanup_tmp(job)
            return JSONResponse(status_code=200, content={"ok": True, "status": "cancelled", "removed": False})
    return JSONResponse(status_code=202, content={"ok": True, "status": "cancelling", "removed": False})


def _ollama_request(path: str, payload: dict[str, Any] | None = None, timeout: int = 10) -> dict[str, Any]:
    url = OLLAMA_URL + path
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


_model_context_cache: dict[str, int] = {}


def _ollama_model_context(model: str) -> int | None:
    if model in _model_context_cache:
        return _model_context_cache[model]
    try:
        data = _ollama_request("/api/show", {"model": model}, timeout=10)
        values = [
            int(value)
            for key, value in (data.get("model_info") or {}).items()
            if str(key).endswith(".context_length") and isinstance(value, (int, float))
        ]
        if values:
            _model_context_cache[model] = max(values)
            return _model_context_cache[model]
    except Exception:
        return None
    return None


def _safe_ollama_options(model: str, options: dict[str, Any] | None) -> dict[str, Any]:
    incoming = options or {}
    model_limit = _ollama_model_context(model)
    hard_limit = min(OLLAMA_MAX_CTX, model_limit) if model_limit else OLLAMA_MAX_CTX
    requested_ctx = int(incoming.get("num_ctx", OLLAMA_NUM_CTX))
    requested_predict = int(incoming.get("num_predict", OLLAMA_NUM_PREDICT))
    temperature = float(incoming.get("temperature", OLLAMA_TEMPERATURE))
    return {
        "num_ctx": max(2048, min(requested_ctx, hard_limit)),
        "num_predict": max(128, min(requested_predict, 16384)),
        "temperature": max(0.0, min(temperature, 2.0)),
    }


def _ollama_generate(
    model: str,
    prompt: str,
    expects_json: bool = False,
    options: dict[str, Any] | None = None,
    timeout: int | None = None,
    json_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": OLLAMA_KEEPALIVE,
        "options": _safe_ollama_options(model, options),
    }
    if expects_json:
        body["format"] = json_schema if isinstance(json_schema, dict) else "json"
    return _ollama_request("/api/generate", body, timeout=timeout or OLLAMA_TIMEOUT)


def _retry_ollama(operation, attempts: int = 4):
    for attempt in range(attempts):
        try:
            return operation()
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 502, 503, 504} or attempt == attempts - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == attempts - 1:
                raise
        delay = min(8.0, 2.0 ** (attempt + 1)) + random.random() * 0.3
        time.sleep(delay)
    raise RuntimeError("Ollama retry exhausted")


@app.get("/api/ollama/health")
def ollama_health():
    try:
        data = _ollama_request("/api/tags", timeout=5)
        models = [model.get("name", "") for model in data.get("models", [])]
        return {
            "ok": True,
            "engine": "ollama",
            "models": models,
            "defaultModel": OLLAMA_MODEL,
            "numCtx": OLLAMA_NUM_CTX,
            "numPredict": OLLAMA_NUM_PREDICT,
        }
    except Exception:
        return {"ok": False, "error": "Nie wykryto Ollamy"}


def _ollama_error_response(exc: BaseException) -> JSONResponse:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", "")
        except Exception:
            detail = ""
        return JSONResponse(status_code=exc.code, content={"error": detail or f"Ollama HTTP {exc.code}"})
    if isinstance(exc, (urllib.error.URLError, TimeoutError)):
        return JSONResponse(status_code=502, content={"error": "Nie wykryto Ollamy lub przekroczono czas odpowiedzi."})
    logger.exception("phase=ollama request failed")
    return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/api/ollama/generate")
def ollama_generate(payload: dict[str, Any] = Body(...)):
    model = str(payload.get("model") or OLLAMA_MODEL).strip()
    prompt = str(payload.get("prompt") or "")
    expects_json = bool(payload.get("expectsJson"))
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    json_schema = payload.get("jsonSchema") if isinstance(payload.get("jsonSchema"), dict) else None
    if not prompt.strip():
        return JSONResponse(status_code=400, content={"error": "Pusty prompt."})
    logger.info("phase=ollama_generate model=%s prompt_chars=%d", model, len(prompt))
    try:
        return _retry_ollama(lambda: _ollama_generate(model, prompt, expects_json, options, json_schema=json_schema))
    except Exception as exc:
        return _ollama_error_response(exc)


if __name__ == "__main__":
    device, compute = _pick_device_compute()
    logger.info(
        "starting url=http://%s:%d model=%s device=%s compute=%s beam=%d batch=%d max_upload_mb=%d auth=%s",
        HOST,
        PORT,
        MODEL_NAME,
        device,
        compute,
        BEAM_SIZE,
        BATCH_SIZE,
        MAX_UPLOAD_BYTES // (1024 * 1024),
        "required" if API_TOKEN else "off",
    )
    uvicorn.run(app, host=HOST, port=PORT, timeout_keep_alive=120)
