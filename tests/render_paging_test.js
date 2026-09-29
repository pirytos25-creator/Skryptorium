'use strict';
/**
 * Test regresyjny porcjowania renderowania kart (poprawka po pomiarze DOM).
 *
 * Powód powstania: realny pomiar w przeglądarce (RESULTS_browser.json) pokazał,
 * że pełne renderowanie archiwum kosztuje 8,9 s przy 1000 wpisach, 66,7 s przy
 * 2500 i 218,2 s przy 5000. Wąskim gardłem jest wyłącznie budowa DOM — obliczenia
 * w core przy 5000 wpisach mieszczą się w ~177 ms.
 *
 * Test sprawdza logikę porcjowania wyciętą 1:1 z `render()` w pliku aplikacji,
 * w tym najgroźniejszy przypadek: skok do wpisu spoza bieżącej porcji.
 *
 * Uruchomienie:  node tests\render_paging_test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// --- 1. Kontrola, że aplikacja faktycznie zawiera poprawkę --------------------

function frontendSource() {
  const candidates = fs.readdirSync(ROOT)
    .filter(name => name === 'index.html')
    .sort((a, b) => fs.statSync(path.join(ROOT, b)).mtimeMs - fs.statSync(path.join(ROOT, a)).mtimeMs);
  assert.ok(candidates.length, 'nie znaleziono pliku HTML aplikacji');
  return fs.readFileSync(path.join(ROOT, candidates[0]), 'utf8');
}

const source = frontendSource();
const pageSizeMatch = source.match(/const RENDER_PAGE_SIZE = (\d+);/);
assert.ok(pageSizeMatch, 'brak stałej RENDER_PAGE_SIZE — poprawka porcjowania zniknęła z aplikacji');
const PAGE = Number(pageSizeMatch[1]);
assert.ok(PAGE > 0 && PAGE <= 500, `RENDER_PAGE_SIZE poza sensownym zakresem: ${PAGE}`);

assert.ok(/function ensureEntryRendered/.test(source),
  'brak ensureEntryRendered — skok do wpisu spoza porcji przestałby działać');
assert.ok(/ensureEntryRendered\(entryId\);[\s\S]{0,200}?seekToEntry|async function seekToEntry[\s\S]{0,400}?ensureEntryRendered/.test(source),
  'seekToEntry nie wywołuje ensureEntryRendered');
assert.ok(/ensureEntryRendered\(open\.dataset\.openEntry\)/.test(source),
  'przejście z widoku przekrojowego nie dorenderowuje wpisu');
assert.ok(/renderMoreFooter/.test(source), 'brak stopki „Pokaż więcej”');

// --- 2. Logika porcjowania (odwzorowanie fragmentu render()) ------------------

function makeRenderer(total) {
  const entries = Array.from({ length: total }, (_, index) => ({ id: `e${index}` }));
  let renderedLimit = PAGE;
  let domIds = [];
  const api = {
    render() {
      renderedLimit = Math.max(PAGE, Math.min(renderedLimit, entries.length));
      domIds = entries.slice(0, renderedLimit).map(entry => entry.id);
      return domIds;
    },
    ensureEntryRendered(entryId) {
      if (domIds.includes(entryId)) return true;
      const index = entries.findIndex(entry => entry.id === entryId);
      if (index === -1) return false;
      renderedLimit = Math.max(renderedLimit, index + 1);
      api.render();
      return domIds.includes(entryId);
    },
    more() { renderedLimit += PAGE; return api.render(); },
    all() { renderedLimit = entries.length; return api.render(); },
    get limit() { return renderedLimit; },
    get remaining() { return Math.max(0, entries.length - renderedLimit); },
  };
  return api;
}

// Małe archiwum renderuje się w całości i nie pokazuje stopki.
{
  const r = makeRenderer(20);
  assert.equal(r.render().length, 20, 'małe archiwum musi renderować się w całości');
  assert.equal(r.remaining, 0, 'przy małym archiwum nie ma czego dopokazywać');
}

// Duże archiwum renderuje tylko pierwszą porcję.
{
  const r = makeRenderer(5000);
  assert.equal(r.render().length, PAGE, `pierwszy render musi ograniczyć się do ${PAGE} kart`);
  assert.equal(r.remaining, 5000 - PAGE);
  assert.equal(r.more().length, PAGE * 2, '„Pokaż więcej” musi dołożyć dokładnie jedną porcję');
  assert.equal(r.all().length, 5000, '„Pokaż wszystkie” musi wyrenderować całość');
}

// Skok do wpisu spoza porcji — najważniejszy przypadek regresji.
{
  const r = makeRenderer(5000);
  r.render();
  assert.ok(!r.render().includes('e4999'), 'ostatni wpis nie powinien być w pierwszej porcji');
  assert.equal(r.ensureEntryRendered('e4999'), true, 'skok do odległego wpisu musi go dorenderować');
  assert.ok(r.render().includes('e4999'), 'po skoku wpis musi być w DOM');
  assert.equal(r.ensureEntryRendered('nie-istnieje'), false, 'nieznane id nie może udawać sukcesu');
}

// Limit nigdy nie schodzi poniżej porcji ani nie przekracza liczby wpisów.
{
  const r = makeRenderer(5000);
  r.all();
  const shrunk = makeRenderer(10);
  assert.equal(shrunk.render().length, 10, 'limit nie może wyjść poza liczbę wpisów');
  assert.ok(r.limit <= 5000);
}

// Kolejność renderowania musi odpowiadać kolejności w archiwum.
{
  const r = makeRenderer(400);
  const ids = r.render();
  assert.deepEqual(ids.slice(0, 3), ['e0', 'e1', 'e2'], 'kolejność wpisów musi być zachowana');
}

console.log(`Porcjowanie renderowania: wszystkie testy przeszły (RENDER_PAGE_SIZE=${PAGE}).`);
