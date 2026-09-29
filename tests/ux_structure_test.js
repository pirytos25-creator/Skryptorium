'use strict';
/**
 * Test regresyjny architektury informacji (runda UX).
 *
 * Pilnuje trzech rzeczy, które łatwo cofnąć przypadkiem przy kolejnej zmianie:
 *   1. ekran startowy nie może znów spuchnąć do ściany kontrolek,
 *   2. hotwords i initial_prompt muszą zostać przy Ołtarzu (mają zmierzony
 *      wpływ na jakość transkrypcji), a nie wylądować w Ustawieniach,
 *   3. porcjowanie renderowania kart musi przetrwać każdy redesign.
 *
 * Uruchomienie:  node tests\ux_structure_test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const file = fs.readdirSync(ROOT)
  .filter(name => name === 'index.html')
  .sort((a, b) => fs.statSync(path.join(ROOT, b)).mtimeMs - fs.statSync(path.join(ROOT, a)).mtimeMs)[0];
assert.ok(file, 'nie znaleziono pliku aplikacji');
const src = fs.readFileSync(path.join(ROOT, file), 'utf8');

const body = src.slice(src.indexOf('<body>'), src.indexOf('<script src="skryptorium-core'));

// --- 1. Trzy konteksty, dokładnie jeden aktywny na starcie ---
const panels = [...body.matchAll(/data-view-panel="(\w+)"/g)].map(m => m[1]);
assert.deepEqual(panels, ['work', 'archive', 'settings'], `oczekiwano trzech widoków, jest: ${panels}`);
const activeViews = [...body.matchAll(/class="view active" data-view-panel="(\w+)"/g)];
assert.equal(activeViews.length, 1, 'dokładnie jeden widok może być aktywny na starcie');
assert.equal(activeViews[0][1], 'work', 'widokiem startowym musi być Praca');

const tabs = [...body.matchAll(/class="nav-tab[^"]*" data-view="(\w+)"/g)].map(m => m[1]);
assert.deepEqual(tabs, ['work', 'archive', 'settings'], 'zakładki muszą odpowiadać widokom');

// --- 2. Wyszukiwarka dostępna z każdego kontekstu ---
assert.ok(/<nav class="main-nav"/.test(body), 'brak nawigacji głównej');
assert.ok(/id="navSearch"/.test(body), 'wyszukiwarka musi być w nagłówku, poza zakładkami');
assert.ok(/setView\('archive'\);\s*\$\('#globalSearch'\)\?\.focus\(\)/.test(src),
  'Ctrl+F musi przełączać na Archiwum i ustawiać focus w wyszukiwarce');

// --- 3. Ekran startowy pozostaje pusty ---
function sliceView(name) {
  const start = body.indexOf(`data-view-panel="${name}"`);
  const next = panels
    .map(p => body.indexOf(`data-view-panel="${p}"`))
    .filter(index => index > start)
    .sort((a, b) => a - b)[0];
  return body.slice(start, next === undefined ? body.length : next);
}

const work = sliceView('work');
// Kontrolki poza blokami <details> — to jest to, co użytkownik widzi od razu.
const workWithoutDetails = work.replace(/<details[\s\S]*?<\/details>/g, '');
const visibleControls = (workWithoutDetails.match(/<(input|select|textarea)\b/g) || []).length;
assert.ok(visibleControls <= 2,
  `ekran startowy ma ${visibleControls} kontrolek poza zwijanymi blokami — limit to 2 (upload)`);

// --- 4. Słownik domenowy przy Ołtarzu, nie w Ustawieniach ---
for (const id of ['processingProfileSelect', 'initialPromptInput', 'hotwordsInput']) {
  assert.ok(work.includes(`id="${id}"`),
    `${id} musi zostać w widoku Praca — ma zmierzony wpływ na jakość transkrypcji`);
}
assert.ok(/id="domainDict"/.test(work), 'brak zwijanego bloku „Słownik domenowy”');
assert.ok(/id="domainSummary"/.test(work), 'brak podsumowania stanu słownika w nagłówku bloku');

// --- 5. Konfiguracja techniczna poza ścieżką codziennej pracy ---
const settings = sliceView('settings');
for (const id of ['engineSelect', 'modelSelect', 'langSelect', 'deviceSelect',
                  'localTokenInput', 'apiKeyInput', 'ollamaModelInput', 'geminiModelSelect']) {
  assert.ok(settings.includes(`id="${id}"`), `${id} powinno być w Ustawieniach`);
}

// --- 6. Archiwum: szukanie widoczne, filtry i analityka zwinięte ---
const archive = sliceView('archive');
assert.ok(archive.includes('id="globalSearch"'), 'pole wyszukiwania musi być w Archiwum');
const archiveDetails = archive.match(/<summary>([^<]+)</g) || [];
assert.ok(archiveDetails.length >= 2, 'filtry i analityka przekrojowa mają być zwijane');
const filtersBlock = archive.slice(archive.indexOf('Filtry szczegółowe'));
assert.ok(filtersBlock.includes('id="filterSpeaker"'), 'filtry szczegółowe muszą być w zwijanym bloku');

// --- 7. Zachowane optymalizacje wydajności ---
assert.ok(/const RENDER_PAGE_SIZE = \d+;/.test(src), 'redesign nie może cofnąć porcjowania kart');
assert.ok(/function ensureEntryRendered/.test(src), 'redesign nie może usunąć ensureEntryRendered');
assert.ok(/archiveSearchTimer = setTimeout\(runArchiveSearch, 160\)/.test(src),
  'debounce wyszukiwania musi zostać');

// --- 8. Runda 4: status silnika i transkrypcja na żywo ---
const navBlock = body.slice(body.indexOf('<nav class="main-nav"'), body.indexOf('</nav>'));
assert.ok(navBlock.includes('id="enginePill"'), 'status silnika musi być widoczny w nawigacji, z każdego widoku');
assert.ok(work.includes('id="livePanel"') && /id="livePanel" hidden/.test(work), 'panel na żywo jest w Pracy i domyślnie ukryty');
assert.ok(/id="liveFeed"/.test(work), 'panel na żywo pokazuje tekst przyrostowo');
assert.ok(/since=\$\{task\.liveSegments\.length\}/.test(src), 'polling musi pobierać tylko nowe segmenty');
assert.ok(work.includes('id="preprocessCheck"'), 'wzmocnienie trudnego audio przy Ołtarzu (per nagranie)');
assert.ok(settings.includes('id="localModelSelect"'), 'wybór modelu silnika w Ustawieniach');
assert.ok(/const expandedEntries = new Set\(\)/.test(src), 'karty zwinięte domyślnie (leniwe renderowanie wnętrza)');
assert.ok(/data-seg-edit=/.test(src) && /function bindReplaceBar/.test(src), 'korekta: edycja segmentów i „Popraw nazwę”');
assert.ok(/<label class="altar"[^>]*>/.test(work) && /\.altar \{ display: block;/.test(src), 'Ołtarz jest blokiem (label domyślnie inline)');
assert.equal((work.match(/Ołtarz Przyjęcia<\/div>/g) || []).length, 1, 'tytuł Ołtarza występuje raz');

console.log(`Architektura informacji: wszystkie testy przeszły `
  + `(3 widoki, ${visibleControls} kontrolek na ekranie startowym).`);
