# Skryptorium Głosów — architektura informacji

Data: 2026-08-13
Runda: UX REORGANIZATION PASS (etap 1 — analiza przed implementacją)

---

## 1. Problem: policzalny, nie estetyczny

Aplikacja to **jedna ciągła strona** z pięcioma blokami ułożonymi pionowo:

```
nagłówek
Ołtarz Przyjęcia (upload + status + kolejka)
Konfiguracja Skryby        ← 8 pól ZAWSZE widocznych + 3 zwijane sekcje
Nawigacja po Archiwum      ← 8 filtrów + 2 checkboxy + 3 tryby analityki
Codex Głosów (lista wpisów)
```

Policzone na obecnym pliku, w stanie po otwarciu aplikacji:

| Blok | Kontrolek zawsze widocznych |
|---|---|
| Ołtarz Przyjęcia | 1 |
| Konfiguracja Skryby | **9** (5 select, 3 input, 1 przycisk) + 3 zwijane |
| Nawigacja po Archiwum | **14** (1 search, 8 filtrów, 2 checkboxy, 3 przełączniki widoku) |
| Razem przed pierwszym wpisem | **24 kontrolki** |

Konsekwencja: między „wrzuć plik" a „zobacz swoje wpisy" użytkownik przewija
dwa pełne ekrany ustawień i filtrów, których w tym momencie nie potrzebuje.
Lista wpisów — czyli właściwa treść produktu — jest **najniżej na stronie**.

Drugi problem: **konfiguracja techniczna sąsiaduje z pracą merytoryczną**.
Token API, wybór akceleracji WebGPU i model Ollamy leżą w tym samym pionie co
pole wyszukiwania i lista nagrań. To dwa różne tryby myślenia na jednym ekranie.

Trzeci: **analityka przekrojowa jest zawsze włączona**. TF-IDF, trendy
i współwystępowanie liczą się i renderują niezależnie od tego, czy użytkownik
właśnie ich potrzebuje.

---

## 2. Klasyfikacja istniejących funkcji

Kryterium: **jak często** i **w jakim kontekście** funkcja jest używana.

### A. Codzienna praca — każda sesja
- upuszczenie audio / import dokumentu
- pasek statusu i kolejka zadań
- lista wpisów z ostatnimi materiałami
- otwarcie wpisu: odtwarzacz, timeline, transkrypt, analiza, rozdziały
- eksport pojedynczego wpisu

### B. Ustawienia per materiał — przed transkrypcją, zmieniane co wydarzenie
- profil przetwarzania (`auto` / `fast` / `balanced` / `archive`)
- kontekst i nazwy własne (`initial_prompt`)
- hotwords

> To jest kategoria graniczna. Formalnie „ustawienia", ale realnie część
> workflow: finalne testy wykazały **różnicowy** wpływ hotwords na wynik
> (`ConfUI` → `ComfyUI` na tym samym pliku). Muszą zostać przy Ołtarzu.

### C. Konfiguracja techniczna — raz, potem prawie nigdy
- silnik transkrypcji (Browser / Local Engine), model, język, akceleracja
- token Local Engine
- silnik analizy (Ollama / Gemini), model Ollamy, klucz Gemini, model Gemini
- auto-analiza po transkrypcji, czyszczenie transkryptu przez LLM
- panel diagnostyczny silnika + instrukcje uruchomienia

### D. Nawigacja po archiwum — rośnie z czasem
- wyszukiwanie globalne (podstawowe, częste)
- osiem filtrów szczegółowych (rzadkie, uzupełniające)
- wyniki z timestampami i przejściem do wpisu

### E. Analiza przekrojowa — świadome wejście w tryb
- agregacja pojęć, metod, tez, rekomendacji
- TF-IDF, trendy, współwystępowanie, statystyki
- eksport korpusowy (CSV ZIP, XLSX)

---

## 3. Proponowana struktura

**Trzy konteksty w górnej nawigacji + wyszukiwarka zawsze pod ręką.**

```
┌──────────────────────────────────────────────────────────┐
│  SKRYPTORIUM GŁOSÓW                                       │
│  [ Praca ]  [ Archiwum ]  [ Ustawienia ]     [ 🔍 szukaj ]│
└──────────────────────────────────────────────────────────┘
```

### Praca — widok domyślny
```
Ołtarz Przyjęcia            (upload, duży, pierwszy)
  └ Słownik domenowy ▾      (profil + kontekst + hotwords, zwijany)
Status + kolejka            (widoczne tylko gdy coś się dzieje)
Codex Głosów                (lista wpisów, porcjowana po 150)
```

### Archiwum
```
Wyszukiwanie                (jedno pole, zawsze rozwinięte)
  └ Filtry szczegółowe ▾    (8 filtrów, zwijane)
Wyniki
Analiza przekrojowa ▾       (agregacja / analityka / eksport korpusowy)
```

### Ustawienia
```
Transkrypcja                (silnik, model, język, akceleracja, token)
Analiza AI                  (Ollama / Gemini, modele, klucz, przełączniki)
Diagnostyka                 (panel silnika, testy połączeń, instrukcje)
```

---

## 4. Uzasadnienie kluczowych decyzji

**Dlaczego trzy konteksty, a nie dwa lub pięć.**
Dwa (Praca / Archiwum) zmuszałyby do wciśnięcia konfiguracji technicznej
w jeden z nich — a to właśnie ona najbardziej zaśmieca dziś ekran. Cztery lub
więcej oznaczałoby zakładkę na funkcję, czyli dokładnie ten błąd, przed którym
ostrzega specyfikacja. Trzy odpowiadają trzem realnym trybom pracy:
*przetwarzam materiał*, *szukam w tym, co mam*, *konfiguruję narzędzie*.

**Dlaczego wyszukiwarka jest poza zakładkami.**
Wyszukiwanie to najczęstszy sposób nawigacji w dużym archiwum. Ukrycie go za
zakładką dodałoby jedno kliknięcie do najczęstszej czynności. Pole w nagłówku
działa z każdego kontekstu i przełącza na Archiwum po wpisaniu frazy.

**Dlaczego hotwords zostają przy Ołtarzu.**
Jedyne ustawienie z udowodnionym pomiarowo wpływem na jakość wyniku, zmieniane
per wydarzenie. Przeniesienie do Ustawień oznaczałoby, że nikt go nie użyje.
Zwijany blok „Słownik domenowy" zamyka je wizualnie, ale zostawia jedno
kliknięcie od uploadu — i pokazuje podsumowanie, gdy jest wypełniony.

**Dlaczego kolejka znika, gdy jest pusta.**
Pasek statusu i lista zadań mają wartość wyłącznie w trakcie pracy. Puste
zajmują miejsce nad treścią.

**Dlaczego analityka przekrojowa idzie do Archiwum, a nie osobno.**
To ta sama intencja użytkownika — „patrzę na to, co już mam" — tylko w innej
skali. Osobna zakładka rozdzielałaby rzeczy, które chodzą razem.

---

## 5. Co się NIE zmienia

Świadomie nietknięte:

- **Charakter i nazewnictwo.** „Ołtarz Przyjęcia", „Codex Głosów",
  „Konfiguracja Skryby", sigile, typografia Cinzel/Garamond, paleta.
  Reorganizacja dotyczy struktury, nie osobowości.
- **Porcjowanie renderowania po 150 kart** wraz z `ensureEntryRendered()`.
- Cache indeksu i analityki, debounce wyszukiwania 160 ms, lazy audio,
  batching timeline.
- Wszystkie identyfikatory elementów — węzły są **przenoszone**, nie
  przepisywane, więc istniejące bindowania JS pozostają nienaruszone.
- Backend w całości. Zero zmian w `server.py`, kontrakcie API, schemacie
  IndexedDB i pipeline AI.

---

## 6. Ryzyka i sposób ich ograniczenia

| Ryzyko | Ograniczenie |
|---|---|
| Zerwane bindowania po przeniesieniu DOM | Zachowanie wszystkich `id`; przenoszenie węzłów zamiast przepisywania |
| Ukrycie funkcji, której ktoś używał | Nic nie znika — wszystko jest o jedno kliknięcie dalej, w przewidywalnym miejscu |
| Powrót problemu renderowania | Test regresyjny `render_paging_test.js` uruchamiany po zmianach |
| Utrata dostępności | Zachowanie kolejności focusu, `aria-label` na nowej nawigacji, `Ctrl/Cmd+F` |
| Regresja logiki | Pełny zestaw testów po implementacji: frontend, core, backend smoke |

---

## 7. Miara sukcesu

Po reorganizacji, na ekranie startowym:

| | Przed | Po |
|---|---|---|
| Kontrolek widocznych od razu | 24 | **2** (upload + wyszukiwarka) |
| Przewinięć do listy wpisów | 2 pełne ekrany | **0** |
| Kliknięć do hotwords | 0 (ale w ścianie 9 pól) | 1 (zwijany blok przy uploadzie) |
| Kliknięć do ustawień technicznych | 0 (zawsze na ekranie) | 1 |
| Kliknięć do analityki archiwum | 0 (zawsze liczona) | 2 |

Nowy użytkownik po otwarciu widzi: tytuł, trzy zakładki, pole wyszukiwania,
duży obszar upuszczania pliku i swoje wpisy. Nic więcej.
