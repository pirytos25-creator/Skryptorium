# Skryptorium Głosów — Local Whisper Engine v3

Lokalny silnik: **audio → transkrypt (faster-whisper) → funkcje AI (Ollama)**.
Wersja v3 przebudowana pod **niezawodną obróbkę długiego audio (90+ minut)**,
prawdziwe anulowanie, kolejkę, TTL i bezpieczne limity uploadu.

Wszystko działa na `127.0.0.1` — nic nie wychodzi do sieci.

## Uruchomienie

```
start_engine.bat          # tworzy .venv, instaluje zależności, startuje serwer
```
Serwer nasłuchuje na `http://127.0.0.1:8765`. Model `turbo` ładuje się dopiero
przy pierwszej transkrypcji (potem siedzi w pamięci).

## Dlaczego 90 minut teraz działa (5 kluczowych zmian)

1. **Upload nie ląduje w RAM.** Plik leci strumieniowo na dysk
   (`tempfile` + `shutil.copyfileobj`). W v1 90-minutowy WAV był wczytywany
   w całości do pamięci (podwójnie: `bytes` + `BytesIO`) — teraz nie.
2. **Transkrypcja = zadanie w tle z progresem.** Frontend wysyła
   `background=1`, dostaje `{jobId}` i odpytuje o postęp. W v1 był jeden
   request wiszący 40+ minut — timeout przeglądarki ubijał całą robotę.
3. **Auto-detekcja GPU/CPU.** Jest karta NVIDIA → `float16` (kilka–kilkanaście
   razy szybciej). Nie ma → CPU `int8`. Bez ręcznej konfiguracji.
4. **Model `turbo` jako domyślny** + `beam=2` + `batch=8`. Zainstalowany
   `faster-whisper==1.2.1` obsługuje alias `turbo`; model nadal można zmienić env-em.
5. **Ollama: adaptacyjny `num_ctx`.** Proxy odczytuje metadata modelu przez
   `/api/show`, respektuje bezpieczny cap i env override. Jedyny pipeline
   map-reduce aplikacji działa po segmentach w `skryptorium-core.js`.

## v4 — jakość i odporność GPU

| Zmiana | Po co |
|---|---|
| `without_timestamps=False` w trybie batched (`ENGINE_FINE_SEGMENTS=1`) | segmenty zdaniowe zamiast bloków VAD do 30 s |
| filtr halucynacji (`ENGINE_HALLUCINATION_FILTER=1`) | usuwa „Amara.org”, „subskrybuj”, zapętlenia i 3+ identyczne segmenty z rzędu; raport w `quality.removed` |
| naprawa pętli (`ENGINE_REPAIR_PASS=1`) | segmenty z `compression_ratio > 2.4` dekodowane ponownie z fallbackiem temperatury (limit 40 segm. / 180 s) |
| zwalnianie VRAM Ollamy (`ENGINE_FREE_OLLAMA_VRAM=1`) | przed jobem na GPU `keep_alive=0` dla modeli z `/api/ps` |
| drabinka OOM | zwolnij VRAM → batch 8→4→2 na GPU → CPU na `ENGINE_GPU_RETRY_COOLDOWN_SEC` (900 s) |
| wznowienie | po awarii GPU job kontynuuje od końca ostatniego segmentu (audio dekodowane raz, do pamięci) |
| model per job | pole formularza `model` z listy `ENGINE_ALLOWED_MODELS` |
| preprocessing per job | pole `preprocess=1` (ffmpeg: `highpass,lowpass,dynaudnorm`) |
| polling przyrostowy | `GET /api/transcribe/{id}?since=N` zwraca tylko nowe segmenty |
| telemetria joba | `processedSec`, `speedX`, `etaSec`, `speechSec`, `events[]`, `quality{}` |

## API

| Metoda | Endpoint | Opis |
|---|---|---|
| GET | `/api/health` | stan silnika + wykryty `device`/`model` |
| POST | `/api/transcribe` | **domyślnie** zwraca od razu `{transcript, durationSec, language, segments}` (form: `file`, opc. `language`, `background=1`, `processing_profile`) |
| GET | `/api/transcribe/{jobId}` | tylko dla `background=1`: `{status, progress, transcript, ...}`; `?since=N` = tylko segmenty od indeksu N |
| DELETE | `/api/transcribe/{jobId}` | prośba o bezpieczne anulowanie; zakończony job usuwa od razu |
| GET | `/api/ollama/health` | stan Ollamy + modele |
| POST | `/api/ollama/generate` | pojedyncze wywołanie (z `num_ctx`) |

### Przepływ transkrypcji (frontend — tak robi obecny UI)

```js
const fd = new FormData();
fd.append("file", audioFile);
fd.append("background", "1");
fd.append("processing_profile", "balanced");
const job = await fetch("http://127.0.0.1:8765/api/transcribe",
                        { method: "POST", body: fd }).then(r => r.json());
// potem polling: GET /api/transcribe/{job.jobId}
```

> Odporność na długie audio bierze się ze strumieniowania pliku na dysk
> (nie do RAM) oraz z trybu jobowego `background=1`, który daje realny polling
> progresu (`{jobId}` + `GET /api/transcribe/{jobId}`). Tryb blokujący bez
> `background=1` nadal działa dla krótkich skryptów CLI.

## Profile przetwarzania

UI ma tryb `Auto`, który wybiera profil według długości materiału, oraz trzy
profile wysyłane do Local Engine jako `processing_profile`:

| Profil | `beam_size` | `best_of` | `batch_size` | Przeznaczenie |
|---|---:|---:|---:|---|
| `fast` | 1 | 1 | 8 | szybki szkic i krótszy czas oczekiwania |
| `balanced` | `ENGINE_BEAM` (domyślnie 2) | 2 | `ENGINE_BATCH_SIZE` (domyślnie 8) | codzienna praca |
| `archive` | 4 | 4 | 4 | dokładniejszy materiał archiwalny |

Wybrany profil i jego realne parametry są zwracane w stanie zadania i zapisywane
przy wpisie. Nieznana wartość bezpiecznie przechodzi na `balanced`.

## Funkcje aplikacji z Rundy 3

### Importy i oś czasu

- TXT, Markdown, SRT, VTT i DOCX trafiają do tego samego archiwum i pipeline'u
  analizy co transkrypcja audio.
- SRT/VTT zachowują segmenty czasowe; etykiety `<v Mówca>` z VTT są zapisywane
  jako `speakerId` i `speakerLabel`.
- Widok „Oś czasu” synchronizuje aktywny segment z odtwarzaczem, pozwala
  przeskoczyć do źródła i ładuje audio z IndexedDB dopiero przy użyciu.

### Wyszukiwanie i widok archiwum

„Nawigacja po Archiwum” przeszukuje tekst, notatkę analityczną, tagi, osoby,
pojęcia, metody i segmenty. Wyniki można łączyć z filtrami mówcy, wydarzenia,
sesji, statusu, modelu, dat, tagów oraz obecności audio i analizy. Widok
przekrojowy deduplikuje pojęcia, metody, tezy i rekomendacje, zachowując przy
każdym elemencie linki do wpisów i — gdy dopasowanie segmentu istnieje — czasu.

### Eksporty

- pojedynczy wpis: DOCX (wariant raw/clean/timestamped), SRT i VTT,
- całe archiwum: ZIP z CSV oraz XLSX z arkuszami `Wpisy`, `Pojecia`, `Metody`,
  `Segmenty`,
- CSV zabezpiecza pola zaczynające się od znaków formuł arkusza.

### Analityka i rozdziały

Analityka lokalna obejmuje deterministyczne TF-IDF, trendy miesięczne,
współwystępowanie terminów oraz statystyki udziału mówców. Rozdziały są
budowane deterministycznie z segmentów jednego źródła; nie łączą nagrań i nie
udają semantycznego podziału LLM. Model danych zachowuje identyfikatory i
etykiety mówców jako fundament pod przyszłą diarizację.

Opcjonalny przycisk „Utwórz semantyczne rozdziały” pozwala modelowi wyłącznie
nazwać i pogrupować sąsiednie chunki. Model nie otrzymuje zadania tworzenia
timestampów. Kod sprawdza pełne pokrycie, kolejność, ciągłość, duplikaty i obce
ID; każda niezgodność powoduje cichy powrót do rozdziałów strukturalnych.

### Offline i duże archiwum

JSZip 3.10.1 jest dostarczany lokalnie w `vendor/jszip.min.js` wraz z licencją,
więc import DOCX oraz eksport DOCX/XLSX/CSV ZIP nie korzystają z CDN. Parametr
`?offline-test=1` uruchamia powtarzalny tryb QA blokujący połączenia zewnętrzne;
nie jest przeznaczony do transkrypcji ani wywołań Gemini/Ollamy.

Wyszukiwarka używa cache indeksu do kolejnej zmiany danych i debounce 160 ms.
Widoki analityczne również są cache'owane, a bardzo liczne źródła rozwijane
porcjami. Wyniki 1000/2500/5000 wpisów są w `ARCHIVE_BENCHMARK.md`.

### Funkcje AI na długim transkrypcie

Frontend dzieli materiał po segmentach Whispera z overlapem, wykonuje MAP
przez `/api/ollama/generate`, zapisuje checkpoint każdego fragmentu i na końcu
wykonuje REDUCE. Backend nie utrzymuje drugiej, rozbieżnej implementacji.

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `ENGINE_MODEL` | `turbo` | `tiny`/`base`/`small`/`medium`/`large-v3`/`turbo` |
| `ENGINE_DEVICE` | `auto` | `auto`/`cpu`/`cuda` |
| `ENGINE_COMPUTE` | `auto` | `auto`/`int8`/`float16`/`int8_float16` |
| `ENGINE_LANG` | `pl` | język transkrypcji |
| `ENGINE_BEAM` | `2` | beam size (niżej = szybciej, wyżej = zwykle trochę dokładniej) |
| `ENGINE_BATCH_SIZE` | `8` | batched inference dla długich nagrań; `1` wyłącza |
| `ENGINE_CPU_THREADS` | auto (4-12) | liczba wątków CPU |
| `ENGINE_MAX_UPLOAD_MB` | `2048` | limit audio, sprawdzany w nagłówku i podczas strumieniowego zapisu |
| `ENGINE_WORD_TIMESTAMPS` | `0` | słowa z timestampami; włącza też ochronę długich ciszy |
| `ENGINE_VAD_MIN_SPEECH_MS` | `250` | odrzuca krótsze fragmenty VAD |
| `ENGINE_LOG_PROGRESS` | `0` | włącza techniczny progress faster-whisper w logu |
| `ENGINE_PREPROCESS_AUDIO` | `0` | opcjonalny high-pass + loudnorm przez ffmpeg, z fallbackiem |
| `ENGINE_WARMUP` | `0` | opcjonalne ładowanie modelu po starcie; błąd nie zatrzymuje serwera |
| `ENGINE_API_TOKEN` | pusty | opcjonalny token dla transkrypcji i proxy Ollamy; wpisz identyczny w UI |
| `ENGINE_DONE_JOB_TTL_SEC` | `86400` | TTL poprawnie zakończonych jobów |
| `ENGINE_STALE_JOB_TTL_SEC` | `21600` | po tym czasie stary queued/running dostaje cancel |
| `OLLAMA_MODEL` | `qwen2.5:7b` | domyślny model Ollamy |
| `OLLAMA_NUM_CTX` | `8192` | okno kontekstu (kluczowe dla długich transkryptów) |
| `OLLAMA_TIMEOUT` | `900` | limit sekund na odpowiedź Ollamy |

## Uwaga o wydajności na CPU

`turbo` + `beam=2` + `batch=8` to domyślny profil. Jeśli pamięć sprzętu jest
ograniczona, ustaw `ENGINE_MODEL=small`. Jeśli jakość jest
ważniejsza niż czas, ustaw `ENGINE_MODEL=medium` albo włącz realne GPU
(patrz niżej). `medium` na samym CPU potrafi być dużo wolniejszy.

### GPU (NVIDIA) i błąd `cublas64_12.dll`

`ENGINE_DEVICE=auto` wykrywa kartę NVIDIA i próbuje uruchomić model na GPU.
Do działania na GPU faster-whisper wymaga bibliotek **cuBLAS 12 + cuDNN 9**.
Jeśli ich nie ma, zobaczysz `Library cublas64_12.dll is not found` — wtedy
silnik **automatycznie przełącza się na CPU i ponawia transkrypcję** (w logu
pojawi się „GPU niedostepne -> CPU"). Nic nie pada, jest tylko wolniej.

- Żeby pominąć nieudaną próbę GPU: ustaw `ENGINE_DEVICE=cpu` w `start_engine.bat`.
- Żeby realnie używać GPU (szybciej), zainstaluj biblioteki NVIDIA **w .venv silnika**:

  ```
  local-engine\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
  ```

  Potem zrestartuj `start_engine.bat`. Pakiet `nvidia-cudnn-cu12` zawiera cuDNN 9
  zbudowane pod CUDA 12 — to jest właściwa zależność.

> **Uwaga:** wcześniejsze wydanie tego README podawało tutaj `nvidia-cudnn-cu9`.
> Taki pakiet **nie istnieje na PyPI** i instalacja kończyła się błędem
> `No matching distribution found`. Poprawna nazwa to `nvidia-cudnn-cu12`.

### Jak sprawdzić, czy GPU NAPRAWDĘ działa

`GET /api/health` zwraca pole `device`, ale dopóki `modelLoaded` jest `false`,
jest to tylko **przewidywanie** z `_pick_device_compute()` — silnik zgłosi
`cuda`, bo widzi kartę, choć jeszcze nie próbował na niej niczego uruchomić.

Prawdziwa odpowiedź jest dostępna dopiero po pierwszej transkrypcji:

```
curl http://127.0.0.1:8765/api/health
```

- `"modelLoaded": true` + `"device": "cuda"` → GPU realnie działa,
- `"modelLoaded": true` + `"device": "cpu"` → próba GPU się nie powiodła
  i zadziałał automatyczny fallback; w logu silnika jest wtedy wpis
  `phase=fallback_cpu`.

Różnica w czasie jest duża: `turbo` na GPU robi 5 minut nagrania w kilkanaście
sekund, na CPU — w kilka minut.
