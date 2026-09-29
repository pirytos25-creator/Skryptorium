# Skryptorium Głosów — Runda 4: jakość, szybkość, UX

Data: 2026-09-22

## Co zmieniono

Szczegóły dla użytkownika: `README.md` → „Co nowego w v4”. Szczegóły silnika:
`local-engine/README.md` → „v4 — jakość i odporność GPU”.

## Znalezione przy okazji błędy (naprawione)

| Błąd | Skutek | Poprawka |
|---|---|---|
| batched pipeline domyślnie `without_timestamps=True` | segmenty do 30 s — oś czasu, SRT i skoki mało precyzyjne (raport v3: 5 min → 11 segmentów) | timestampy włączone |
| po jednej awarii GPU `_force_cpu=True` na zawsze | wszystkie kolejne nagrania na CPU do restartu silnika | CPU tylko na cool-down, potem GPU |
| fallback CPU zaczynał transkrypcję od zera | stracona praca GPU | wznowienie od ostatniego segmentu |
| `<label class="altar">` bez `display:block` | ramka strefy upuszczania rysowała się jako mały prostokąt | `display:block` |
| zdublowany tytuł „Ołtarz Przyjęcia” | wizualny szum | usunięty |
| toast „wystawał” spod dolnej krawędzi | pusty prostokąt w rogu | `opacity/visibility` |
| `details[open] summary::before` bez `>` | zagnieżdżone, zamknięte sekcje miały strzałkę „otwarte” | selektor dziecka |
| „Automatyczna analiza” schowana w sekcji Gemini | wyglądała na opcję tylko dla Gemini, a działa też z Ollamą | przeniesiona do sekcji silnika analizy |
| `browser_harness.html` czekał na N kart | po wprowadzeniu porcjowania (150) pomiar zawsze kończył się TIMEOUT | czeka na `min(N, 150)` |
| `start_engine.bat` aktualizował pip i pakiety przy każdym starcie | kilkanaście sekund + wymóg internetu | instalacja tylko po zmianie `requirements.txt` |
| status `error/cancelled` publikowany przed sprzątnięciem plików tymczasowych | 2 testy smoke (także w v3) losowo padały pod obciążeniem CPU | sprzątanie przed publikacją statusu; 8/8 przebiegów pod obciążeniem zielone |

## Testy

| Test | Wynik |
|---|---|
| `local-engine/smoke_test.py` | 28/28 (20 dawnych + 8 nowych: segmenty, filtr, pętle, `since`, drabinka OOM z wznowieniem, cool-down CPU, allowlista modeli, naprawa) |
| `tests/frontend_test.js` | PASS (+ korekta, zamiana, pewność segmentów, prognoza z pomiarów) |
| `tests/ux_structure_test.js` | PASS (+ status silnika, panel na żywo, zwinięte karty) |
| `tests/render_paging_test.js` | PASS |
| E2E Chromium z atrapą silnika v4 | 29/29 |
| E2E Chromium z **prawdziwym `server.py`** i atrapą modelu | 13/13 (na żywo, `?since`, filtr, naprawa, anulowanie) |
| Benchmark 5000 wpisów | do kart 2,7 s (v3: 3,1 s), scroll p95 17 ms (v3: 36,6 ms), długie klatki 0 (v3: 4) |

## Czego NIE sprawdzono (uczciwie)

Środowisko testowe nie miało dostępu do Hugging Face, więc **żaden test nie
uruchomił prawdziwego modelu Whisper**. Logika silnika jest przetestowana na
atrapach modelu, a argumenty `transcribe()` — na sygnaturze zainstalowanego
`faster-whisper 1.2.1`. Do potwierdzenia na Twojej maszynie:

1. długość segmentów po `ENGINE_FINE_SEGMENTS=1` na realnym nagraniu,
2. czy GPU utrzymuje się po zwolnieniu VRAM Ollamy (log: `phase=free_vram`),
3. czy filtr halucynacji nie wycina niczego prawdziwego (chip „✂” pokazuje
   wszystko, co usunięto; wyłączenie: `set ENGINE_HALLUCINATION_FILTER=0`).
