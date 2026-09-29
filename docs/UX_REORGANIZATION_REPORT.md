# Skryptorium Głosów — raport reorganizacji UX

Data: 2026-08-13
Zakres: wyłącznie architektura informacji i układ. Zero zmian w backendzie,
pipeline AI, schemacie danych i logice biznesowej.

---

## 1. Problem przed zmianą

Aplikacja była **jedną ciągłą stroną** z pięcioma blokami ułożonymi pionowo:
nagłówek → upload → konfiguracja → nawigacja po archiwum → lista wpisów.

Policzone na ekranie startowym, przed jakąkolwiek interakcją:

| Blok | Kontrolek zawsze widocznych |
|---|---|
| Ołtarz Przyjęcia | 1 |
| Konfiguracja Skryby | 9 |
| Nawigacja po Archiwum | 14 |
| **Razem** | **24** |

Trzy konsekwencje:

1. **Treść produktu była najniżej.** Między „wrzuć plik" a „zobacz swoje wpisy"
   leżały dwa pełne ekrany ustawień i filtrów.
2. **Trzy tryby myślenia na jednym ekranie.** Token API i wybór akceleracji
   WebGPU sąsiadowały z polem wyszukiwania i listą nagrań.
3. **Analityka przekrojowa zawsze włączona.** TF-IDF, trendy i współwystępowanie
   renderowały się niezależnie od tego, czy ktoś ich potrzebował.

---

## 2. Nowa architektura informacji

Trzy konteksty w nawigacji + wyszukiwarka poza zakładkami.

```
SKRYPTORIUM GŁOSÓW
[ Praca ] [ Archiwum ] [ Ustawienia ]          [ 🔍 szukaj w archiwum ]

Praca (domyślny)              Archiwum                    Ustawienia
├ Ołtarz Przyjęcia            ├ Wyszukiwanie              ├ Transkrypcja
│  └ Słownik domenowy ▾       │  └ Filtry szczegółowe ▾   ├ Analiza AI
├ Status i kolejka            ├ Wyniki                    └ Diagnostyka
└ Codex Głosów                └ Analiza przekrojowa ▾
```

Uzasadnienie liczby kontekstów: dwa zmusiłyby do wciśnięcia konfiguracji
technicznej w jeden z pozostałych — a to ona najbardziej zaśmiecała ekran.
Cztery lub więcej oznaczałoby zakładkę na funkcję. Trzy odpowiadają trzem
realnym trybom pracy: *przetwarzam materiał*, *szukam w tym, co mam*,
*konfiguruję narzędzie*.

---

## 3. Co przeniesiono

| Element | Z | Do |
|---|---|---|
| Silnik transkrypcji, model, język, akceleracja | ekran główny | Ustawienia |
| Token Local Engine | ekran główny | Ustawienia |
| Panel diagnostyczny silnika + instrukcje | ekran główny | Ustawienia |
| Ollama, Gemini, klucz API, modele | ekran główny (zwinięte) | Ustawienia |
| Auto-analiza, czyszczenie przez LLM | ekran główny | Ustawienia |
| Wyszukiwanie globalne | środek strony | nagłówek, dostępne z każdego widoku |
| Osiem filtrów szczegółowych | zawsze rozwinięte | zwijany blok w Archiwum |
| Agregacja, TF-IDF, trendy, współwystępowanie | zawsze widoczne | zwijany blok w Archiwum |
| Eksport korpusowy (CSV ZIP, XLSX) | ekran główny | Archiwum |

---

## 4. Co celowo zostało na ekranie głównym

**Ołtarz Przyjęcia** — jedyny duży element. To jest pierwsza czynność w każdej sesji.

**Słownik domenowy** (profil przetwarzania + kontekst/nazwy własne + hotwords) —
zwinięty, ale bezpośrednio pod Ołtarzem. Uzasadnienie jest pomiarowe, nie
estetyczne: finalne testy wykazały **różnicowy** wpływ hotwords na wynik
transkrypcji — ten sam plik, ta sama konfiguracja, bez podpowiedzi model pisał
`ConfUI`, z podpowiedzią `ComfyUI`. Przeniesienie do Ustawień oznaczałoby, że
nikt tego nie użyje. Nagłówek bloku pokazuje stan (`· Zrównoważony · słownik
uzupełniony`), więc widać, że coś jest ustawione, bez rozwijania.

**Status i kolejka** — pod Ołtarzem, mają wartość wyłącznie w trakcie pracy.

**Codex Głosów** — lista wpisów, teraz bezpośrednio pod uploadem zamiast dwa
ekrany niżej.

---

## 5. Co schowano za kontekstem lub zwinięciem

| Schowane | Gdzie | Kliknięć |
|---|---|---|
| Konfiguracja techniczna | zakładka Ustawienia | 1 |
| Słownik domenowy | zwijany blok przy Ołtarzu | 1 |
| Filtry szczegółowe | zwijany blok w Archiwum | 2 |
| Analiza przekrojowa | zwijany blok w Archiwum | 2 |
| Klucz Gemini, model Ollamy | zwijane bloki w Ustawieniach | 2 |

**Nic nie zostało usunięte.** Każda funkcja jest o jedno lub dwa kliknięcia
dalej, w miejscu odpowiadającym intencji użytkownika.

---

## 6. Zachowane optymalizacje

Wszystkie potwierdzone testami po zmianie:

- porcjowanie renderowania kart (`RENDER_PAGE_SIZE = 150`) wraz z `ensureEntryRendered()`,
- debounce wyszukiwania 160 ms,
- cache indeksu wyszukiwania i wyników analitycznych,
- lazy loading audio, batching timeline,
- porcjowanie przycisków źródłowych po 60.

Przełączanie widoków **pokazuje i ukrywa** kontenery — nie przebudowuje DOM
wpisów. Zmiana zakładki nie kosztuje ponownego renderowania listy.

---

## 7. Metoda implementacji i ryzyko

Węzły DOM zostały **przeniesione**, nie przepisane. Wszystkie identyfikatory
elementów pozostały nietknięte, więc żadne istniejące bindowanie JS nie
wymagało zmiany. Zweryfikowane: 19 kluczowych `id` obecnych dokładnie raz.

Dodany kod: nawigacja (`setView`, `bindMainNav`), przepisywanie frazy
z wyszukiwarki nagłówkowej do pola archiwum, podsumowanie stanu słownika.
Zapamiętanie ostatniego widoku w `localStorage`.

---

## 8. Regresja testów

| Test | Wynik |
|---|---|
| Składnia modułu aplikacji (`node --check`) | PASS |
| Składnia `skryptorium-core.js` | PASS |
| Bilans znaczników HTML (div/section/details/nav/label) | PASS |
| Zmienne CSS — wszystkie zdefiniowane | PASS |
| `frontend_test.js` | PASS |
| `render_paging_test.js` | PASS |
| `ux_structure_test.js` (nowy) | PASS |
| Backend smoke suite | PASS — 20/20 |

Nowy test `tests/ux_structure_test.js` pilnuje, żeby kolejna zmiana
nie cofnęła reorganizacji: sprawdza liczbę kontrolek na ekranie startowym,
obecność słownika domenowego w widoku Praca, konfiguracji w Ustawieniach oraz
zachowanie porcjowania i debounce'u.

---

## 9. Błędy znalezione przy okazji

**Nieistniejąca zmienna CSS `--border-gold`** — mój błąd, wprowadzony w tej
rundzie przy stylowaniu aktywnej zakładki. Zamieniono na istniejące
`--border-soft`.

**Nieistniejąca zmienna CSS `--lilac`** — błąd **wcześniejszy**, nie z tej rundy.
Używana w `.timeline-speaker` (etykieta mówcy w osi czasu), nigdy nie
zdefiniowana, więc kolor cicho spadał do wartości dziedziczonej. Dodano
definicję. Zweryfikowano, że po zmianie żadna zmienna CSS nie jest już
nieokreślona.

---

## 10. Struktura finalna — pomiar

| | Przed | Po |
|---|---|---|
| Kontrolek widocznych od razu | 24 | **2** |
| Przewinięć do listy wpisów | 2 pełne ekrany | **0** |
| Kliknięć do hotwords | 0, ale w ścianie 9 pól | 1, w opisanym bloku |
| Kliknięć do ustawień technicznych | 0, zawsze na ekranie | 1 |
| Kliknięć do analityki archiwum | 0, zawsze liczona | 2 |
| Kontekstów pracy | 1 (wszystko naraz) | 3 |

Weryfikacja scenariuszy ze specyfikacji:

- **„Mam nowe nagranie"** — Ołtarz jest pierwszym i największym elementem;
  status i kolejka pojawiają się pod nim; wynik trafia na listę bezpośrednio niżej.
- **„Chcę przeczytać transkrypt"** — wpisy są tuż pod uploadem, bez przebijania
  się przez statystyki.
- **„Chcę znaleźć coś sprzed pół roku"** — pole w nagłówku, z każdego widoku,
  `Ctrl+F` przełącza na Archiwum i ustawia focus.
- **„Chcę zobaczyć trendy"** — Archiwum → rozwinięcie „Analiza przekrojowa";
  świadome wejście w tryb.
- **„Chcę zmienić model / hotwords"** — model w Ustawieniach, hotwords przy
  Ołtarzu, zgodnie z częstością zmiany.

---

## 11. Znane kompromisy

**Wyszukiwarka istnieje w dwóch miejscach.** Pole w nagłówku (`#navSearch`)
przepisuje frazę do pola w Archiwum (`#globalSearch`) i przełącza widok.
Rozważałam jedno pole przenoszone między kontekstami — byłoby czystsze
strukturalnie, ale wymagałoby ruszania logiki wyszukiwania. Dwa pola
zsynchronizowane w jedną stronę są bezpieczniejsze przy zerowej zmianie logiki.

**Analityka przekrojowa jest dwa kliknięcia od startu.** Świadome — to
najrzadziej używana grupa funkcji. Jeśli okaże się używana częściej, wystarczy
zmienić `<details>` na domyślnie otwarty.

**Nie testowano w realnej przeglądarce.** Weryfikacja opierała się na parserze
DOM, bilansie znaczników, kontroli zmiennych CSS i testach automatycznych.
Sprawdzenie na 1366×768 i wąskim oknie desktopowym pozostaje do wykonania —
dodano media query dla ≤720 px, ale nie widziano go w działaniu.

**Widok pojedynczego wpisu został nietknięty.** Specyfikacja dopuszczała jego
reorganizację (sekcje 8–11), ale wpis ma już własne zakładki
(Transkrypt / Timeline / Analiza / Rozdziały / Wiedza / Mapa), więc problem
przeciążenia go nie dotyczył. Zmiana tam byłaby redesignem dla samego
redesignu — a to specyfikacja odradzała.

---

## 12. Czego nie zmieniono

Charakter aplikacji został nienaruszony: „Ołtarz Przyjęcia", „Codex Głosów",
„Konfiguracja Skryby", sigile wpisów, typografia Cinzel i EB Garamond, granatowo-
złota paleta. Reorganizacja dotyczyła struktury, nie osobowości.

Backend, kontrakt API, schemat IndexedDB, pipeline AI i konfiguracja
faster-whisper — bez jednej zmiany.
