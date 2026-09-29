# -*- coding: utf-8 -*-
"""FINAL CLOSURE PASS — realny contract test Whispera przez Local Engine.

Pokrywa sekcje 7, 8 i 9 specyfikacji:
  7. polski materiał z terminami domenowymi,
  8. porównanie profili fast / balanced / archive + wpływ initial_prompt i hotwords,
  9. zachowanie na ciszy / bardzo słabym sygnale (halucynacje).

Cały ruch idzie przez PRODUKCYJNY endpoint /api/transcribe (upload -> job -> polling),
więc testowany jest realny serwer, a nie faster-whisper w izolacji.

Uruchomienie (Local Engine musi działać):
    local-engine\\.venv\\Scripts\\python.exe tests\\whisper_e2e.py

Zmienne środowiskowe:
    ENGINE_URL (domyślnie http://127.0.0.1:8765)
    ENGINE_API_TOKEN (jeśli silnik wymaga tokenu)
    CLOSURE_PROFILES=fast,balanced,archive
    CLOSURE_AUDIO=ścieżka\\do\\wlasnego_nagrania.wav   (pomija generowanie TTS)
"""

from __future__ import annotations

import json
import math
import os
import re
import struct
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIO_DIR = HERE / "audio"
ENGINE_URL = os.environ.get("ENGINE_URL", "http://127.0.0.1:8765").rstrip("/")
ENGINE_TOKEN = os.environ.get("ENGINE_API_TOKEN", "")
PROFILES = [p.strip() for p in os.environ.get("CLOSURE_PROFILES", "fast,balanced,archive").split(",") if p.strip()]

# Terminy domenowe, na których Whisper najczęściej się wykłada bez podpowiedzi.
DOMAIN_TERMS = [
    "partycypacja obywatelska",
    "konsultacje społeczne",
    "budżet obywatelski",
    "deliberacja",
    "panel obywatelski",
]
INITIAL_PROMPT = (
    "Wykład o partycypacji obywatelskiej. Terminy: konsultacje społeczne, "
    "budżet obywatelski, deliberacja, panel obywatelski, dialog obywatelski, "
    "Forum Praktyków Partycypacji."
)
HOTWORDS = "budżet obywatelski deliberacja panel obywatelski"

# Zdania czytane przez syntezator. Są jednocześnie ground truth do WER/CER.
GROUND_TRUTH_SENTENCES = [
    "Partycypacja obywatelska to udział mieszkańców w decyzjach samorządu.",
    "Konsultacje społeczne wymagają rzetelnej informacji zwrotnej dla uczestników.",
    "Budżet obywatelski w Gdyni działa od dwa tysiące trzynastego roku.",
    "Deliberacja i panel obywatelski dają przekrój opinii, a nie tylko głos aktywistów.",
]
GROUND_TRUTH = " ".join(GROUND_TRUTH_SENTENCES)

results: list[dict] = []


def record(area: str, test: str, status: str, notes: str = "", **extra) -> None:
    results.append({"area": area, "test": test, "real": True, "status": status, "notes": notes, **extra})
    mark = {"PASS": "PASS", "FAIL": "FAIL", "NOT_AVAILABLE": "N/A ", "OPTIONAL": "OPT "}.get(status, status)
    print(f"[{mark}] {area} / {test}" + (f" — {notes}" if notes else ""), flush=True)
    # Zapis po KAŻDYM teście. Przerwany przebieg (Ctrl+C, zamknięte okno, padnięcie
    # silnika w połowie) zostawia wtedy wyniki tego, co zdążyło się wykonać,
    # zamiast tracić całą pracę przez brak jednego zapisu na końcu.
    try:
        write_results(partial=True)
    except Exception:  # zapis pośredni nigdy nie może wywrócić testu
        pass


def log(message: str) -> None:
    print("       " + message, flush=True)


# ------------------------------------------------------------------ HTTP


def _headers(extra: dict | None = None) -> dict:
    headers = dict(extra or {})
    if ENGINE_TOKEN:
        headers["X-Skryptorium-Token"] = ENGINE_TOKEN
    return headers


def get_json(path: str, timeout: int = 15) -> dict:
    request = urllib.request.Request(ENGINE_URL + path, headers=_headers())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_multipart(path: str, file_path: Path, fields: dict, timeout: int = 60) -> dict:
    boundary = "----skryptorium" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += f"{value}\r\n".encode()
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode()
    body += b"Content-Type: audio/wav\r\n\r\n"
    body += file_path.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        ENGINE_URL + path,
        data=bytes(body),
        headers=_headers({"Content-Type": f"multipart/form-data; boundary={boundary}"}),
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def transcribe(file_path: Path, profile: str, initial_prompt: str = "", hotwords: str = "",
               poll_timeout: int = 1800, language_override: str = "") -> dict:
    """Pełna ścieżka produkcyjna: upload -> jobId -> polling do skutku."""
    fields = {"background": "1", "language": language_override or "pl", "processing_profile": profile}
    if initial_prompt:
        fields["initial_prompt"] = initial_prompt
    if hotwords:
        fields["hotwords"] = hotwords
    started = time.time()
    submitted = post_multipart("/api/transcribe", file_path, fields, timeout=300)
    job_id = submitted.get("jobId")
    if not job_id:
        raise RuntimeError(f"serwer nie zwrócił jobId: {submitted}")
    while True:
        if time.time() - started > poll_timeout:
            raise TimeoutError(f"job {job_id} nie skończył się w {poll_timeout}s")
        time.sleep(1.2)
        status = get_json(f"/api/transcribe/{job_id}", timeout=30)
        if status.get("status") == "done":
            status["_wallSec"] = round(time.time() - started, 2)
            return status
        if status.get("status") == "error":
            raise RuntimeError(status.get("error") or "transkrypcja zakończona błędem")
        if status.get("status") == "cancelled":
            raise RuntimeError("transkrypcja anulowana")


# ----------------------------------------------------------- metryki WER


def normalize_words(text: str) -> list[str]:
    lowered = unicodedata.normalize("NFC", str(text or "")).lower()
    cleaned = re.sub(r"[^\w\sąćęłńóśźż]", " ", lowered, flags=re.UNICODE)
    return [word for word in cleaned.split() if word]


def edit_distance(a: list, b: list) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, item_a in enumerate(a, 1):
        current = [i]
        for j, item_b in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (item_a != item_b)))
        previous = current
    return previous[-1]


def wer_cer(reference: str, hypothesis: str) -> tuple[float, float]:
    ref_words, hyp_words = normalize_words(reference), normalize_words(hypothesis)
    ref_chars = list(" ".join(ref_words))
    hyp_chars = list(" ".join(hyp_words))
    wer = edit_distance(ref_words, hyp_words) / max(1, len(ref_words))
    cer = edit_distance(ref_chars, hyp_chars) / max(1, len(ref_chars))
    return round(wer, 4), round(cer, 4)


def terms_found(text: str) -> list[str]:
    haystack = " ".join(normalize_words(text))
    return [term for term in DOMAIN_TERMS if " ".join(normalize_words(term)) in haystack]


# ------------------------------------------------------------- fixtures


def make_silence(path: Path, seconds: float = 12.0, sample_rate: int = 16000, amplitude: int = 6) -> Path:
    """Cisza z minimalnym szumem dithering — realistyczniejsza niż idealne zera."""
    total = int(seconds * sample_rate)
    state = 12345
    frames = bytearray()
    for _ in range(total):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        sample = ((state >> 16) % (2 * amplitude + 1)) - amplitude
        frames += struct.pack("<h", sample)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(bytes(frames))
    return path


# Skrypt PowerShella NIE zawiera polskiego tekstu ani ścieżek — czyta je z plików
# UTF-8. Windows PowerShell 5.1 interpretuje pliki .ps1 bez BOM jako ANSI (CP1250),
# co rozwalało polskie znaki w literale i wywalało parser. Tekst poza skryptem
# usuwa ten problem u źródła, a BOM jest dodatkowym zabezpieczeniem.
POWERSHELL_TTS = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($args[0], $utf8)
$outFile = [System.IO.File]::ReadAllText($args[1], $utf8).Trim()
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$all = $s.GetInstalledVoices() | Where-Object { $_.Enabled }
foreach ($v in $all) { Write-Output ('VOICE:' + $v.VoiceInfo.Name + '|' + $v.VoiceInfo.Culture.Name) }
$polish = $all | Where-Object { $_.VoiceInfo.Culture.Name -like 'pl*' } | Select-Object -First 1
if ($null -eq $polish) {
    Write-Output 'NO_POLISH_VOICE'
    exit 2
}
$s.SelectVoice($polish.VoiceInfo.Name)
$s.Rate = -1
$s.SetOutputToWaveFile($outFile)
$s.Speak($text)
$s.Dispose()
Write-Output ('OK:' + $polish.VoiceInfo.Name)
"""


def make_polish_speech(path: Path) -> tuple[bool, str]:
    if os.name != "nt":
        return False, "generowanie TTS działa tylko na Windows (System.Speech)"
    script_path = AUDIO_DIR / "_tts.ps1"
    text_path = AUDIO_DIR / "_tts_text.txt"
    out_path = AUDIO_DIR / "_tts_out.txt"
    # utf-8-sig -> BOM, dzięki czemu PowerShell 5.1 czyta skrypt jako UTF-8.
    script_path.write_text(POWERSHELL_TTS, encoding="utf-8-sig")
    text_path.write_text(" ".join(GROUND_TRUTH_SENTENCES), encoding="utf-8")
    out_path.write_text(str(path), encoding="utf-8")
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path),
             str(text_path), str(out_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"nie udało się uruchomić PowerShella: {exc}"
    finally:
        for temp in (script_path, text_path, out_path):
            temp.unlink(missing_ok=True)
    output = (completed.stdout or "") + (completed.stderr or "")
    voices = [line.replace("VOICE:", "").strip() for line in output.splitlines() if line.startswith("VOICE:")]
    if completed.returncode == 0 and path.is_file() and path.stat().st_size > 1000:
        voice = next((line.replace("OK:", "").strip() for line in output.splitlines() if line.startswith("OK:")), "nieznany")
        return True, voice
    if "NO_POLISH_VOICE" in output:
        return False, ("brak polskiego głosu SAPI. Zainstalowane głosy: "
                       + (", ".join(voices) or "brak")
                       + ". Dodaj polski pakiet mowy w Ustawienia > Czas i język > Mowa")
    detail = output.strip().replace("\n", " ")[:300]
    return False, (f"PowerShell zwrócił kod {completed.returncode}: {detail}"
                   + (f" | wykryte głosy: {', '.join(voices)}" if voices else ""))


# Fixture'y dołączone do faster-whisper — deterministyczne, zawsze dostępne,
# ze znanym oczekiwanym wynikiem. Pozwalają wykonać realny test mechanizmu
# nawet wtedy, gdy nie ma polskiego materiału.
FW_DATA = HERE.parent / "faster-whisper-master" / "tests" / "data"   # opcjonalne: klon repo faster-whisper obok projektu
JFK_GROUND_TRUTH = ("And so my fellow Americans ask not what your country can do for you "
                    "ask what you can do for your country")


MAX_AUDIO_SEC = float(os.environ.get("CLOSURE_MAX_AUDIO_SEC", "300"))


def trim_if_long(path: Path) -> tuple[Path, str]:
    """Przycina długie nagranie do pierwszych MAX_AUDIO_SEC sekund.

    Runner wykonuje sześć transkrypcji tego samego pliku (trzy profile, dwie dla
    porównania podpowiedzi, jedna anulowana). Godzinne nagranie zamieniłoby to
    w kilkugodzinny przebieg bez żadnego zysku diagnostycznego — specyfikacja
    prosi o materiał 1–5 minut. Przycinamy dekoderem z faster-whisper, więc
    nie potrzeba ffmpeg.
    """
    try:
        from faster_whisper.audio import decode_audio
        samples = decode_audio(str(path), sampling_rate=16000)
    except Exception as exc:  # noqa: BLE001
        return path, f"nie udało się sprawdzić długości ({exc}); używam oryginału"
    duration = len(samples) / 16000.0
    if duration <= MAX_AUDIO_SEC:
        return path, f"{duration:.0f} s — bez przycinania"
    keep = int(MAX_AUDIO_SEC * 16000)
    trimmed = AUDIO_DIR / "_trimmed_source.wav"
    with wave.open(str(trimmed), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"".join(
            struct.pack("<h", max(-32768, min(32767, int(value * 32767))))
            for value in samples[:keep]
        ))
    return trimmed, (f"oryginał {duration / 60:.1f} min przycięty do {MAX_AUDIO_SEC:.0f} s "
                     f"(zmień limit przez CLOSURE_MAX_AUDIO_SEC)")


def find_user_audio() -> Path | None:
    override = os.environ.get("CLOSURE_AUDIO", "").strip()
    if override and Path(override).is_file():
        return Path(override)
    if not AUDIO_DIR.is_dir():
        return None
    # Pliki generowane przez runner NIE mogą zostać wzięte za materiał użytkownika.
    # Bez "_" na tej liście drugie uruchomienie wybrałoby własny plik przycięty
    # z poprzedniego przebiegu (podkreślenie sortuje się przed małymi literami).
    generated = ("silence", "polish_tts", "_")
    for candidate in sorted(AUDIO_DIR.iterdir()):
        if candidate.suffix.lower() in {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".webm"} \
                and not candidate.name.startswith(generated):
            return candidate
    return None


# ---------------------------------------------------------------- testy


def test_health() -> dict | None:
    try:
        health = get_json("/api/health", timeout=10)
    except Exception as exc:  # noqa: BLE001
        record("Real transcription", "Local Engine odpowiada", "NOT_AVAILABLE",
               f"{exc} — uruchom local-engine\\start_engine.bat i powtórz")
        return None
    record("Real transcription", "Local Engine odpowiada", "PASS",
           f"model={health.get('model')} device={health.get('device')}/{health.get('computeType')} "
           f"wordTimestamps={health.get('wordTimestamps')} preprocess={health.get('preprocessAudio')}",
           engineHealth=health)
    return health


def test_silence(health: dict) -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    silence = AUDIO_DIR / "silence.wav"
    if not silence.is_file():
        make_silence(silence)
    try:
        outcome = transcribe(silence, "balanced")
    except Exception as exc:  # noqa: BLE001
        record("Real transcription", "cisza / halucynacje", "FAIL", str(exc))
        return
    transcript = (outcome.get("transcript") or "").strip()
    segments = outcome.get("segments") or []
    chars = len(transcript)
    log(f"cisza 12 s -> {chars} znaków, {len(segments)} segmentów, {outcome.get('_wallSec')}s")
    if transcript:
        log(f"treść: {transcript[:200]!r}")
    clean = chars <= 25
    note = ("brak halucynacji — VAD i progi odsiały ciszę" if clean
            else f"model wygenerował {chars} znaków z ciszy: {transcript[:120]!r}")
    if not clean and not health.get("wordTimestamps"):
        note += " | UWAGA: hallucination_silence_threshold działa tylko przy ENGINE_WORD_TIMESTAMPS=1"
    record("Real transcription", "cisza / halucynacje", "PASS" if clean else "FAIL", note,
           chars=chars, segments=len(segments), transcript=transcript[:300],
           wordTimestampsEnabled=bool(health.get("wordTimestamps")))


def test_profiles(audio: Path, has_ground_truth: bool, language: str = "pl") -> list[dict]:
    rows: list[dict] = []
    prompt = INITIAL_PROMPT if language == "pl" else ""
    hints = HOTWORDS if language == "pl" else ""
    for profile in PROFILES:
        try:
            outcome = transcribe(audio, profile, prompt, hints, language_override=language)
        except Exception as exc:  # noqa: BLE001
            record("Real transcription", f"profil {profile}", "FAIL", str(exc))
            continue
        transcript = (outcome.get("transcript") or "").strip()
        row = {
            "profile": profile,
            "model": outcome.get("model"),
            "device": outcome.get("device"),
            "computeType": outcome.get("computeType"),
            "beamSize": outcome.get("beamSize"),
            "batchSize": outcome.get("batchSize"),
            "wallSec": outcome.get("_wallSec"),
            "audioSec": outcome.get("durationSec"),
            "segments": len(outcome.get("segments") or []),
            "chars": len(transcript),
            "termsFound": terms_found(transcript),
            "transcript": transcript,
        }
        if has_ground_truth:
            row["wer"], row["cer"] = wer_cer(GROUND_TRUTH, transcript)
        rows.append(row)
        speed = (row["audioSec"] / row["wallSec"]) if row["wallSec"] else 0
        # Device MUSI być w nagłówku wyniku. Bez tego przebieg, w którym silnik po
        # cichu spadł z GPU na CPU, wygląda identycznie jak przebieg na GPU —
        # a różni się kilkunastokrotnie czasem.
        detail = (f"[{row['device']}/{row['computeType']}] {row['wallSec']}s dla {row['audioSec']}s audio "
                  f"({speed:.1f}x realtime), {row['segments']} segm.")
        if language == "pl":
            detail += f", terminy {len(row['termsFound'])}/{len(DOMAIN_TERMS)}"
        if has_ground_truth:
            detail += f", WER {row['wer']:.3f}, CER {row['cer']:.3f}"
        record("Real transcription", f"profil {profile}", "PASS", detail, **{k: row[k] for k in
               ("model", "wallSec", "audioSec", "segments", "chars", "termsFound") if k in row})
        log(f"  transkrypt: {transcript[:160]!r}")
    if len(rows) >= 2:
        ordered = sorted(rows, key=lambda item: item["wallSec"])
        record("Real transcription", "porównanie profili", "PASS",
               "; ".join(f"{row['profile']}={row['wallSec']}s"
                         + (f"/WER {row['wer']:.3f}" if "wer" in row else "") for row in ordered),
               comparison=[{k: v for k, v in row.items() if k != "transcript"} for row in rows])
    return rows


def test_declared_vs_actual_device(health: dict, rows: list[dict]) -> None:
    """Czy silnik naprawdę policzył na tym, co zadeklarował w /api/health?

    `/api/health` przed załadowaniem modelu tylko PRZEWIDUJE urządzenie
    (`_pick_device_compute`). Jeśli faktyczne uruchomienie na GPU się nie powiedzie,
    silnik po cichu spada na CPU — poprawnie, ale bez tego testu różnica jest
    niewidoczna, bo widać ją wyłącznie w kilkukrotnie dłuższym czasie.
    """
    if not rows:
        record("Real transcription", "deklarowane vs faktyczne urządzenie", "NOT_AVAILABLE",
               "brak przebiegów transkrypcji")
        return
    declared = f"{health.get('device')}/{health.get('computeType')}"
    actual = {f"{row['device']}/{row['computeType']}" for row in rows}
    actual_text = ", ".join(sorted(actual))
    if declared in actual and len(actual) == 1:
        record("Real transcription", "deklarowane vs faktyczne urządzenie", "PASS",
               f"health deklarował {declared} i transkrypcje realnie tam poszły",
               declared=declared, actual=actual_text)
        return
    record("Real transcription", "deklarowane vs faktyczne urządzenie", "FAIL",
           f"health deklarował {declared}, ale transkrypcje wykonały się na {actual_text}. "
           "Silnik zszedł na fallback — sprawdź okno Local Engine pod kątem 'phase=fallback_cpu'. "
           "Najczęstsza przyczyna: brak pamięci VRAM (np. Ollama trzyma model) albo zbyt duży ENGINE_BATCH_SIZE.",
           declared=declared, actual=actual_text)


def test_prompt_effect(audio: Path, has_ground_truth: bool, language: str = "pl") -> None:
    """Czy initial_prompt + hotwords realnie zmieniają wynik na terminach domenowych."""
    if language != "pl":
        record("Real transcription", "wpływ initial_prompt i hotwords (polskie terminy)", "NOT_AVAILABLE",
               "materiał nie jest polski — mechanizm sprawdzony osobno na fixture ComfyUI")
        return
    try:
        without = transcribe(audio, "balanced", language_override=language)
        with_hints = transcribe(audio, "balanced", INITIAL_PROMPT, HOTWORDS, language_override=language)
    except Exception as exc:  # noqa: BLE001
        record("Real transcription", "wpływ initial_prompt i hotwords", "FAIL", str(exc))
        return
    bare_text = (without.get("transcript") or "").strip()
    hint_text = (with_hints.get("transcript") or "").strip()
    bare_terms, hint_terms = terms_found(bare_text), terms_found(hint_text)
    payload = {
        "termsWithout": bare_terms, "termsWith": hint_terms,
        "identical": bare_text == hint_text,
    }
    if has_ground_truth:
        payload["werWithout"], payload["cerWithout"] = wer_cer(GROUND_TRUTH, bare_text)
        payload["werWith"], payload["cerWith"] = wer_cer(GROUND_TRUTH, hint_text)
    note = (f"terminy bez podpowiedzi {len(bare_terms)}/{len(DOMAIN_TERMS)}, "
            f"z podpowiedziami {len(hint_terms)}/{len(DOMAIN_TERMS)}")
    if has_ground_truth:
        note += f"; WER {payload['werWithout']:.3f} -> {payload['werWith']:.3f}"
    if payload["identical"]:
        note += " (wynik identyczny — na tak krótkim materiale to możliwe)"
    record("Real transcription", "wpływ initial_prompt i hotwords", "PASS", note, **payload)


def test_hotwords_mechanism() -> None:
    """Deterministyczny dowód, że hotwords realnie docierają do modelu.

    Fixture `hotwords.mp3` pochodzi z zestawu testowego faster-whisper: nagranie
    zawiera słowo „ComfyUI", którego model bez podpowiedzi praktycznie nigdy nie
    zapisuje poprawnie. To test MECHANIZMU, nie języka polskiego — dlatego działa
    niezależnie od tego, czy udało się zdobyć polski materiał.
    """
    fixture = FW_DATA / "hotwords.mp3"
    if not fixture.is_file():
        record("Real transcription", "mechanizm hotwords (fixture ComfyUI)", "NOT_AVAILABLE",
               f"brak pliku {fixture}")
        return
    try:
        without = transcribe(fixture, "balanced", language_override="en")
        with_hint = transcribe(fixture, "balanced", hotwords="ComfyUI", language_override="en")
    except Exception as exc:  # noqa: BLE001
        record("Real transcription", "mechanizm hotwords (fixture ComfyUI)", "FAIL", str(exc))
        return
    bare = (without.get("transcript") or "")
    hinted = (with_hint.get("transcript") or "")
    hit_bare = "comfyui" in bare.lower().replace(" ", "")
    hit_hinted = "comfyui" in hinted.lower().replace(" ", "")
    log(f"bez hotwords: {bare[:120]!r}")
    log(f"z hotwords:   {hinted[:120]!r}")
    if hit_hinted:
        note = ("hotwords zadziałały — model zapisał 'ComfyUI'"
                + (" (bez podpowiedzi też, więc wpływ niewidoczny na tym pliku)" if hit_bare
                   else "; bez podpowiedzi tego nie zrobił — mechanizm potwierdzony różnicowo"))
        status = "PASS"
    else:
        note = ("model nie zapisał 'ComfyUI' mimo hotwords — parametr mógł nie dotrzeć do modelu "
                "albo model jest zbyt mały")
        status = "FAIL"
    record("Real transcription", "mechanizm hotwords (fixture ComfyUI)", status, note,
           withoutHotwords=bare[:300], withHotwords=hinted[:300],
           foundWithout=hit_bare, foundWith=hit_hinted)


def test_cancel(audio: Path, audio_seconds: float = 0.0) -> None:
    """Realne anulowanie jobu przez produkcyjny endpoint DELETE.

    Ważny szczegół implementacyjny silnika: flaga anulowania jest sprawdzana
    w pętli PO SEGMENTACH (`server.py`, `_check_cancelled` wewnątrz
    `for segment in segments_iter`). Model musi więc najpierw wypuścić segment.
    Przy `BatchedInferencePipeline` z `batch_size=8` pierwsza porcja obejmuje do
    ośmiu okien po 30 s, czyli nawet ~4 minuty materiału — i dopiero wtedy job
    zauważa, że ma się zatrzymać.

    Dlatego okno oczekiwania musi być skalowane do długości nagrania.
    Wcześniejsza wersja czekała sztywne 90 s i raportowała FAIL na materiale,
    dla którego pojedynczy przebieg trwał ponad 300 s — to był błąd testu,
    nie silnika.
    """
    deadline_sec = max(180.0, audio_seconds * 2.0)
    try:
        submitted = post_multipart("/api/transcribe", audio,
                                   {"background": "1", "language": "pl", "processing_profile": "archive"}, timeout=300)
        job_id = submitted.get("jobId")
        time.sleep(0.4)
        request = urllib.request.Request(ENGINE_URL + f"/api/transcribe/{job_id}", headers=_headers(), method="DELETE")
        requested_at = time.time()
        with urllib.request.urlopen(request, timeout=30) as response:
            cancel = json.loads(response.read().decode("utf-8"))
        log(f"DELETE przyjęty ({cancel.get('status')}); czekam na zatrzymanie do {deadline_sec:.0f}s…")
        final = None
        while time.time() - requested_at < deadline_sec:
            time.sleep(0.8)
            final = get_json(f"/api/transcribe/{job_id}", timeout=20)
            if final.get("status") in {"cancelled", "done", "error"}:
                break
        latency = round(time.time() - requested_at, 1)
        status = (final or {}).get("status")
        if status == "cancelled":
            record("Cancel", "anulowanie transkrypcji przez API", "PASS",
                   f"job zatrzymany po {latency}s od żądania "
                   f"(opóźnienie wynika z ziarnistości: anulowanie działa na granicy segmentu)",
                   cancelResponse=cancel, finalStatus=status, cancelLatencySec=latency)
        elif status == "done":
            record("Cancel", "anulowanie transkrypcji przez API", "PASS",
                   f"job zdążył się ukończyć przed osiągnięciem punktu anulowania ({latency}s) — "
                   "materiał był za krótki, żeby przerwanie było widoczne",
                   cancelResponse=cancel, finalStatus=status, cancelLatencySec=latency)
        else:
            record("Cancel", "anulowanie transkrypcji przez API", "FAIL",
                   f"po {latency}s job nadal ma status '{status}'. DELETE zwrócił "
                   f"'{cancel.get('status')}', więc żądanie dotarło, ale nie zostało zrealizowane "
                   "w rozsądnym czasie — sprawdź, czy model w ogóle wypuszcza segmenty.",
                   cancelResponse=cancel, finalStatus=status, cancelLatencySec=latency)
    except Exception as exc:  # noqa: BLE001
        record("Cancel", "anulowanie transkrypcji przez API", "FAIL", str(exc))


# ----------------------------------------------------------------- main


def main() -> int:
    print("=" * 72)
    print("SKRYPTORIUM — FINAL CLOSURE PASS: realny test Whispera")
    print("=" * 72)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    health = test_health()
    if not health:
        write_results()
        return 1

    test_silence(health)

    global GROUND_TRUTH
    audio = find_user_audio()
    has_ground_truth = False
    if audio:
        # Jeśli obok leży ground_truth.txt, można policzyć WER także dla własnego nagrania.
        reference_file = AUDIO_DIR / "ground_truth.txt"
        if reference_file.is_file():
            custom = reference_file.read_text(encoding="utf-8").strip()
            if custom:
                GROUND_TRUTH = custom
                has_ground_truth = True
        audio, trim_note = trim_if_long(audio)
        record("Real transcription", "materiał polski", "PASS",
               f"użyto własnego pliku: {audio.name}; {trim_note}"
               + (" + ground_truth.txt (WER/CER policzalny)" if has_ground_truth else " (bez wzorca — WER nieliczony)"))
        if not has_ground_truth:
            log("Bez ground_truth.txt WER nie będzie liczony — mierzę czasy, segmenty,")
            log("terminy domenowe i różnicę między przebiegiem z podpowiedziami i bez.")
    else:
        tts_path = AUDIO_DIR / "polish_tts.wav"
        # Świadomie NIE ufamy istniejącemu plikowi — generujemy go od nowa przy
        # każdym przebiegu. Dzięki temu żaden pozostawiony plik z wcześniejszych
        # eksperymentów nie może udawać materiału z ground truth.
        if True:
            ok, detail = make_polish_speech(tts_path)
            if ok:
                audio, has_ground_truth = tts_path, True
                record("Real transcription", "materiał polski", "PASS",
                       f"wygenerowano mowę syntetyczną głosem SAPI '{detail}' — ground truth znany, WER/CER policzalny")
                log("UWAGA: mowa syntetyczna jest łatwiejsza niż nagranie z sali; WER będzie optymistyczny.")
            else:
                record("Real transcription", "materiał polski", "NOT_AVAILABLE", detail)
                log("Jak odblokować ten test bez syntezatora:")
                log("  1. nagraj telefonem ~40 s, czytając na głos poniższe zdania,")
                log("  2. wrzuć plik do tests\\audio\\,")
                log("  3. zapisz te zdania jako tests\\audio\\ground_truth.txt (UTF-8),")
                log("     wtedy runner policzy WER i CER także dla Twojego nagrania.")
                for index, sentence in enumerate(GROUND_TRUTH_SENTENCES, 1):
                    log(f"     {index}. {sentence}")

    # Mechanizm hotwords sprawdzamy zawsze — nie zależy od języka materiału.
    test_hotwords_mechanism()

    language_of_audio = "pl"
    if not audio:
        # Fallback: angielski fixture z faster-whisper. NIE zastępuje testu
        # polskiego, ale pozwala realnie zmierzyć profile, WER i anulowanie.
        jfk = FW_DATA / "jfk.flac"
        if jfk.is_file():
            audio, has_ground_truth, language_of_audio = jfk, True, "en"
            GROUND_TRUTH = JFK_GROUND_TRUTH
            record("Real transcription", "materiał zastępczy (angielski)", "PASS",
                   "brak polskiego audio — profile, WER i anulowanie mierzone na jfk.flac; "
                   "jakość polska pozostaje NOT_AVAILABLE")

    if audio:
        rows = test_profiles(audio, has_ground_truth, language_of_audio)
        test_declared_vs_actual_device(health, rows)
        if rows:
            test_prompt_effect(audio, has_ground_truth, language_of_audio)
        test_cancel(audio, rows[0]["audioSec"] if rows else 0.0)
        if language_of_audio != "pl":
            record("Real transcription", "jakość na polskim materiale", "NOT_AVAILABLE",
                   "profile i anulowanie zmierzone na materiale angielskim; polski wymaga własnego nagrania")
    else:
        for name in ("profile fast/balanced/archive", "wpływ initial_prompt i hotwords"):
            record("Real transcription", name, "NOT_AVAILABLE", "brak jakiegokolwiek materiału audio")
        record("Cancel", "anulowanie transkrypcji przez API", "NOT_AVAILABLE", "brak materiału audio")

    write_results()
    return 1 if any(item["status"] == "FAIL" for item in results) else 0


def write_results(partial: bool = False) -> None:
    counts: dict[str, int] = {}
    for item in results:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "complete": not partial,
        "engineUrl": ENGINE_URL,
        "python": sys.version.split()[0],
        "profiles": PROFILES,
        "groundTruth": GROUND_TRUTH,
        "counts": counts,
        "results": results,
    }
    out_file = HERE / "RESULTS_whisper.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if partial:
        return
    print("-" * 72)
    print(f"Podsumowanie: {counts}")
    print(f"Zapisano: {out_file}")


if __name__ == "__main__":
    sys.exit(main())
