# Przygotowanie repozytorium — raport

Data: 2026-08-13
Źródło: katalog roboczy projektu (nietknięty)
Wynik: `skryptoriumMaxima/` — 33 pliki, 648 KB

---

## 1. Źródło produkcyjne

Ustalone na podstawie dat modyfikacji, finalnych raportów i faktycznych
zależności w kodzie — nie na podstawie nazw plików.

| Rola | Wybrany plik | Uzasadnienie |
|---|---|---|
| Entry point | `skryptorium (1).html` → **`index.html`** | jedyny HTML aplikacji; zawiera reorganizację UX z 13.08 i porcjowanie kart; testy `ux_structure_test` i `render_paging_test` odnoszą się właśnie do niego |
| Logika współdzielona | `skryptorium-core.js` | ładowany przez `<script src>` w aplikacji i wymagany przez wszystkie testy |
| Backend | `local-engine/server.py` | wersja z 12.08 18:43; przechodzi smoke suite 20/20 |
| Biblioteka lokalna | `vendor/jszip.min.js` + licencja | offline QA potwierdziło brak zależności od CDN |

Odrzucone jako nieaktualne: `local-engine/server_old.py.bak`,
`local-engine/README_old_kapsula.html.bak`, `round2_browser_harness.html`
(harness z rundy 2, zastąpiony przez `tests/browser_harness.html`).

Paradoks nazwy: plik z `(1)` w nazwie **był** wersją produkcyjną — skopiowany
pod poprawną nazwą `index.html`, zgodnie z wyjątkiem opisanym w zadaniu.

---

## 2. Struktura końcowa

```
skryptoriumMaxima/
├── index.html                      aplikacja (entry point)
├── skryptorium-core.js             logika współdzielona
├── README.md
├── .gitignore
├── REPO_PREPARATION_REPORT.md
│
├── vendor/
│   ├── jszip.min.js
│   └── JSZIP_LICENSE.markdown
│
├── local-engine/
│   ├── server.py
│   ├── smoke_test.py
│   ├── start_engine.bat
│   ├── requirements.txt
│   └── README.md
│
├── tests/
│   ├── URUCHOM_TESTY.bat           uruchamia zestaw regresyjny
│   ├── frontend_test.js            logika core, ~160 asercji
│   ├── render_paging_test.js       porcjowanie kart
│   ├── ux_structure_test.js        architektura informacji
│   ├── ai_e2e.js                   E2E na realnym modelu (opcjonalny)
│   ├── whisper_e2e.py              E2E transkrypcji (opcjonalny)
│   ├── browser_harness.html        pomiar dużego archiwum
│   ├── extract_prompts.js          wyciąga prompty z index.html
│   ├── fixture_wyklad.js           syntetyczny wykład do testów rozdziałów
│   └── fixtures/                   10 plików: SRT, VTT, DOCX, MD, TXT, JSON
│
└── docs/
    ├── FINAL_PROJECT_CLOSURE_REPORT.md
    ├── UX_REORGANIZATION_REPORT.md
    └── UX_INFORMATION_ARCHITECTURE.md
```

---

## 3. Zmiany ścieżek wymuszone przeniesieniem

Wyłącznie ścieżki. Zero zmian w logice, UI, backendzie i promptach.

| Plik | Zmiana |
|---|---|
| `tests/extract_prompts.js` | wykrywanie aplikacji: wzorzec `/skryptorium/` → `name === 'index.html'` |
| `tests/render_paging_test.js` | j.w. |
| `tests/ux_structure_test.js` | j.w. |
| `tests/frontend_test.js` | ścieżki względem `__dirname` zamiast CWD; `./skryptorium (1).html` → `ROOT/index.html`; `./test-fixtures/` → `tests/fixtures/` |
| `tests/browser_harness.html` | `../skryptorium%20(1).html` → `../index.html`; adres harnessu `/closure_tests/` → `/tests/` |
| `tests/whisper_e2e.py` | komunikaty i ścieżki `closure_tests\` → `tests\` |
| `docs/*.md` | odwołania do starych nazw ujednolicone |

Efekt uboczny wart odnotowania: `frontend_test.js` używał ścieżek względnych do
katalogu roboczego, więc działał tylko uruchomiony z katalogu głównego. Teraz
działa z dowolnego miejsca.

---

## 4. Usunięte z paczki

| Kategoria | Przykłady | Powód |
|---|---|---|
| Kopia biblioteki | `faster-whisper-master/` (320 MB) | instalowana z PyPI przez `requirements.txt` |
| Środowisko | `local-engine/.venv/` (311 MB), `__pycache__/` | generowane przez `start_engine.bat` |
| Materiał użytkownika | `tests/audio/` — nagranie głosowe, TTS, przycięty WAV (12 MB) | prywatne dane |
| Wyniki przebiegów | `RESULTS_ai.json`, `RESULTS_whisper.json`, `RESULTS_whisper_cpu.json`, `RESULTS_browser.json` | historia pomiarów, nie kod; liczby zachowane w raportach |
| Raporty pośrednie | `AUDYT_skryptorium.md`, `REPAIR_REPORT.md`, `ROUND2/3_*.md`, `CLOSURE_BASELINE.md`, `CLOSURE_PROGRESS.md`, `CHANGELOG_*.md`, `FINAL_CODEX_PASS_REPORT.md`, `ARCHIVE_BENCHMARK.md`, `DO_ZROBIENIA_TERAZ.md` | historia rund agenta; wnioski są w raporcie końcowym |
| Kopie zapasowe | `server_old.py.bak`, `README_old_kapsula.html.bak`, `round2_browser_harness.html` | zastąpione |
| Robocze | `cos dla claudea/`, `.agents/` | katalogi pomocnicze |
| Fixture'y ciężkie | `test-fixtures/round3-export.xlsx`, `xlsx-qa/` | wyniki eksportu, odtwarzalne |

Oryginalny katalog **nie został zmodyfikowany** poza utworzeniem w nim
podkatalogu `skryptoriumMaxima`.

---

## 5. Security check

| Kontrola | Wynik | Szczegóły |
|---|---|---|
| Sekrety (Gemini, OpenAI, GitHub, Slack, Bearer, klucze prywatne) | **PASS** | 0 dopasowań wzorców w 33 plikach |
| Pola na klucze w kodzie | **PASS** | `apiKey: ''`, `localApiToken: ''`, `ENGINE_API_TOKEN` domyślnie pusty; w `start_engine.bat` wyłącznie zakomentowany przykład |
| Pliki `.env` | **PASS** | brak |
| Prywatne audio | **PASS** | brak plików dźwiękowych; `voice-message.ogg` i pochodne nie skopiowane |
| Prywatne transkrypty | **PASS** | fixtures są syntetyczne (wykład testowy o partycypacji, dialog SRT) |
| Ścieżki lokalne / nazwa użytkownika | **PASS** | brak wystąpień ścieżek bezwzględnych i nazwy konta |
| Modele AI | **PASS** | brak `.bin`, `.safetensors`, `.gguf`, `.ct2` |
| Pliki > 1 MB | **PASS** | brak; największy to `index.html` (211 KB) |
| Rozmiar repozytorium | **PASS** | 648 KB |

Symulacja `git add .` z uwzględnieniem `.gitignore`: **33 pliki, 0 pominiętych**
— czyli w katalogu nie ma niczego, co `.gitignore` musiałby odfiltrować.
Reguły są zabezpieczeniem na przyszłość (po `start_engine.bat` powstanie
`.venv/`, po testach `RESULTS_*.json` i `tests/audio/`).

---

## 6. Testy nowego folderu

Wszystkie uruchomione **z katalogu `skryptoriumMaxima`**, nie ze źródła.

| Test | Wynik |
|---|---|
| JS syntax (`skryptorium-core.js`) | PASS |
| JS syntax (`tests/ai_e2e.js`) | PASS |
| Python syntax (`tests/whisper_e2e.py`) | PASS |
| frontend (`tests/frontend_test.js`, ~160 asercji) | PASS |
| render paging (`tests/render_paging_test.js`) | PASS |
| UX structure (`tests/ux_structure_test.js`) | PASS |
| backend smoke (`local-engine/smoke_test.py`) | PASS — 20/20 |
| index asset paths | PASS |

Kontrola zasobów `index.html`: `skryptorium-core.js` i `./vendor/jszip.min.js`
istnieją pod zadeklarowanymi ścieżkami. Jedyne odwołania zewnętrzne to Google
Fonts — aplikacja działa bez nich, korzystając z lokalnych fallbacków CSS.

**Nie wykonano:** realnego smoke testu w przeglądarce (brak przeglądarki
w moim środowisku). Przełączanie widoków Praca / Archiwum / Ustawienia,
upload i wyszukiwanie zweryfikowane statycznie przez `ux_structure_test.js`
i parser DOM. Warto kliknąć raz po otwarciu `index.html`.

---

## 7. Git

Nie inicjalizowano repozytorium, nie konfigurowano zdalnego, niczego nie
wypchnięto — zgodnie z poleceniem.

Gdy zaakceptujesz zawartość:

```bash
cd skryptoriumMaxima
git init
git add .
git commit -m "Initial stable release"
```

> **Uwaga o lokalizacji.** Mam dostęp wyłącznie do katalogu
> `<Pulpit>\skryptorium`, więc nowy folder powstał **w środku**
> niego, a nie obok. Przed inicjalizacją Gita przenieś go poziom wyżej, na
> `<Pulpit>\skryptoriumMaxima` — inaczej repozytorium będzie
> zagnieżdżone w starym katalogu roboczym.

---

## 8. Gotowość

```
GITHUB_READY
```

Zastrzeżenie do świadomej akceptacji: nie wykonano ręcznego testu w przeglądarce
z nowej lokalizacji. Wszystkie kontrole automatyczne, ścieżki zasobów
i bezpieczeństwo — zielone.
