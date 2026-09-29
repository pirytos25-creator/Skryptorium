# Skryptorium Głosów

Lokalne archiwum wiedzy z nagrań: transkrypcja, opracowanie merytoryczne
i eksport — wszystko na własnym komputerze.

Aplikacja powstała do pracy z wykładami, panelami i wystąpieniami o partycypacji
obywatelskiej, ale nie jest do nich ograniczona. Działa **local-first**: audio,
transkrypty i analizy nie opuszczają Twojej maszyny, chyba że świadomie włączysz
Gemini.

---

## Co nowego w v4 (runda „pełna moc”)

**Jakość transkrypcji**
- **Zdaniowe segmenty** zamiast 30-sekundowych bloków — batched Whisper działał
  z `without_timestamps=True`, więc oś czasu, SRT i skoki z wyszukiwarki miały
  ziarno pół minuty. Teraz model sam dzieli tekst na zdania.
- **Filtr halucynacji** — usuwa całe segmenty typu „Napisy stworzone przez
  społeczność Amara.org”, „Zapraszam do subskrypcji”; „Dziękuję za uwagę” zostaje.
  Każde usunięcie jest raportowane (chip „✂ halucyn.” na karcie).
- **Naprawa pętli** — batched inference nie ma fallbacku temperatury, więc
  zapętlone fragmenty („tak to jest tak to jest…”) są dekodowane ponownie
  dekoderem sekwencyjnym z fallbackiem. Oryginał zostaje w `originalText`.
- **Wzmocnienie trudnego audio** (checkbox przy Ołtarzu) — ffmpeg: pasmo mowy +
  wyrównanie głośności, per nagranie.
- **Wybór modelu** w Ustawieniach (`turbo` / `large-v3` / `medium` / `small`).

**Szybkość i GPU**
- Przed transkrypcją na GPU silnik **odładowuje modele Ollamy z VRAM** —
  to była zmierzona przyczyna zejścia na CPU.
- Przy braku VRAM: batch 8 → 4 → 2 **na GPU**, dopiero potem CPU; CPU tylko
  na 15 min, potem GPU jest próbowane ponownie (v3 zostawał na CPU do restartu).
- Po awarii GPU transkrypcja **kontynuuje od ostatniego segmentu**, nie od zera.
- `start_engine.bat` nie aktualizuje pakietów przy każdym starcie i ładuje
  model od razu (warm-up), więc pierwsza transkrypcja rusza szybciej.

**UX**
- **Transkrypcja na żywo**: tekst pojawia się w trakcie, z prędkością (×),
  ETA, urządzeniem i zdarzeniami (np. „zwolniono VRAM”). Postęp w tytule karty,
  powiadomienie systemowe po zakończeniu.
- **Status silnika i Ollamy w nagłówku** — widać od razu, czy działa GPU.
- **Zwinięte karty** — archiwum jest listą; wnętrze karty renderuje się po
  rozwinięciu (5000 wpisów: płynniejszy scroll, p95 17 ms zamiast 37 ms).
- **Korekta transkryptu**: klik w tekst na osi czasu = edycja; filtr „tylko do
  sprawdzenia” pokazuje fragmenty, przy których Whisper był niepewny;
  **„Popraw nazwę”** zamienia termin w całym wpisie i dopisuje go do hotwords,
  żeby kolejne nagrania były poprawne od razu. `transcriptRaw` pozostaje nietknięty.
- Odtwarzacz: prędkość 0,75–2×, ±5 s, skróty **Alt+← / Alt+→ / Alt+K**.
- Upuszczanie plików na całe okno, także wideo (mp4, mkv, mov…).
- Eksporty zebrane w menu, pusty stan z instrukcją startową i żywym statusem.

---

## Najważniejsze funkcje

**Transkrypcja**
- polska transkrypcja audio przez faster-whisper (model `turbo`)
- Local Engine z kolejką zadań, progresem i anulowaniem
- profile przetwarzania: `fast` / `balanced` / `archive`
- słownik domenowy (`initial_prompt`, `hotwords`) — realnie poprawia nazwy własne
- oś czasu z klikalnymi znacznikami zsynchronizowana z odtwarzaczem

**Analiza AI**
- lokalnie przez Ollamę (bez klucza, bez internetu) albo przez Gemini
- streszczenie, konspekt, tezy, pojęcia, metody, przykłady, problemy, rekomendacje
- semantyczne rozdziały z walidacją: model grupuje fragmenty, ale nie wymyśla
  znaczników czasu — te są wyliczane z danych źródłowych
- bezpieczny fallback do rozdziałów strukturalnych, gdy model zwróci wadliwy podział

**Archiwum**
- wyszukiwanie globalne po transkryptach, analizach i tagach
- filtry: prelegent, wydarzenie, typ sesji, status, model, tagi, zakres dat
- analiza przekrojowa: agregacja pojęć i metod, TF-IDF, trendy, współwystępowanie
- dane w IndexedDB, przeżywają przeładowanie i restart przeglądarki

**Import i eksport**
- import: TXT, MD, SRT, VTT, DOCX
- eksport wpisu: Markdown, TXT, DOCX, SRT, VTT
- eksport korpusu: XLSX (4 arkusze), CSV w ZIP, NotebookLM Pack
- import i eksport działają w pełni offline

---

## Szybki start

### 1. Local Engine (transkrypcja)

```
local-engine\start_engine.bat
```

Tworzy środowisko, instaluje zależności i startuje serwer na
`http://127.0.0.1:8765`. Zostaw okno otwarte. Model pobiera się przy pierwszej
transkrypcji.

### 2. Ollama (analiza lokalna, opcjonalnie)

```
ollama serve
ollama pull qwen2.5:7b
```

Sprawdzony model: **`qwen2.5:7b`**. Alternatywa: analiza przez Gemini
(wymaga klucza API i internetu) albo ręczne wypełnianie sekcji.

### 3. Aplikacja

Otwórz `index.html` w przeglądarce. To wszystko — brak instalacji, brak builda.

---

## Zalecany workflow

**Nagranie audio**

```
audio → transkrypcja → oś czasu → analiza → rozdziały → eksport
```

**Gotowy dokument**

```
TXT / MD / SRT / VTT / DOCX → analiza → archiwum → eksport
```

Interfejs dzieli się na trzy konteksty: **Praca** (dodawanie materiału i lista
wpisów), **Archiwum** (wyszukiwanie i analiza przekrojowa), **Ustawienia**.

---

## Wskazówki z realnych testów

- **`balanced` na co dzień.** W pomiarach `archive` dał 0,9% więcej tekstu za
  20% więcej czasu — ma sens dla nagrań trudnych, nie dla rutyny.
- **`fast` dla długich materiałów.** Przy nagraniach powyżej godziny różnica
  w czasie jest odczuwalna, w jakości nie.
- **Uzupełniaj słownik domenowy przed transkrypcją.** Wpływ jest zmierzony:
  ten sam plik bez podpowiedzi dawał `ConfUI`, z podpowiedzią `ComfyUI`.
  Wpisuj nazwiska prelegentów, nazwy instytucji i terminy branżowe.
- **Nie uruchamiaj ciężkiej transkrypcji równolegle z Ollamą**, jeśli masz mało
  VRAM — modele konkurują o pamięć karty i Whisper może zejść na CPU.
- **Sprawdź, czy GPU naprawdę pracuje.** `GET /api/health` pokazuje `device`
  dopiero wiarygodnie po pierwszej transkrypcji (`modelLoaded: true`).
  Szczegóły w `local-engine/README.md`.

---

## Ograniczenia

| Obszar | Stan |
|---|---|
| Diaryzacja (rozpoznawanie mówców) | odłożona świadomie; model danych przygotowany |
| Gemini | wymaga klucza API i internetu; alternatywą jest Ollama lub praca ręczna |
| Browser Whisper | tryb opcjonalny; pierwszy start wymaga pobrania modelu |
| GPU | przy braku bibliotek CUDA lub pamięci silnik automatycznie schodzi na CPU |
| Duże archiwa | lista renderuje 150 kart naraz; reszta przez „Pokaż więcej" i wyszukiwarkę |
| Anulowanie | działa na granicy segmentu, więc przy długim nagraniu nie jest natychmiastowe |

---

## Testy

```
node tests/frontend_test.js          # logika core, ~160 asercji
node tests/render_paging_test.js     # porcjowanie renderowania kart
node tests/ux_structure_test.js      # architektura informacji
cd local-engine && python smoke_test.py    # backend, 28 testów
```

Test integracyjny UI ↔ prawdziwy `server.py` bez pobierania modelu (atrapa
Whispera, reszta produkcyjna: kolejka, dekodowanie, `?since=N`, filtr, naprawa):

```
python tests/fixtures/fake_model_server.py     # zamiast start_engine.bat
python -m http.server 8899                      # i otwórz localhost:8899
```

Testy wymagające działającego modelu (`tests/ai_e2e.js`, `tests/whisper_e2e.py`)
opisane są w `docs/FINAL_PROJECT_CLOSURE_REPORT.md`.

Test przeglądarkowy dużego archiwum: uruchom serwer HTTP w katalogu projektu
(`python -m http.server 8899`) i otwórz
`http://localhost:8899/tests/browser_harness.html`.

> `tests/whisper_e2e.py` używa opcjonalnie plików audio z repozytorium
> faster-whisper. Jeśli sklonujesz je obok projektu jako `faster-whisper-master/`,
> uruchomi się dodatkowy test mechanizmu `hotwords`. Bez tego katalogu ten
> pojedynczy test zgłasza `NOT_AVAILABLE` i nie blokuje reszty.

---

## Struktura

```
index.html              aplikacja — jedyny entry point
skryptorium-core.js     logika: chunkowanie, walidacja, eksporty, analiza archiwum
vendor/                 JSZip (lokalnie, bez CDN)
local-engine/           serwer faster-whisper + proxy do Ollamy
tests/                  testy regresyjne i integracyjne
docs/                   raporty techniczne
```

---

## Prywatność

Transkrypty, analizy i audio trafiają do IndexedDB przeglądarki i nie są nigdzie
wysyłane. Przy analizie przez Ollamę trasa danych to
`przeglądarka → 127.0.0.1:8765 → 127.0.0.1:11434` — wszystko lokalnie.
Klucz Gemini, jeśli go użyjesz, zostaje w `localStorage` i nie trafia do
eksportów ani kopii zapasowych.
