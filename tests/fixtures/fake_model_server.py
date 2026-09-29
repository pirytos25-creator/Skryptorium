# -*- coding: utf-8 -*-
"""Prawdziwy server.py z atrapą modelu Whisper — test integracyjny UI ↔ API.

Uruchamia produkcyjny silnik (kolejka, dekodowanie audio, polling ?since=N,
filtr halucynacji, naprawa pętli, sprzątanie), podmieniając wyłącznie model
na deterministyczną atrapę. Nie wymaga pobierania modelu ani GPU.

    python tests/fixtures/fake_model_server.py
"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local-engine"))
os.environ.setdefault("ENGINE_WARMUP", "0")
import server  # noqa: E402

LINES = [
    (0.0, 4.0, "Dzień dobry, witam na Forum Praktyków Partycypacji.", -0.2, 0.01),
    (4.0, 9.0, "Dziś porozmawiamy o konsultacjach społecznych w Toruniu.", -0.25, 0.02),
    (9.0, 14.0, "tak to jest tak to jest tak to jest tak to jest tak to jest", -0.9, 0.05),
    (14.0, 20.0, "Budżet obywatelski wymaga jasnych kryteriów.", -1.2, 0.03),
    (20.0, 26.0, "Dziękuję za uwagę.", -0.3, 0.02),
    (26.0, 30.0, "Napisy stworzone przez społeczność Amara.org", -0.4, 0.2),
]
DELAY = float(os.environ.get("FAKE_SEGMENT_DELAY", "0.7"))


class Seg:
    def __init__(self, start, end, text, logprob, nospeech):
        from faster_whisper.transcribe import get_compression_ratio
        self.start, self.end, self.text = start, end, text
        self.avg_logprob, self.no_speech_prob = logprob, nospeech
        self.compression_ratio = get_compression_ratio(text)
        self.words = None


class Info:
    language = "pl"
    duration_after_vad = 28.5

    def __init__(self, duration):
        self.duration = duration


class FakeBatched:
    def transcribe(self, source, **kwargs):
        duration = (len(source) / 16000) if hasattr(source, "shape") else 30.0

        def gen():
            for line in LINES:
                time.sleep(DELAY)
                yield Seg(*line)
        return gen(), Info(duration)


class FakeSequential:
    def transcribe(self, clip, **kwargs):
        return iter([Seg(0, 1, "Tak, to jest sedno sprawy.", -0.2, 0.01)]), Info(len(clip) / 16000)


server.get_transcription_model = lambda *_a, **_k: FakeBatched()
server.get_model = lambda *_a, **_k: FakeSequential()
server._model_meta.update(device="cuda", compute_type="float16", name="turbo")
server._cuda_device_count = lambda: 1
server._free_ollama_vram = lambda job=None: []

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(server.app, host="127.0.0.1", port=8765, log_level="warning")
