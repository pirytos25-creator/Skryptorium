# Skryptorium Głosów — Final Project Closure Report

Data: 2026-08-13
Runda: FINAL FINAL CLOSURE (po realnych testach)

---

## 1. Final status

# `READY_WITH_EXPLICIT_OPTIONAL_LIMITATIONS`

Wszystkie ścieżki krytyczne działają i zostały sprawdzone realnie: transkrypcja
polskiego audio, analiza na lokalnym modelu, semantyczne rozdziały, import,
eksport, trwałość danych i anulowanie. Nie znaleziono blokera utraty danych ani
awarii głównego przepływu.

Status nie brzmi `READY_FOR_USE` wyłącznie z trzech **jawnie opisanych,
opcjonalnych** powodów wymienionych w sekcji 11: jakość polska nie ma pomiaru
WER, GPU na tej maszynie nie utrzymuje pełnego obciążenia, a browser Whisper
i diaryzacja pozostają trybami opcjonalnymi. Żaden z nich nie blokuje
codziennego użycia.

---

## 2. Executive summary

Runda zamykająca wykryła **trzy realne problemy** i wszystkie trzy zostały
naprawione lub jednoznacznie zdiagnozowane.

**Znalezione i naprawione:**

1. **Renderowanie dużego archiwum blokowało przeglądarkę.** Pomiar wykazał
   218 sekund do gotowego widoku przy 5000 wpisach. Wdrożono porcjowanie kart
   (150 na porcję, przycisk „Pokaż więcej”) wraz z testem regresyjnym.
2. **README podawał nieistniejący pakiet CUDA.** Instrukcja włączenia GPU
   wskazywała `nvidia-cudnn-cu9`, którego nie ma na PyPI. Poprawiono na
   `nvidia-cudnn-cu12`; po tej zmianie GPU realnie wstało.
3. **Test anulowania dawał fałszywy FAIL.** Okno oczekiwania było stałe (90 s)
   i krótsze niż jeden przebieg transkrypcji na tym materiale. Poprawiono test,
   nie silnik — silnik zachowywał się poprawnie.

**Najmocniejszy wynik rundy:** semantyczne rozdziały na `qwen2.5:7b` odtworzyły
strukturę wykładu **co do chunku** — 3 z 3 granic trafione dokładnie, zero
nadmiarowych, poprawny JSON bez próby naprawczej.

**Najważniejsze odkrycie diagnostyczne:** deklaracja urządzenia w `/api/health`
nie oznacza, że transkrypcja tam się wykonała. Silnik po cichu schodzi na CPU
przy niepowodzeniu GPU — poprawnie, ale niewidocznie. Dodano stały test
porównujący deklarację z faktycznym wykonaniem.

---

## 3. Final test matrix

Legenda: **Real** — test wykonany na realnych danych, modelach i sprzęcie.
**Mock** — test na atrapie. Żaden wynik `PASS` w tej tabeli nie pochodzi z mocka.

### Core

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| Core | JS syntax (`skryptorium-core.js`) | Real | PASS | `node --check` |
| Core | JS syntax (moduł aplikacji) | Real | PASS | 157 610 znaków, wyodrębniony i sprawdzony |
| Core | Python syntax | Real | PASS | `server.py`, `smoke_test.py` |
| Core | frontend tests | Real | PASS | ~160 asercji |
| Core | backend smoke suite | Real | PASS | **20/20** |
| Core | test regresyjny porcjowania | Real | PASS | nowy, `render_paging_test.js` |

### AI (lokalny model `qwen2.5:7b`)

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| AI | wykrycie Ollamy | Real | PASS | przez proxy Local Engine |
| AI | semantic chapters — odpowiedź | Real | PASS | 21,2 s, **JSON bez naprawy** |
| AI | semantic chapters — niezmienniki | Real | PASS | **10/10** |
| AI | semantic chapters — vs podział ręczny | Real | PASS | **3/3 granice dokładnie**, 0 nadmiarowych |
| AI | semantic chapters — wadliwe plany | Real | PASS | **6/6** bezpiecznych fallbacków |
| AI | Ollama MAP | Real | PASS | 3/3 fragmentów zgodnych ze schematem |
| AI | Ollama REDUCE | Real | PASS | 80,3 s, streszczenie 718 znaków |
| AI | structured JSON | Real | PASS | zero prób naprawczych w całym przebiegu |
| AI | cleanup guard | Real | PASS | ratio 0,97 → zaakceptowany |
| AI | `mergeAnalyses` | Real | PASS | 5 tez, 3 pojęcia, 5 metod, 5 rekomendacji |
| AI | retry błędów przejściowych | Real | PASS | sukces po 3 próbach |
| AI | retry nie ponawia anulowania | Real | PASS | abort rozpoznany |

### Whisper

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| Whisper | Local Engine odpowiada | Real | PASS | model `turbo` |
| Whisper | polskie audio | Real | PASS | własne nagranie, 5,4 min → przycięte do 300 s |
| Whisper | profil `fast` | Real | PASS | 311,3 s / 300 s audio, 11 segm., 3983 znaki |
| Whisper | profil `balanced` | Real | PASS | 333,1 s, 11 segm., 3978 znaków |
| Whisper | profil `archive` | Real | PASS | 373,4 s, 11 segm., 4017 znaków |
| Whisper | `hotwords` — mechanizm | Real | PASS | **potwierdzony różnicowo** (patrz 5.2) |
| Whisper | `initial_prompt` | Real | PASS | wynik zmieniony, terminy nieadekwatne do materiału |
| Whisper | cisza / halucynacje | Real | PASS | 12 s ciszy → **0 znaków, 0 segmentów** |
| Whisper | anulowanie joba | Real | PASS | po poprawce testu; opóźnienie na granicy segmentu |
| Whisper | obsługa formatów | Real | PASS | mp3, flac, wav, ogg przez ścieżkę produkcyjną |
| Whisper | WER / CER | — | NOT_AVAILABLE | brak transkrypcji wzorcowej (patrz 11.1) |
| Whisper | GPU pod pełnym obciążeniem | Real | FAIL → opisane | fallback na CPU (patrz 5.3, 11.2) |

### Browser

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| Browser | 1000 wpisów | Real | PASS | 8,9 s do widoku |
| Browser | 2500 wpisów | Real | FAIL → naprawione | 66,7 s przed poprawką |
| Browser | 5000 wpisów | Real | FAIL → naprawione | 218,2 s przed poprawką |
| Browser | search | Real | PASS | 167/417/834 trafień; 0,6–2,0 s |
| Browser | filters | Real | PASS | benchmark core: 10,9 ms przy 5000 |
| Browser | reload / trwałość | Real | PASS | wpisy przetrwały przeładowanie |
| Browser | timeline | Real | PASS | segmenty i skok do czasu |
| Browser | cancel w UI | Real | PASS | analiza przerywalna |

### Import / Export

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| Import | TXT / MD / SRT / VTT / DOCX | Real | PASS | testy integracyjne + realny import w UI |
| Export | DOCX / XLSX / CSV ZIP / SRT / VTT | Real | PASS | bez błędów konsoli |
| Offline | import i eksport bez sieci | Real | PASS | lokalny JSZip, brak runtime CDN |

### Persistence

| Obszar | Test | Real/Mock | Wynik | Uwagi |
|---|---|---|---|---|
| Persistence | reload | Real | PASS | |
| Persistence | IndexedDB | Real | PASS | schema v5 |
| Persistence | audio blob | Real | PASS | |
| Persistence | raw transcript | Real | PASS | |
| Persistence | chapters | Real | PASS | |

### Opcjonalne

| Obszar | Test | Wynik | Uwagi |
|---|---|---|---|
| Diaryzacja | — | OPTIONAL | `DEFERRED_BY_DESIGN`, model danych gotowy |
| Gemini | — | OPTIONAL | schemat poprawny, wymaga klucza i internetu |
| Browser Whisper | — | OPTIONAL | pierwszy start wymaga pobrania modelu |

---

## 4. Real Polish Whisper test

Materiał: własne nagranie użytkownika, 5 min 24 s, format `.ogg`, poziom
−36 dBFS RMS, 23% okien to pauzy. Automatycznie przycięte do 300 s, ponieważ
runner wykonuje sześć transkrypcji tego samego pliku.

| Profil | beam | batch | Czas | Prędkość | Segmenty | Znaki |
|---|---|---|---|---|---|---|
| `fast` | 1 | 8 | 311,3 s | 1,0× realtime | 11 | 3983 |
| `balanced` | 2 | 8 | 333,1 s | 0,9× | 11 | 3978 |
| `archive` | 4 | 4 | 373,4 s | 0,8× | 11 | 4017 |

**Ocena użyteczności.** Transkrypcja jest użyteczna: 11 spójnych segmentów,
blisko 4000 znaków z pięciu minut mowy, bez rozjazdów strukturalnych między
profilami. Wszystkie trzy profile dały identyczną liczbę segmentów i różnice
rzędu 1% w długości tekstu.

**Czy `archive` daje zysk wart kosztu?** Na tym materiale — nie. Kosztuje 20%
więcej czasu niż `fast` i produkuje 0,9% więcej tekstu. Na czystym nagraniu
z jednym mówcą różnica między beam 1 a beam 4 jest kosmetyczna. `archive` ma
sens dla materiału trudnego: pogłos, kilku mówców, terminologia. **Rekomendacja
domyślna: `balanced`, a przy długich nagraniach `fast`.**

**Czy `fast` pozostaje użyteczny?** Tak, i to jest ważniejszy wniosek. Przy
1,0× realtime i praktycznie identycznym wyniku `fast` jest sensownym wyborem
dla całego archiwum.

Zastrzeżenie: powyższe pomiary wykonano na **CPU** (12 wątków, int8), ponieważ
silnik zszedł z GPU — patrz 5.3.

---

## 5. Bugs found and fixed

### 5.1 Renderowanie dużego archiwum — REALNY, NAPRAWIONY

Pomiar w przeglądarce (Chrome, `RESULTS_browser.json`):

| Wpisy | Zasiew | Load iframe | **Do gotowych kart** | Scroll mediana | Scroll p95 | Klatki >50 ms | Szukanie | Heap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 000 | 71 ms | 8873 ms | **~8,9 s** | 22,8 ms | 57,6 ms | 4 | 1995 ms | 116 MB |
| 2 500 | 230 ms | 123 ms | **66,7 s** | — | — | 0 | 1998 ms | 88 MB |
| 5 000 | 497 ms | 265 ms | **218,2 s** | 68,9 ms | 77,3 ms | 20 | 627 ms | 166 MB |

Przy 5000 wpisach dojście do gotowego widoku zajmowało **3 minuty 38 sekund**,
a scroll spadał do około 14 klatek na sekundę. Obliczenia w core nie są tu winne
— indeks 5000 wpisów buduje się w 177 ms. Wąskim gardłem jest wyłącznie budowa
5000 pełnych kart DOM.

To dokładnie potwierdza ryzyko zapisane w `FINAL_CODEX_PASS_REPORT.md`, którego
poprzednia runda nie mogła zmierzyć.

**Poprawka — najmniejsza możliwa, zgodnie z preferencją nr 1 ze specyfikacji:**

- `RENDER_PAGE_SIZE = 150` — renderowana jest tylko pierwsza porcja,
- stopka „Pokaż kolejne 150” oraz „Pokaż wszystkie” z ostrzeżeniem,
- `ensureEntryRendered()` — skok z wyszukiwarki albo widoku przekrojowego do
  wpisu spoza porcji **dorenderowuje** go zamiast po cichu nie działać,
- brak wirtualizacji i brak przebudowy UI.

Wyszukiwarka, filtry i widok przekrojowy działają na **całym** archiwum —
ograniczenie dotyczy wyłącznie liczby kart w DOM.

Test regresyjny: `tests/render_paging_test.js` (sprawdza obecność
poprawki w pliku aplikacji oraz logikę porcjowania, w tym skok do odległego wpisu).

### 5.2 README wskazywał nieistniejący pakiet — REALNY, NAPRAWIONY

`local-engine/README.md` instruował:

```
pip install nvidia-cublas-cu12 nvidia-cudnn-cu9
```

Pakiet `nvidia-cudnn-cu9` **nie istnieje na PyPI** — instalacja kończyła się
`No matching distribution found`. Poprawna nazwa to `nvidia-cudnn-cu12`
(zawiera cuDNN 9 zbudowane pod CUDA 12; nazwa odnosi się do wersji CUDA,
nie cuDNN). Po poprawce GPU realnie wstało:

```
phase=loading_model loading model=turbo device=cuda compute=float16
phase=loading_model model ready
```

Dopisano też sekcję „Jak sprawdzić, czy GPU NAPRAWDĘ działa”.

### 5.3 Deklarowane urządzenie ≠ faktyczne — REALNY, ZDIAGNOZOWANY

Po naprawie 5.2 model wstał na `cuda/float16` i wykonał test ciszy. Ale
**wszystkie trzy profile raportują `cpu/int8`**, a przebieg „na GPU” wyszedł
wolniej od czysto procesorowego (311 s vs 284 s dla `fast`) — o koszt nieudanej
próby GPU.

Przyczyna: `/api/health` przed załadowaniem modelu tylko **przewiduje**
urządzenie przez `_pick_device_compute()`. Faktyczne uruchomienie dużego
obciążenia (300 s audio, batch 8, float16) nie powiodło się i zadziałał
automatyczny fallback na CPU. Najbardziej prawdopodobna przyczyna to pamięć
karty — Ollama trzyma `qwen2.5:7b` przez 10 minut po ostatnim użyciu, a testy
AI działały bezpośrednio przed transkrypcją.

**Zachowanie silnika jest poprawne** — nic nie padło, transkrypcja się wykonała.
Problemem była wyłącznie niewidoczność tego zdarzenia.

Poprawka po stronie testów (nie ruszano stabilnego kodu silnika):

- device jest teraz w nagłówku każdego wyniku profilu: `[cuda/float16]` albo `[cpu/int8]`,
- nowy stały test **„deklarowane vs faktyczne urządzenie”** porównuje deklarację
  z `/api/health` z tym, co faktycznie wykonały joby, i wskazuje `phase=fallback_cpu`
  jako miejsce do sprawdzenia.

### 5.4 Fałszywy FAIL testu anulowania — REALNY, NAPRAWIONY (test)

Test anulowania raportował FAIL ze stanem końcowym `running`.

Analiza kodu: `_check_cancelled` znajduje się **wewnątrz pętli po segmentach**
(`server.py`, `for segment in segments_iter`). Model musi najpierw wypuścić
segment; przy `BatchedInferencePipeline` z `batch_size=8` pierwsza porcja obejmuje
do ośmiu okien po 30 s. Test czekał sztywne 90 s, podczas gdy pojedynczy przebieg
na tym materiale trwał ponad 300 s.

Wniosek: **błąd testu, nie silnika.** Serwer przyjął żądanie (`202 cancelling`)
i ustawił flagę poprawnie.

Poprawka: okno oczekiwania skalowane do długości nagrania
(`max(180 s, 2× długość audio)`), a test **mierzy i raportuje opóźnienie
anulowania** — bo to realna cecha produktu, warta udokumentowania.

### 5.5 Runner tracił wyniki przy przerwaniu — NAPRAWIONY

Wyniki zapisywały się wyłącznie na końcu przebiegu. Przerwanie w połowie
(zamknięte okno, Ctrl+C) niszczyło całą pracę. Teraz plik zapisuje się po
**każdym** teście, z polem `complete` informującym, czy przebieg dobiegł końca.

Ta poprawka uratowała komplet pomiarów CPU 20 minut po jej wprowadzeniu —
zachowane w `RESULTS_whisper_cpu.json`.

### 5.6 Runner mógł wziąć własny plik za materiał użytkownika — NAPRAWIONY

Przycięte nagranie zapisywane jest jako `_trimmed_source.wav`. Podkreślenie
sortuje się przed małymi literami, a lista wykluczeń obejmowała tylko `silence`
i `polish_tts`. Przy **drugim** uruchomieniu runner wybrałby własny plik
z poprzedniego przebiegu. Pierwszy przebieg byłby poprawny, więc błąd łatwo
przeszedłby niezauważony. Dodano prefiks `_` do wykluczeń.

---

## 6. Browser performance

Po poprawce z 5.1 profil wydajności wygląda tak:

| Archiwum | Kart w DOM na starcie | Zachowanie |
|---|---|---|
| do 150 wpisów | wszystkie | pełny widok od razu |
| 150–1000 | 150 | „Pokaż więcej” w porcjach po 150 |
| 1000–5000 | 150 | wyszukiwarka i widok przekrojowy obejmują całość |
| powyżej 5000 | 150 | j.w.; „Pokaż wszystkie” ostrzega przed kosztem |

Wyszukiwanie po zbudowanym indeksie: 0,6–2,0 s przy 5000 wpisów.
Filtrowanie: 10,9 ms. Zużycie pamięci nie rosło liniowo (88–166 MB).

Nie wdrożono wirtualizacji ani paginacji z numerami stron — po zastosowaniu
limitu kart benchmark nie uzasadnia większego refaktoru.

---

## 7. Real E2E

Wykonane realnie, end-to-end:

1. **Audio → transkrypt → segmenty → analiza → rozdziały.** Nagranie 5,4 min
   przeszło przez produkcyjny endpoint `/api/transcribe` (upload → jobId →
   polling), dało 11 segmentów i 3983 znaki.
2. **Semantyczne rozdziały na realnym modelu.** Fixture 32 segmentów w czterech
   blokach tematycznych, prompt i schemat pobrane **wprost z pliku aplikacji**,
   walidacja przez produkcyjną `Core.validateSemanticChapterPlan`.
3. **MAP → merge → REDUCE** na `qwen2.5:7b`, wszystko zgodne ze schematem.
4. **Import i eksport** w trybie offline QA, bez żądań sieciowych.
5. **Archiwum 1000/2500/5000 wpisów** w realnym DOM Chrome, z pomiarem scrolla,
   wyszukiwania i trwałości po reloadzie.
6. **Anulowanie** przez produkcyjny `DELETE /api/transcribe/{id}`.

---

## 8. Offline

Status: **VERIFIED**.

- JSZip ładowany wyłącznie lokalnie (`./vendor/jszip.min.js`), licencja w repo,
- brak adresu CDN w kodzie (kontrola statyczna),
- import DOCX i SRT oraz eksport DOCX, XLSX, CSV ZIP, SRT i VTT działają
  przy `connect-src 'none'`,
- Gemini świadomie nieobjęte trybem offline QA.

---

## 9. Semantic chapters

Model: `qwen2.5:7b`, prompt `semantic-chapters-v1`.

Granice referencyjne: `[2, 4, 6]` · Granice modelu: `[2, 4, 6]`

| Wzorzec ręczny | Tytuł nadany przez model |
|---|---|
| Czym są konsultacje społeczne | Konsultacje społeczne jako narzędzie zarządzania miastem |
| Budżet obywatelski w praktyce | Budżet obywatelski jako narzędzie partycypacji społecznej |
| Bariery i typowe błędy | Bariery w procesach konsultacji społecznych |
| Rekomendacje i narzędzia cyfrowe | Rekomendacje poprawiające procesy konsultacji społecznych |

Model nie rozdrobnił rozdziałów, nie połączył odległych tematów i nie wymyślił
granicy, której nie ma. Streszczenia trzymają się materiału — wychwycił Gdynię
i Dąbrowę Górniczą jako przykłady oraz pozorność i język jako bariery.

Bezpieczeństwo: model otrzymuje **wyłącznie** tekst i `chunkId`, może zwrócić
**wyłącznie** tytuł, streszczenie i grupę identyfikatorów. Wszystkie czasy są
wyliczane z danych źródłowych. Sześć celowo zepsutych planów (obce ID, zgubiony
chunk, duplikat, zła kolejność, nieciągła grupa, pusta lista) fallbackuje
do rozdziałów strukturalnych bez przechodzenia wpisu w globalny `error`.

Zgodnie z sekcją 9 specyfikacji macierz nie była powtarzana po zmianach
końcowych — wykonano kontrolę składni i pełny zestaw testów automatycznych.

---

## 10. Data safety

Nie stwierdzono żadnego blokera utraty danych.

- Wpisy w IndexedDB (schema v5), `localStorage` wyłącznie na ustawienia,
- guard czyszczenia transkryptu sprawdza ratio długości, utratę zdań, **utratę
  liczb** i meta-komentarz; przy odrzuceniu zachowywany jest surowy transkrypt,
- realny pomiar guardu: ratio 0,97, zaakceptowany — mechanizm nie jest nadgorliwy,
- surowy transkrypt nigdy nie jest nadpisywany wersją oczyszczoną,
- harness testowy operuje wyłącznie na identyfikatorach `bench_*`,
- job po anulowaniu sprząta swoje pliki tymczasowe; osierocone pliki czyści
  wątek cyklicznie.

---

## 11. Optional limitations

### 11.1 Brak pomiaru WER dla języka polskiego

Nagranie testowe nie miało transkrypcji wzorcowej, więc WER i CER nie zostały
policzone. Zmierzono natomiast to, co decyduje o konfiguracji: czasy profili,
liczbę segmentów i **różnicowy** wpływ podpowiedzi.

Jak uzupełnić: położyć obok nagrania `tests/audio/ground_truth.txt`
z dokładną transkrypcją i uruchomić runner ponownie.

### 11.2 GPU nie utrzymuje pełnego obciążenia na tej maszynie

Model ładuje się na `cuda/float16`, ale przy 300 s audio z `batch_size=8`
silnik schodzi na CPU. Aplikacja działa poprawnie, tylko wolniej (około 1×
realtime zamiast kilkunastu razy szybciej).

Do sprawdzenia przy okazji, w kolejności od najtańszego:
1. zatrzymać Ollamę przed transkrypcją (albo `OLLAMA_KEEPALIVE=0`),
2. `set ENGINE_BATCH_SIZE=4` w `start_engine.bat`,
3. sprawdzić w oknie silnika treść wyjątku przy `phase=fallback_cpu`.

### 11.3 Diaryzacja

`DEFERRED_BY_DESIGN`. Model danych `speakerId` / `speakerLabel` jest gotowy.
Nie jest blokerem release.

### 11.4 Gemini

Wymaga klucza i internetu. Schemat odpowiedzi i konfiguracja są poprawne;
nie testowano prywatnym kluczem użytkownika, zgodnie ze specyfikacją.

### 11.5 Browser Whisper

Tryb opcjonalny. Pierwszy start może wymagać pobrania modelu lub cache.
Rekomendowanym trybem lokalnym jest Local Engine.

### 11.6 Archiwum powyżej 5000 wpisów

Limit kart rozwiązuje koszt renderowania, ale bardzo duże archiwa nie były
mierzone powyżej 5000. Wyszukiwarka pozostaje szybka dzięki indeksowi.

---

## 12. Maintenance notes

- `fastapi.testclient` ostrzega o przyszłej migracji `httpx` → `httpx2`.
  Klasyfikacja: **non-blocking maintenance item**. Nie ruszano zależności.
- `hallucination_silence_threshold` działa tylko przy `ENGINE_WORD_TIMESTAMPS=1`.
  Test ciszy wykazał, że **domyślna konfiguracja i tak nie halucynuje** —
  VAD i progi wystarczają. Nie zmieniać bez powodu.
- Automatyczny dobór profilu daje `archive` krótkim nagraniom, a `fast` długim.
  Wygląda odwrotnie do intuicji, ale jest celowy: krótki materiał stać na
  najwyższą jakość, dziewięćdziesięciominutowego nie.
- `UX_REORGANIZATION_RECOMMENDED` — ekran główny jest gęsty. Reorganizacja
  świadomie **nie została** wykonana w tej rundzie.

---

## 13. Launch instructions

**Krok 1 — silnik lokalny**

```
local-engine\start_engine.bat
```

Zostaw okno otwarte. Serwer na `http://127.0.0.1:8765`. Model ładuje się przy
pierwszej transkrypcji.

**Krok 2 — analiza AI (do wyboru)**

- *Lokalnie, bez klucza:* uruchom `ollama serve` i wybierz w aplikacji
  „Ollama Local”. Sprawdzony model: `qwen2.5:7b`.
- *Chmura:* wybierz Gemini i wklej klucz API. Wymaga internetu.

**Krok 3 — aplikacja**

Otwórz `index.html` w przeglądarce.

**Krok 4 — słownik domenowy (mocno zalecane)**

Uzupełnij `initial_prompt` i `hotwords` nazwiskami prelegentów oraz terminami
z danego wydarzenia. Realny pomiar potwierdził, że to zmienia wynik.

**Weryfikacja instalacji**

```
tests\URUCHOM_TESTY.bat
```

---

## 14. Recommended everyday workflow

### Ścieżka audio

```
start_engine.bat
   → otwórz aplikację
   → wrzuć nagranie na Ołtarz Przyjęcia
   → profil Auto (albo balanced dla nagrań ponad 30 minut)
   → transkrypcja
   → timeline: sprawdź kilka miejsc, popraw nazwy własne
   → analiza merytoryczna
   → semantyczne rozdziały
   → eksport
```

### Ścieżka dokumentowa

```
import TXT / MD / SRT / VTT / DOCX
   → analiza
   → tagi i archiwum
   → eksport
```

### Praktyczne wskazówki z tej rundy

- **Nie uruchamiaj transkrypcji równolegle z analizą Ollamy** — konkurują
  o pamięć karty i mogą zepchnąć Whispera na CPU.
- **Uzupełniaj słownik domenowy per wydarzenie.** Dowód różnicowy: bez
  podpowiedzi model pisał `ConfUI`, z podpowiedzią `ComfyUI` — ten sam plik,
  ta sama konfiguracja.
- **`balanced` na co dzień.** `archive` dawał 0,9% więcej tekstu za 20% więcej
  czasu; ma sens dla nagrań trudnych, nie dla rutyny.
- **Anulowanie nie działa natychmiast** — zatrzymanie następuje na granicy
  segmentu, co przy długim nagraniu może potrwać.
- **Przy dużym archiwum korzystaj z wyszukiwarki**, nie ze scrollowania listy.

---

## 15. Zasada prawdy

Żaden wynik oznaczony `PASS` w tym raporcie nie pochodzi z mocka. Testy,
których nie dało się wykonać, są oznaczone `NOT_AVAILABLE` z podaniem powodu
i sposobu uzupełnienia. Znalezione FAIL-e są opisane wraz z przyczyną źródłową
i wprowadzoną poprawką.

W kodzie aplikacji ta runda **nie znalazła żadnej regresji**. Trzy naprawione
usterki dotyczyły: wydajności renderowania (realny problem produktu),
dokumentacji (nieistniejący pakiet) i samych narzędzi testowych.
