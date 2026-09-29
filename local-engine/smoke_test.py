# -*- coding: utf-8 -*-
"""Regression suite runnable without downloading or loading a Whisper model."""

from __future__ import annotations

import importlib
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from fastapi.testclient import TestClient

import server


class FakeInfo:
    duration = 4.0
    language = "pl"


class FakeSegment:
    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text
        self.avg_logprob = -0.2
        self.compression_ratio = 1.1
        self.no_speech_prob = 0.01
        self.words = None


class BlockingModel:
    def __init__(self, gate: threading.Event | None = None, release: threading.Event | None = None):
        self.gate = gate
        self.release = release

    def transcribe(self, _path, **_kwargs):
        def segments():
            if self.gate:
                self.gate.set()
            if self.release:
                self.release.wait(timeout=5)
            yield FakeSegment(0, 2, "Pierwszy segment")
            yield FakeSegment(2, 4, "Drugi segment")

        return segments(), FakeInfo()


class FailingModel:
    def __init__(self, gate=None, release=None):
        self.gate = gate
        self.release = release

    def transcribe(self, _path, **_kwargs):
        if self.gate:
            self.gate.set()
        if self.release:
            self.release.wait(timeout=5)
        raise RuntimeError("synthetic transcription failure")


class ServerRegressionTests(unittest.TestCase):
    def setUp(self):
        server._job_executor.shutdown(wait=True, cancel_futures=True)
        server._job_executor = server.ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-transcribe")
        with server._jobs_lock:
            for job in server._jobs.values():
                server._cleanup_tmp(job)
            server._jobs.clear()
        self.client = TestClient(server.app)

    def tearDown(self):
        server._job_executor.shutdown(wait=True, cancel_futures=True)

    def wait_for(self, job_id, status, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            data = self.client.get(f"/api/transcribe/{job_id}").json()
            if data.get("status") in status:
                return data
            time.sleep(0.02)
        self.fail(f"Job {job_id} did not reach {status}")

    def direct_job_with_tempfile(self):
        job = server._new_job()
        fd, path = tempfile.mkstemp(prefix=server.TEMP_PREFIX, suffix=server.TEMP_AUDIO_SUFFIX)
        os.write(fd, b"audio")
        os.close(fd)
        job["_tmp"] = path
        job["_tmp_files"].append(path)
        return job, Path(path)

    def test_transcription_kwargs_are_supported_and_typed(self):
        kwargs = server._transcription_kwargs("pl", "Kontekst", "Nazwisko")
        self.assertEqual(kwargs["language"], "pl")
        self.assertIs(kwargs["word_timestamps"], server.WORD_TIMESTAMPS)
        self.assertIsInstance(kwargs["log_prob_threshold"], float)
        self.assertIsInstance(kwargs["no_speech_threshold"], float)
        self.assertIsInstance(kwargs["log_progress"], bool)
        self.assertEqual(kwargs["vad_parameters"]["min_speech_duration_ms"], server.VAD_MIN_SPEECH_MS)
        self.assertEqual(kwargs["vad_parameters"]["min_silence_duration_ms"], server.VAD_MIN_SILENCE_MS)
        self.assertEqual(kwargs["vad_parameters"]["speech_pad_ms"], server.VAD_SPEECH_PAD_MS)
        if server.BATCH_SIZE > 1:
            self.assertNotIn("condition_on_previous_text", kwargs)
            self.assertEqual(kwargs["batch_size"], server.BATCH_SIZE)
        previous = server.BATCH_SIZE
        try:
            server.BATCH_SIZE = 1
            plain = server._transcription_kwargs("pl", "", "")
            self.assertIs(plain["condition_on_previous_text"], False)
            self.assertNotIn("batch_size", plain)
        finally:
            server.BATCH_SIZE = previous

    def test_installed_faster_whisper_supports_quality_arguments(self):
        import inspect
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        for method in (WhisperModel.transcribe, BatchedInferencePipeline.transcribe):
            parameters = inspect.signature(method).parameters
            for expected in ("initial_prompt", "hotwords", "word_timestamps", "hallucination_silence_threshold", "log_progress"):
                self.assertIn(expected, parameters)
        from faster_whisper.vad import VadOptions
        vad_fields = VadOptions.__dataclass_fields__
        for expected in ("min_speech_duration_ms", "min_silence_duration_ms", "speech_pad_ms"):
            self.assertIn(expected, vad_fields)

    def test_processing_profiles_change_quality_and_are_reported(self):
        fast = server._transcription_kwargs("pl", "", "", "fast")
        balanced = server._transcription_kwargs("pl", "", "", "balanced")
        archive = server._transcription_kwargs("pl", "", "", "archive")
        self.assertEqual((fast["beam_size"], fast["best_of"], fast["batch_size"]), (1, 1, 8))
        self.assertEqual((balanced["beam_size"], balanced["batch_size"]), (server.BEAM_SIZE, server.BATCH_SIZE))
        self.assertEqual((archive["beam_size"], archive["best_of"], archive["batch_size"]), (4, 4, 4))
        job = server._new_job()
        job["processingProfile"] = "archive"
        job["beamSize"] = 4
        job["batchSize"] = 4
        public = server._public_job(job)
        self.assertEqual(public["processingProfile"], "archive")
        self.assertEqual(public["beamSize"], 4)
        self.assertEqual(public["batchSize"], 4)

    def test_fast_defaults_and_routes(self):
        self.assertEqual(server.MODEL_NAME, "turbo")
        self.assertEqual(server.BEAM_SIZE, 2)
        self.assertEqual(server.BATCH_SIZE, 8)
        paths = {route.path for route in server.app.routes}
        for path in ("/api/health", "/api/transcribe", "/api/transcribe/{job_id}", "/api/ollama/generate"):
            self.assertIn(path, paths)
        self.assertNotIn("/api/ollama/longtask", paths)

    def test_health_responds_during_transcription_and_job_finishes(self):
        entered = threading.Event()
        release = threading.Event()
        with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel(entered, release)):
            response = self.client.post(
                "/api/transcribe",
                files={"file": ("test.wav", b"fake audio", "audio/wav")},
                data={"background": "1", "initial_prompt": "Nazwisko", "hotwords": "Skryptorium", "processing_profile": "archive"},
            )
            self.assertEqual(response.status_code, 200)
            job_id = response.json()["jobId"]
            self.assertTrue(entered.wait(timeout=2))
            started = time.perf_counter()
            health = self.client.get("/api/health")
            self.assertLess(time.perf_counter() - started, 0.5)
            self.assertEqual(health.status_code, 200)
            with mock.patch.object(server, "_ollama_generate", return_value={"response": "ok"}):
                ollama = self.client.post("/api/ollama/generate", json={"prompt": "test", "model": "fake"})
            self.assertEqual(ollama.status_code, 200)
            self.assertEqual(ollama.json()["response"], "ok")
            release.set()
            result = self.wait_for(job_id, {"done"})
            self.assertEqual(len(result["segments"]), 2)
            self.assertTrue(result["initialPromptUsed"])
            self.assertTrue(result["hotwordsUsed"])
            self.assertEqual(result["processingProfile"], "archive")
            self.assertEqual(result["beamSize"], 4)
            self.assertEqual(result["batchSize"], 4)

    def test_second_job_is_queued_and_cancel_does_not_remove_active_file(self):
        entered = threading.Event()
        release = threading.Event()
        with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel(entered, release)):
            first = self.client.post(
                "/api/transcribe", files={"file": ("one.wav", b"one", "audio/wav")}, data={"background": "1"}
            ).json()
            self.assertTrue(entered.wait(timeout=2))
            second = self.client.post(
                "/api/transcribe", files={"file": ("two.wav", b"two", "audio/wav")}, data={"background": "1"}
            ).json()
            queued = self.client.get(f"/api/transcribe/{second['jobId']}").json()
            self.assertEqual(queued["status"], "queued")
            self.assertEqual(queued["queuePosition"], 1)

            with server._jobs_lock:
                temp_path = server._jobs[first["jobId"]]["_tmp"]
            cancelled = self.client.delete(f"/api/transcribe/{first['jobId']}")
            self.assertEqual(cancelled.status_code, 202)
            self.assertTrue(Path(temp_path).exists(), "DELETE must not unlink a file still used by the worker")
            release.set()
            first_result = self.wait_for(first["jobId"], {"cancelled"})
            self.assertEqual(first_result["status"], "cancelled")
            self.assertFalse(Path(temp_path).exists())
            self.wait_for(second["jobId"], {"done"})

    def test_upload_limit_without_trusting_content_length(self):
        previous = server.MAX_UPLOAD_BYTES
        server.MAX_UPLOAD_BYTES = 4
        try:
            response = self.client.post(
                "/api/transcribe", files={"file": ("big.wav", b"12345", "audio/wav")}, data={"background": "1"}
            )
            self.assertEqual(response.status_code, 413)
            self.assertIn("za duży", response.json()["error"])
            with server._jobs_lock:
                self.assertFalse(server._jobs)
        finally:
            server.MAX_UPLOAD_BYTES = previous

    def test_interrupted_upload_cleans_its_tempfile(self):
        class BrokenStream:
            calls = 0
            def read(self, _size):
                self.calls += 1
                if self.calls == 1: return b"partial"
                raise OSError("client disconnected")
            def close(self): pass
        upload = mock.Mock()
        upload.file = BrokenStream()
        job = server._new_job()
        with self.assertRaisesRegex(OSError, "disconnected"):
            server._copy_upload_to_temp(job, upload)
        self.assertTrue(job["_cleanup_done"])
        self.assertIsNone(job["_tmp"])
        self.assertEqual(job["_tmp_files"], [])

    def test_preprocessing_missing_or_failed_ffmpeg_falls_back(self):
        job, source = self.direct_job_with_tempfile()
        previous = server.PREPROCESS_AUDIO
        server.PREPROCESS_AUDIO = True
        try:
            with mock.patch.object(server.shutil, "which", return_value=None):
                self.assertEqual(server._preprocess_audio(job, str(source)), str(source))
            failed = mock.Mock()
            failed.poll.return_value = 1
            failed.returncode = 1
            with mock.patch.object(server.shutil, "which", return_value="ffmpeg"), \
                 mock.patch.object(server.subprocess, "Popen", return_value=failed):
                self.assertEqual(server._preprocess_audio(job, str(source)), str(source))
        finally:
            server.PREPROCESS_AUDIO = previous
            server._cleanup_tmp(job)
        self.assertFalse(source.exists())

    def test_error_status_and_tempfile_cleanup(self):
        entered = threading.Event()
        release = threading.Event()
        with mock.patch.object(server, "get_transcription_model", return_value=FailingModel(entered, release)):
            response = self.client.post(
                "/api/transcribe", files={"file": ("bad.wav", b"broken", "audio/wav")}, data={"background": "1"}
            )
            job_id = response.json()["jobId"]
            self.assertTrue(entered.wait(timeout=2))
            with server._jobs_lock:
                temp_path = server._jobs[job_id]["_tmp"]
            release.set()
            result = self.wait_for(job_id, {"error"})
            self.assertIn("synthetic transcription failure", result["error"])
            self.assertFalse(Path(temp_path).exists())

    def test_queued_job_can_be_cancelled_before_worker_touches_file(self):
        entered = threading.Event()
        release = threading.Event()
        with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel(entered, release)):
            first = self.client.post(
                "/api/transcribe", files={"file": ("one.wav", b"one", "audio/wav")}, data={"background": "1"}
            ).json()
            self.assertTrue(entered.wait(timeout=2))
            second = self.client.post(
                "/api/transcribe", files={"file": ("two.wav", b"two", "audio/wav")}, data={"background": "1"}
            ).json()
            with server._jobs_lock:
                second_path = server._jobs[second["jobId"]]["_tmp"]
            response = self.client.delete(f"/api/transcribe/{second['jobId']}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "cancelled")
            self.assertFalse(Path(second_path).exists())
            release.set()
            self.wait_for(first["jobId"], {"done"})

    def test_three_job_queue_cancels_middle_and_advances_last(self):
        entered = threading.Event()
        release = threading.Event()
        model = BlockingModel(entered, release)
        with mock.patch.object(server, "get_transcription_model", return_value=model):
            first = self.client.post(
                "/api/transcribe", files={"file": ("one.wav", b"one", "audio/wav")}, data={"background": "1"}
            ).json()
            self.assertTrue(entered.wait(timeout=2))
            second = self.client.post(
                "/api/transcribe", files={"file": ("two.wav", b"two", "audio/wav")}, data={"background": "1"}
            ).json()
            third = self.client.post(
                "/api/transcribe", files={"file": ("three.wav", b"three", "audio/wav")}, data={"background": "1"}
            ).json()
            self.assertEqual(self.client.get(f"/api/transcribe/{second['jobId']}").json()["queuePosition"], 1)
            self.assertEqual(self.client.get(f"/api/transcribe/{third['jobId']}").json()["queuePosition"], 2)
            self.assertEqual(self.client.delete(f"/api/transcribe/{second['jobId']}").status_code, 200)
            self.assertEqual(self.client.get(f"/api/transcribe/{third['jobId']}").json()["queuePosition"], 1)
            release.set()
            self.wait_for(first["jobId"], {"done"})
            self.wait_for(second["jobId"], {"cancelled"})
            self.wait_for(third["jobId"], {"done"})

    def test_cancel_during_transcribing_keeps_partial_checkpoint_and_cleans_once(self):
        first_segment_seen = threading.Event()
        release = threading.Event()
        class PartialModel:
            def transcribe(self, _path, **_kwargs):
                def segments():
                    yield FakeSegment(0, 1, "Część zachowana")
                    first_segment_seen.set()
                    release.wait(timeout=3)
                    yield FakeSegment(1, 2, "Część po cancel")
                return segments(), FakeInfo()
        job, temp_path = self.direct_job_with_tempfile()
        original_unlink = Path.unlink
        with mock.patch.object(server, "get_transcription_model", return_value=PartialModel()), \
             mock.patch.object(server.Path, "unlink", autospec=True,
                               side_effect=lambda path, *args, **kwargs: original_unlink(path, *args, **kwargs)) as unlink_mock:
            worker = threading.Thread(target=server._run_transcription, args=(job, "pl"))
            worker.start()
            self.assertTrue(first_segment_seen.wait(timeout=2))
            deadline = time.time() + 2
            while time.time() < deadline and not job.get("segments"): time.sleep(0.01)
            self.assertEqual(job["segments"][0]["text"], "Część zachowana")
            self.assertEqual(self.client.delete(f"/api/transcribe/{job['jobId']}").status_code, 202)
            release.set(); worker.join(timeout=3)
            server._cleanup_tmp(job)  # a second call is intentionally a no-op
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(job["transcript"], "Część zachowana")
        self.assertTrue(job["_cleanup_done"])
        self.assertFalse(temp_path.exists())
        self.assertEqual(sum(1 for call in unlink_mock.call_args_list if str(call.args[0]) == str(temp_path)), 1)

    def test_cancel_during_loading_waiting_preprocessing_and_finalizing(self):
        # loading_model
        job, temp_path = self.direct_job_with_tempfile()
        entered, release = threading.Event(), threading.Event()
        def slow_model_load(*_args):
            entered.set()
            release.wait(timeout=3)
            return BlockingModel()
        with mock.patch.object(server, "get_transcription_model", side_effect=slow_model_load):
            worker = threading.Thread(target=server._run_transcription, args=(job, "pl"))
            worker.start()
            self.assertTrue(entered.wait(timeout=2))
            self.assertEqual(job["phase"], "loading_model")
            self.assertEqual(self.client.delete(f"/api/transcribe/{job['jobId']}").status_code, 202)
            release.set(); worker.join(timeout=3)
        self.assertEqual(job["status"], "cancelled")
        self.assertTrue(job["_cleanup_done"])
        self.assertFalse(temp_path.exists())

        # waiting_for_model
        job, temp_path = self.direct_job_with_tempfile()
        held_lock = threading.Lock(); held_lock.acquire()
        original_lock = server._model_lock
        server._model_lock = held_lock
        try:
            with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel()):
                worker = threading.Thread(target=server._run_transcription, args=(job, "pl"))
                worker.start()
                deadline = time.time() + 2
                while time.time() < deadline and job["phase"] != "waiting_for_model": time.sleep(0.01)
                self.assertEqual(job["phase"], "waiting_for_model")
                self.assertEqual(self.client.delete(f"/api/transcribe/{job['jobId']}").status_code, 202)
                held_lock.release(); worker.join(timeout=3)
        finally:
            if held_lock.locked(): held_lock.release()
            server._model_lock = original_lock
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse(temp_path.exists())

        # preprocessing
        job, temp_path = self.direct_job_with_tempfile()
        class HangingProcess:
            returncode = None
            stopped = False
            def poll(self): return -15 if self.stopped else None
            def terminate(self): self.stopped = True; self.returncode = -15
            def wait(self, timeout=None): return self.returncode
            def kill(self): self.terminate()
        previous_preprocess = server.PREPROCESS_AUDIO
        server.PREPROCESS_AUDIO = True
        try:
            with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel()), \
                 mock.patch.object(server.shutil, "which", return_value="ffmpeg"), \
                 mock.patch.object(server.subprocess, "Popen", return_value=HangingProcess()):
                worker = threading.Thread(target=server._run_transcription, args=(job, "pl"))
                worker.start()
                deadline = time.time() + 2
                while time.time() < deadline and job["phase"] != "preprocessing": time.sleep(0.01)
                self.assertEqual(job["phase"], "preprocessing")
                self.client.delete(f"/api/transcribe/{job['jobId']}")
                worker.join(timeout=3)
        finally:
            server.PREPROCESS_AUDIO = previous_preprocess
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse(temp_path.exists())

        # finalizing: cancel in the exact window before the atomic done transition.
        job, temp_path = self.direct_job_with_tempfile()
        finalizing, finish_release = threading.Event(), threading.Event()
        original_mark = server._mark_job
        def gated_mark(target, message, progress=None, phase=None, status=None):
            original_mark(target, message, progress, phase, status)
            if phase == "finalizing":
                finalizing.set()
                finish_release.wait(timeout=3)
        with mock.patch.object(server, "get_transcription_model", return_value=BlockingModel()), \
             mock.patch.object(server, "_mark_job", side_effect=gated_mark):
            worker = threading.Thread(target=server._run_transcription, args=(job, "pl"))
            worker.start()
            self.assertTrue(finalizing.wait(timeout=2))
            self.assertEqual(self.client.delete(f"/api/transcribe/{job['jobId']}").status_code, 202)
            finish_release.set(); worker.join(timeout=3)
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse(temp_path.exists())

    def test_optional_token_protects_sensitive_routes(self):
        previous = server.API_TOKEN
        server.API_TOKEN = "test-secret"
        try:
            self.assertEqual(self.client.get("/api/transcribe/missing").status_code, 401)
            allowed = self.client.get(
                "/api/transcribe/missing", headers={server.API_TOKEN_HEADER: "test-secret"}
            )
            self.assertEqual(allowed.status_code, 404)
            self.assertEqual(self.client.get("/api/health").status_code, 200)
            self.assertEqual(self.client.get("/api/transcribe/missing", headers={server.API_TOKEN_HEADER: "wrong"}).status_code, 401)
        finally:
            server.API_TOKEN = previous

        # Auth OFF accepts the same sensitive route without a token.
        self.assertEqual(self.client.get("/api/transcribe/missing").status_code, 404)

    def test_ttl_and_safe_orphan_cleanup(self):
        now = time.time()
        for status, ttl in (
            ("done", server.DONE_JOB_TTL_SEC),
            ("error", server.ERROR_JOB_TTL_SEC),
            ("cancelled", server.CANCELLED_JOB_TTL_SEC),
        ):
            job = server._new_job()
            job["status"] = status
            job["updated_at"] = now - ttl - 1
        result = server._cleanup_expired_jobs(now=now)
        self.assertEqual(result["removed"], 3)

        active = server._new_job()
        active["status"] = "running"
        active["created_at"] = now - server.STALE_JOB_TTL_SEC * 2
        active["updated_at"] = now - 1  # heartbeat/progress proves it is still active
        queued = server._new_job()
        queued["created_at"] = queued["updated_at"] = now - server.STALE_JOB_TTL_SEC - 1
        stale_running = server._new_job()
        stale_running["status"] = "running"
        stale_running["created_at"] = stale_running["updated_at"] = now - server.STALE_JOB_TTL_SEC - 1
        result = server._cleanup_expired_jobs(now=now)
        self.assertFalse(active["_cancel"].is_set())
        self.assertTrue(queued["_cancel"].is_set())
        self.assertEqual(queued["status"], "cancelled")
        self.assertTrue(stale_running["_cancel"].is_set())
        self.assertEqual(result["cancelRequested"], 2)

        with tempfile.TemporaryDirectory() as temp_dir:
            safe = Path(temp_dir, "skryptorium_dead.audio")
            unrelated = Path(temp_dir, "someone_else.audio")
            safe.write_bytes(b"x")
            unrelated.write_bytes(b"x")
            old = time.time() - server.ORPHAN_FILE_TTL_SEC - 2
            os.utime(safe, (old, old))
            os.utime(unrelated, (old, old))
            self.assertEqual(server._cleanup_orphan_tempfiles(now=time.time(), temp_dir=temp_dir), 1)
            self.assertFalse(safe.exists())
            self.assertTrue(unrelated.exists())

    def test_cors_rejects_arbitrary_site_but_allows_file_origin(self):
        rejected = self.client.options(
            "/api/health",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
        )
        self.assertNotIn("access-control-allow-origin", rejected.headers)
        allowed = self.client.options(
            "/api/health",
            headers={"Origin": "null", "Access-Control-Request-Method": "GET"},
        )
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "null")
        for origin in ("http://localhost", "http://localhost:8080", "http://127.0.0.1", "http://127.0.0.1:3000"):
            response = self.client.options(
                "/api/transcribe/missing",
                headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": server.API_TOKEN_HEADER},
            )
            self.assertEqual(response.headers.get("access-control-allow-origin"), origin)
            self.assertIn(server.API_TOKEN_HEADER.lower(), response.headers.get("access-control-allow-headers", "").lower())

    def test_warmup_failure_is_nonfatal_and_logged(self):
        previous = server.WARMUP_MODEL
        server.WARMUP_MODEL = True
        try:
            with mock.patch.object(server, "get_transcription_model", side_effect=RuntimeError("synthetic warmup")), \
                 self.assertLogs("skryptorium.engine", level="ERROR"):
                server._warmup_model()
            self.assertEqual(server._warmup_state["status"], "error")
            self.assertEqual(server.health()["ok"], True)
        finally:
            server.WARMUP_MODEL = previous

    def test_ollama_options_use_model_metadata_and_safe_caps(self):
        server._model_context_cache.clear()
        with mock.patch.object(server, "_ollama_request", return_value={"model_info": {"qwen.context_length": 4096}}):
            options = server._safe_ollama_options("fake", {"num_ctx": 999999, "num_predict": 999999, "temperature": 9})
        self.assertEqual(options["num_ctx"], 4096)
        self.assertEqual(options["num_predict"], 16384)
        self.assertEqual(options["temperature"], 2.0)

    def test_logs_do_not_contain_prompt_or_token(self):
        secret_prompt = "PROMPT_SECRET_123"
        with mock.patch.object(server, "_ollama_generate", return_value={"response": "ok"}), \
             self.assertLogs("skryptorium.engine", level="INFO") as captured:
            response = self.client.post("/api/ollama/generate", json={"prompt": secret_prompt, "model": "fake"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(secret_prompt, "\n".join(captured.output))

    # ------------------------------------------------------------------
    # v4: quality + GPU resilience
    # ------------------------------------------------------------------
    def test_v4_batched_kwargs_request_fine_segments_and_auto_language(self):
        kwargs = server._transcription_kwargs("auto", "", "", "balanced")
        self.assertIsNone(kwargs["language"], "auto musi włączać autodetekcję języka")
        if server.BATCH_SIZE > 1:
            self.assertIs(kwargs["without_timestamps"], not server.FINE_SEGMENTS)
            self.assertFalse(kwargs["without_timestamps"], "domyślnie segmenty muszą być drobne")
        reduced = server._transcription_kwargs("pl", "", "", "balanced", batch_size=2)
        if server.BATCH_SIZE > 1:
            self.assertEqual(reduced["batch_size"], 2)
        sequential = server._transcription_kwargs("pl", "", "", "balanced", batch_size=1)
        self.assertNotIn("batch_size", sequential)
        self.assertIs(sequential["condition_on_previous_text"], False)
        import inspect
        from faster_whisper import BatchedInferencePipeline
        accepted = set(inspect.signature(BatchedInferencePipeline.transcribe).parameters)
        self.assertTrue(set(kwargs) <= accepted, set(kwargs) - accepted)

    def test_v4_hallucination_filter_removes_credits_but_keeps_real_speech(self):
        sure = {"avgLogProb": -0.2, "noSpeechProb": 0.01}
        unsure = {"avgLogProb": -1.2, "noSpeechProb": 0.7}
        segments = [
            {"start": 0, "end": 3, "text": "Dzień dobry, zaczynamy wykład o konsultacjach.", **sure},
            {"start": 3, "end": 5, "text": "Napisy stworzone przez społeczność Amara.org", **sure},
            {"start": 5, "end": 7, "text": "Napisy: Jan Kowalski", **sure},
            {"start": 7, "end": 9, "text": "Napisy do filmu przygotował wolontariusz z Torunia.", **sure},
            {"start": 9, "end": 11, "text": "Dziękuję za obejrzenie.", **sure},
            {"start": 11, "end": 13, "text": "Dziękuję za obejrzenie.", **unsure},
            {"start": 13, "end": 15, "text": "Dziękuję za uwagę.", **unsure},
            {"start": 15, "end": 17, "text": "Zapraszam do subskrypcji!", **sure},
        ]
        kept, report = server._clean_segments([dict(s) for s in segments])
        texts = [s["text"] for s in kept]
        self.assertIn("Dzień dobry, zaczynamy wykład o konsultacjach.", texts)
        self.assertIn("Napisy do filmu przygotował wolontariusz z Torunia.", texts, "zwykłe zdanie ze słowem 'napisy' musi zostać")
        self.assertIn("Dziękuję za uwagę.", texts, "koniec wykładu nie może być wycięty")
        self.assertEqual(texts.count("Dziękuję za obejrzenie."), 1, "pewny model = prawdziwa mowa, niepewny = halucynacja")
        self.assertNotIn("Napisy stworzone przez społeczność Amara.org", texts)
        self.assertNotIn("Napisy: Jan Kowalski", texts)
        self.assertNotIn("Zapraszam do subskrypcji!", texts)
        self.assertEqual(len(report["removed"]), 4)
        self.assertTrue(all("text" in item and "start" in item for item in report["removed"]))

    def test_v4_repetition_loops_are_collapsed_and_triple_repeats_dropped(self):
        text, changed = server._collapse_repetitions("i to jest i to jest i to jest i to jest i to jest ważne")
        self.assertTrue(changed)
        self.assertEqual(text, "i to jest ważne")
        text, changed = server._collapse_repetitions("bardzo bardzo ważne")
        self.assertFalse(changed, "podwójne powtórzenie to naturalna mowa")
        segs = [{"start": i, "end": i + 1, "text": "Dziękuję bardzo."} for i in range(5)]
        kept, report = server._clean_segments(segs)
        self.assertEqual(len(kept), 2)
        self.assertEqual(sum(1 for r in report["removed"] if r["reason"] == "repeat"), 3)

    def test_v4_incremental_status_returns_only_new_segments(self):
        job = server._new_job()
        job["status"] = "running"
        job["segments"] = [{"start": i, "end": i + 1, "text": f"s{i}"} for i in range(5)]
        job["transcript"] = "s0 s1 s2 s3 s4"
        full = self.client.get(f"/api/transcribe/{job['jobId']}").json()
        self.assertEqual(len(full["segments"]), 5)
        self.assertEqual(full["transcript"], "s0 s1 s2 s3 s4")
        part = self.client.get(f"/api/transcribe/{job['jobId']}?since=3").json()
        self.assertEqual([s["text"] for s in part["segments"]], ["s3", "s4"])
        self.assertEqual(part["segmentsFrom"], 3)
        self.assertEqual(part["segmentCount"], 5)
        self.assertIsNone(part["transcript"], "w trybie przyrostowym nie wysyłamy całego tekstu co 1,4 s")

    def test_v4_oom_frees_vram_halves_batch_and_resumes_from_last_segment(self):
        import numpy as np
        job, temp_path = self.direct_job_with_tempfile()
        job["batchSize"] = 8
        calls = []

        class OomOnceModel:
            def transcribe(self, source, **kwargs):
                calls.append({"len": len(source), "batch": kwargs.get("batch_size")})
                info = FakeInfo()
                if len(calls) == 1:
                    def first():
                        yield FakeSegment(0, 2, "Przed awarią")
                        raise RuntimeError("CUDA failed with error out of memory")
                    return first(), info
                if len(calls) == 2:
                    def second():
                        raise RuntimeError("CUDA failed with error out of memory")
                        yield  # pragma: no cover
                    return second(), info
                def third():
                    yield FakeSegment(0, 2, "Po wznowieniu")
                return third(), info

        audio = np.zeros(16000 * 4, dtype=np.float32)
        previous_meta = dict(server._model_meta)
        server._model_meta.update(device="cuda", compute_type="float16", name="turbo")
        freed = []
        try:
            with mock.patch.object(server, "get_transcription_model", return_value=OomOnceModel()), \
                 mock.patch.object(server, "_decode_audio", return_value=audio), \
                 mock.patch.object(server, "_free_ollama_vram", side_effect=lambda job=None: freed.append(1) or ["qwen2.5:7b"]):
                server._run_transcription(job, "pl")
        finally:
            server._model_meta.clear(); server._model_meta.update(previous_meta)
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual([s["text"] for s in job["segments"]], ["Przed awarią", "Po wznowieniu"])
        self.assertEqual(job["segments"][1]["start"], 2.0, "wznowienie musi przesunąć czasy o offset")
        self.assertEqual(calls[1]["len"], 16000 * 2, "drugie podejście zaczyna od końca ostatniego segmentu")
        if server.BATCH_SIZE > 1:
            # VRAM zwolniony już przed startem joba, więc każdy OOM połowi batch.
            self.assertEqual([c["batch"] for c in calls], [8, 4, 2])
        self.assertEqual(len(freed), 1, "VRAM Ollamy zwalniany raz, przed startem")
        self.assertTrue(any("VRAM" in e["text"] for e in job["events"]))
        self.assertFalse(temp_path.exists())

    def test_v4_cpu_fallback_is_temporary(self):
        previous = server._force_cpu_until
        try:
            with mock.patch.object(server, "_cuda_device_count", return_value=1), \
                 mock.patch.object(server, "DEVICE_PREF", "auto"):
                server._fallback_to_cpu("CUDA failed")
                self.assertEqual(server._pick_device_compute(), ("cpu", "int8"))
                server._force_cpu_until = server._timestamp() - 1
                self.assertEqual(server._pick_device_compute()[0], "cuda", "po cool-downie GPU wraca")
        finally:
            server._force_cpu_until = previous

    def test_v4_per_job_model_is_allowlisted(self):
        self.assertEqual(server._resolve_model_name("large-v3"), "large-v3")
        self.assertEqual(server._resolve_model_name("../../evil"), server.MODEL_NAME)
        self.assertEqual(server._resolve_model_name(""), server.MODEL_NAME)
        health = self.client.get("/api/health").json()
        self.assertEqual(health["engineVersion"], 4)
        self.assertIn("turbo", health["allowedModels"])
        self.assertIn("features", health)

    def test_v4_repair_pass_replaces_loop_with_clean_decode(self):
        import numpy as np
        job = server._new_job()
        segs = [
            {"start": 0.0, "end": 3.0, "text": "Dobre zdanie.", "compressionRatio": 1.2},
            {"start": 3.0, "end": 6.0, "text": "tak tak tak tak tak", "compressionRatio": 3.9},
        ]
        cleaned, report = server._clean_segments(segs)
        self.assertEqual(report["suspicious"], 1)

        class Sequential:
            def transcribe(self, clip, **kwargs):
                self.kwargs = kwargs
                return iter([FakeSegment(0, 3, "Tak, to jest poprawiony fragment.")]), FakeInfo()

        seq = Sequential()
        with mock.patch.object(server, "get_model", return_value=seq):
            repaired = server._repair_segments(job, np.zeros(16000 * 6, dtype=np.float32), cleaned, {"language": "pl"})
        self.assertEqual(repaired, 1)
        self.assertEqual(cleaned[1]["text"], "Tak, to jest poprawiony fragment.")
        self.assertTrue(cleaned[1]["repaired"])
        self.assertEqual(cleaned[1]["originalText"], "tak")
        self.assertEqual(seq.kwargs["temperature"][0], 0.0)
        self.assertGreater(len(seq.kwargs["temperature"]), 1, "naprawa musi mieć fallback temperatury")



if __name__ == "__main__":
    unittest.main(verbosity=2)
