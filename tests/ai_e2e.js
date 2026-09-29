'use strict';
/**
 * FINAL CLOSURE PASS — realny E2E ścieżki AI na lokalnej Ollamie.
 *
 * Testuje PRODUKCYJNE artefakty:
 *   - prompty i schematy JSON wyciągane wprost z pliku HTML frontendu,
 *   - funkcje walidacji i scalania z skryptorium-core.js,
 *   - proxy Local Engine (/api/ollama/generate) albo bezpośrednio Ollamę.
 *
 * Uruchomienie:
 *   node tests\ai_e2e.js
 * Opcjonalne zmienne środowiskowe:
 *   OLLAMA_MODEL=qwen2.5:7b   ENGINE_URL=http://127.0.0.1:8765
 *   OLLAMA_URL=http://127.0.0.1:11434   SKIP_CLEAN=1   SKIP_ANALYSIS=1
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Core = require(path.join(ROOT, 'skryptorium-core.js'));
const { loadProductionArtifacts } = require('./extract_prompts.js');
const { buildEntry, TOPIC_SIZES, TOPIC_LABELS } = require('./fixture_wyklad.js');

const ENGINE_URL = (process.env.ENGINE_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const ENGINE_TOKEN = process.env.ENGINE_API_TOKEN || '';

const results = [];
const started = Date.now();
let transport = null;   // 'engine-proxy' | 'ollama-direct'
let MODEL = process.env.OLLAMA_MODEL || '';

function record(area, test, status, notes, extra) {
  results.push({ area, test, real: true, status, notes, ...(extra || {}) });
  const mark = { PASS: 'PASS', FAIL: 'FAIL', NOT_AVAILABLE: 'N/A ', OPTIONAL: 'OPT ' }[status] || status;
  console.log(`[${mark}] ${area} / ${test}${notes ? ' — ' + notes : ''}`);
}

function log(message) { console.log('       ' + message); }

async function jsonFetch(url, options = {}, timeoutMs = 900000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* zostaw surowy tekst */ }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- transport

async function detectTransport() {
  const headers = ENGINE_TOKEN ? { 'X-Skryptorium-Token': ENGINE_TOKEN } : {};
  try {
    const health = await jsonFetch(ENGINE_URL + '/api/ollama/health', { headers }, 8000);
    if (health.ok && health.data && health.data.ok === true) {
      transport = 'engine-proxy';
      const models = health.data.models || [];
      if (!MODEL) MODEL = health.data.defaultModel && models.includes(health.data.defaultModel)
        ? health.data.defaultModel : (models[0] || '');
      return { models, via: 'Local Engine proxy' };
    }
  } catch { /* spróbujemy bezpośrednio */ }
  try {
    const tags = await jsonFetch(OLLAMA_URL + '/api/tags', {}, 8000);
    if (tags.ok && tags.data && Array.isArray(tags.data.models)) {
      transport = 'ollama-direct';
      const models = tags.data.models.map(m => m.name);
      if (!MODEL) MODEL = models[0] || '';
      return { models, via: 'Ollama bezpośrednio (Local Engine nie odpowiada)' };
    }
  } catch { /* brak */ }
  return null;
}

/** Wywołanie modelu dokładnie tak, jak robi to produkcyjny callOllama/callGemini. */
async function generate(prompt, schema, timeoutMs = 900000) {
  if (transport === 'engine-proxy') {
    const headers = { 'Content-Type': 'application/json' };
    if (ENGINE_TOKEN) headers['X-Skryptorium-Token'] = ENGINE_TOKEN;
    const response = await jsonFetch(ENGINE_URL + '/api/ollama/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MODEL, prompt, expectsJson: !!schema, jsonSchema: schema || undefined }),
    }, timeoutMs);
    if (!response.ok) throw new Error(`proxy HTTP ${response.status}: ${(response.data && response.data.error) || response.text.slice(0, 200)}`);
    return String((response.data && response.data.response) || '');
  }
  const body = {
    model: MODEL, prompt, stream: false, keep_alive: '10m',
    options: { num_ctx: 8192, num_predict: 4096, temperature: 0.1 },
  };
  if (schema) body.format = schema;
  const response = await jsonFetch(OLLAMA_URL + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, timeoutMs);
  if (!response.ok) throw new Error(`ollama HTTP ${response.status}: ${response.text.slice(0, 200)}`);
  return String((response.data && response.data.response) || '');
}

/** Odpowiednik produkcyjnego callStructuredAnalysis: jedna próba naprawcza. */
async function structured(prompt, schema, timeoutMs) {
  let raw = await generate(prompt, schema, timeoutMs);
  try {
    return { raw, data: Core.parseStructuredJSON(raw, schema), repaired: false };
  } catch (firstError) {
    const repairPrompt = `${prompt}\n\nWAŻNE: poprzednia odpowiedź nie była poprawnym JSON. Zwróć ponownie wyłącznie kompletny, poprawny JSON zgodny ze schematem; bez komentarza i bez markdown.`;
    raw = await generate(repairPrompt, schema, timeoutMs);
    return { raw, data: Core.parseStructuredJSON(raw, schema), repaired: true, firstError: firstError.message };
  }
}

// ------------------------------------------------------- wzorzec referencyjny

/** Ręczny podział referencyjny: granice tematów przeliczone na indeksy chunków. */
function referenceBoundaries(chunks, entry) {
  const boundaries = [];
  let consumed = 0;
  for (const size of TOPIC_SIZES.slice(0, -1)) {
    consumed += size;
    const boundarySecond = entry.segments[consumed].start;
    const chunkIndex = chunks.findIndex(chunk => chunk.startTime >= boundarySecond);
    if (chunkIndex > 0) boundaries.push(chunkIndex);
  }
  return boundaries;
}

/** Granice modelu = indeks pierwszego chunku każdego rozdziału poza pierwszym. */
function modelBoundaries(chapters, chunks) {
  const order = new Map(chunks.map((chunk, index) => [chunk.chunkId, index]));
  return chapters.slice(1).map(chapter => order.get(chapter.chunkIds[0])).filter(value => value !== undefined);
}

// ------------------------------------------------------------------- testy

async function testSemanticChapters(artifacts) {
  const entry = buildEntry();
  const chunks = Core.buildSemanticChapterChunks(entry, 180);
  log(`fixture: ${entry.segments.length} segmentów, ${chunks.length} chunków, ${(entry.durationSec / 60).toFixed(0)} min`);

  const payload = chunks.map(chunk => ({ chunkId: chunk.chunkId, text: chunk.text }));
  const prompt = artifacts.SEMANTIC_CHAPTERS_PROMPT + JSON.stringify(payload);

  let response;
  const t0 = Date.now();
  try {
    response = await structured(prompt, artifacts.SEMANTIC_CHAPTERS_SCHEMA, 600000);
  } catch (error) {
    record('Real local AI', 'semantic chapters — odpowiedź modelu', 'FAIL', error.message);
    return { entry, chunks, chapters: null };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  record('Real local AI', 'semantic chapters — odpowiedź modelu', 'PASS',
    `${elapsed}s, ${response.repaired ? 'po naprawie JSON' : 'JSON za pierwszym razem'}`,
    { repaired: response.repaired, elapsedSec: Number(elapsed) });

  const validated = Core.validateSemanticChapterPlan(entry, chunks, response.data, {
    model: MODEL, promptVersion: artifacts.SEMANTIC_CHAPTERS_PROMPT_VERSION,
  });

  if (!validated.valid) {
    record('Real local AI', 'semantic chapters — walidacja planu', 'FAIL',
      `model zwrócił wadliwy podział: ${validated.error}`);
    const fallbackOk = Array.isArray(validated.chapters) && validated.chapters.length > 0
      && validated.chapters.every(chapter => chapter.mode !== 'semantic');
    record('Real local AI', 'semantic chapters — fallback strukturalny po realnym błędzie',
      fallbackOk ? 'PASS' : 'FAIL',
      fallbackOk ? `${validated.chapters.length} rozdziałów strukturalnych, wpis nie przechodzi w globalny error` : 'brak działającego fallbacku');
    return { entry, chunks, chapters: validated.chapters, modelPlanValid: false, validationError: validated.error };
  }

  const chapters = validated.chapters;
  log(`model zwrócił ${chapters.length} rozdziałów: ${chapters.map(c => c.title).join(' | ')}`);

  // --- twarde niezmienniki z sekcji 3.3 specyfikacji ---
  const flat = chapters.flatMap(chapter => chapter.chunkIds);
  const expected = chunks.map(chunk => chunk.chunkId);
  const checks = [
    ['pokrycie 100% chunków', flat.length === expected.length],
    ['brak zgubionego chunku', expected.every(id => flat.includes(id))],
    ['brak chunku użytego dwa razy', new Set(flat).size === flat.length],
    ['zachowana kolejność', flat.every((id, index) => id === expected[index])],
    ['tylko istniejące ID', flat.every(id => expected.includes(id))],
    ['brak timestampów od modelu', !JSON.stringify(response.data).match(/"(start|end|startTime|endTime)"/)],
    ['start/end wyliczone ze źródła', chapters.every(chapter => {
      const first = chunks.find(chunk => chunk.chunkId === chapter.chunkIds[0]);
      const last = chunks.find(chunk => chunk.chunkId === chapter.chunkIds[chapter.chunkIds.length - 1]);
      return chapter.startTime === first.startTime && chapter.endTime === last.endTime;
    })],
    ['sensowne tytuły (>=3 znaki, nie generyczne)', chapters.every(chapter =>
      chapter.title.length >= 3 && !/^Rozdział \d+$/.test(chapter.title))],
    ['sensowne streszczenia (>=20 znaków)', chapters.every(chapter => chapter.summary.length >= 20)],
    ['segmentIds prowadzą do realnych segmentów', chapters.every(chapter =>
      chapter.segmentIds.length > 0 && chapter.segmentIds.every(id => entry.segments.some(segment => segment.segmentId === id)))],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  record('Real local AI', 'semantic chapters — niezmienniki strukturalne',
    failed.length ? 'FAIL' : 'PASS',
    failed.length ? 'naruszone: ' + failed.join(', ') : `${checks.length}/${checks.length} niezmienników spełnionych`);

  // --- sekcja 4: porównanie z ręcznym podziałem referencyjnym ---
  const reference = referenceBoundaries(chunks, entry);
  const model = modelBoundaries(chapters, chunks);
  const hit = reference.filter(boundary => model.includes(boundary));
  const near = reference.filter(boundary => !model.includes(boundary) && model.some(m => Math.abs(m - boundary) === 1));
  const spurious = model.filter(boundary => !reference.some(r => Math.abs(r - boundary) <= 1));
  const tooGranular = chapters.length > TOPIC_SIZES.length * 2;
  const tooCoarse = chapters.length < 2;

  log(`granice referencyjne (indeksy chunków): [${reference.join(', ')}]`);
  log(`granice modelu:                        [${model.join(', ')}]`);
  log(`trafione dokładnie: ${hit.length}/${reference.length}, o jeden obok: ${near.length}, nadmiarowe: ${spurious.length}`);

  const qualityOk = (hit.length + near.length) >= Math.ceil(reference.length / 2) && !tooGranular && !tooCoarse;
  record('Real local AI', 'semantic chapters — zgodność z podziałem ręcznym',
    qualityOk ? 'PASS' : 'FAIL',
    `dokładnie ${hit.length}/${reference.length}, ±1 chunk ${near.length}, nadmiarowych ${spurious.length}, rozdziałów ${chapters.length} (oczekiwane ~${TOPIC_SIZES.length})`,
    {
      referenceBoundaries: reference, modelBoundaries: model,
      exactHits: hit.length, nearHits: near.length, spurious: spurious.length,
      chapterCount: chapters.length, expectedChapters: TOPIC_SIZES.length,
      referenceLabels: TOPIC_LABELS, modelTitles: chapters.map(c => c.title),
    });

  return { entry, chunks, chapters, modelPlanValid: true, rawResponse: response.raw };
}

/** Wadliwe plany od modelu MUSZĄ dawać fallback, nie wyjątek i nie globalny error. */
function testFallbackMatrix(entry, chunks) {
  const ids = chunks.map(chunk => chunk.chunkId);
  const cases = {
    'obce ID': [{ title: 'A', summary: 'x', chunkIds: ['nie-istnieje'] }],
    'zgubiony chunk': [{ title: 'A', summary: 'x', chunkIds: ids.slice(0, 2) }],
    'duplikat chunku': [{ title: 'A', summary: 'x', chunkIds: [...ids, ids[0]] }],
    'zła kolejność': [{ title: 'A', summary: 'x', chunkIds: [...ids].reverse() }],
    'nieciągła grupa': [
      { title: 'A', summary: 'x', chunkIds: [ids[0], ids[2]] },
      { title: 'B', summary: 'x', chunkIds: [ids[1], ...ids.slice(3)] },
    ],
    'pusta lista rozdziałów': [],
  };
  const broken = [];
  for (const [label, plan] of Object.entries(cases)) {
    let outcome;
    try {
      outcome = Core.validateSemanticChapterPlan(entry, chunks, { chapters: plan }, { model: MODEL });
    } catch (error) {
      broken.push(`${label}: wyjątek ${error.message}`);
      continue;
    }
    if (outcome.valid) { broken.push(`${label}: błędnie zaakceptowany`); continue; }
    if (!Array.isArray(outcome.chapters) || !outcome.chapters.length) { broken.push(`${label}: brak fallbacku`); continue; }
    if (outcome.chapters.some(chapter => chapter.mode === 'semantic')) broken.push(`${label}: fallback oznaczony jako semantic`);
  }
  record('Real local AI', 'semantic chapters — macierz wadliwych planów',
    broken.length ? 'FAIL' : 'PASS',
    broken.length ? broken.join('; ') : `${Object.keys(cases).length}/${Object.keys(cases).length} przypadków fallbackuje bezpiecznie`);
}

async function testAnalysisPipeline(artifacts, entry) {
  if (process.env.SKIP_ANALYSIS === '1') {
    record('Real local AI', 'MAP + REDUCE', 'NOT_AVAILABLE', 'pominięte przez SKIP_ANALYSIS=1');
    return;
  }
  // Najpierw dokładnie to, co zrobiłaby aplikacja: chunkEntry(9000, 450, 1).
  const productionChunks = Core.chunkEntry(entry, 9000, 450, 1);
  record('Real local AI', 'chunkowanie produkcyjne (chunkEntry 9000/450/1)', 'PASS',
    `${productionChunks.length} fragment(ów) dla materiału ${entry.transcript.length} znaków`
    + (productionChunks.length === 1 ? ' — aplikacja poszłaby ścieżką jednoprzebiegową' : ''));

  // Aby realnie wykonać MAP po wielu fragmentach ORAZ REDUCE, wymuszamy mniejszy
  // rozmiar fragmentu. To ta sama funkcja produkcyjna, tylko ciaśniej ustawiona.
  const chunks = productionChunks.length > 1 ? productionChunks : Core.chunkSegments(entry.segments, 1500, 1);
  log(`MAP: ${chunks.length} fragmentów${productionChunks.length > 1 ? ' (podział produkcyjny)' : ' (wymuszony podział 1500 zn., by objąć REDUCE)'}`);
  const partials = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const context = Core.buildChunkContext(entry, chunks[index], index, chunks.length);
    const prompt = artifacts.ANALYZE_PROMPT + context + '\n' + (chunks[index].text || chunks[index]) + '\n"""';
    try {
      const t0 = Date.now();
      const response = await structured(prompt, artifacts.ANALYSIS_JSON_SCHEMA, 900000);
      partials.push(response.data);
      log(`  MAP ${index + 1}/${chunks.length} OK w ${((Date.now() - t0) / 1000).toFixed(1)}s${response.repaired ? ' (po naprawie)' : ''}`);
    } catch (error) {
      record('Real local AI', `MAP fragment ${index + 1}/${chunks.length}`, 'FAIL', error.message);
      return;
    }
  }
  record('Real local AI', 'MAP — wszystkie fragmenty zgodne ze schematem', 'PASS',
    `${partials.length}/${chunks.length} fragmentów, walidacja ANALYSIS_JSON_SCHEMA`);

  const merged = Core.mergeAnalyses(partials);
  const mergeOk = merged && Array.isArray(merged.theses) && Array.isArray(merged.concepts);
  record('Real local AI', 'mergeAnalyses — deterministyczne scalenie', mergeOk ? 'PASS' : 'FAIL',
    mergeOk ? `tez ${merged.theses.length}, pojęć ${merged.concepts.length}, metod ${(merged.methods || []).length}, rekomendacji ${(merged.recommendations || []).length}` : 'scalenie zwróciło nieoczekiwany kształt');

  if (partials.length < 2) {
    record('Real local AI', 'REDUCE', 'NOT_AVAILABLE', 'materiał zmieścił się w jednym fragmencie, REDUCE nie jest wywoływany');
    return;
  }
  try {
    const compact = partials.map((partial, index) => ({ fragment: index + 1, ...partial }));
    const t0 = Date.now();
    const response = await structured(artifacts.REDUCE_PROMPT + JSON.stringify(compact) + '\n"""', artifacts.REDUCE_JSON_SCHEMA, 900000);
    const summary = String(response.data.summary || '');
    record('Real local AI', 'REDUCE — synteza całości', summary.length >= 40 ? 'PASS' : 'FAIL',
      `${((Date.now() - t0) / 1000).toFixed(1)}s, streszczenie ${summary.length} znaków${response.repaired ? ', po naprawie JSON' : ''}`);
  } catch (error) {
    record('Real local AI', 'REDUCE — synteza całości', 'FAIL', error.message);
  }
}

async function testCleanupGuard(artifacts, entry) {
  if (process.env.SKIP_CLEAN === '1') {
    record('Real local AI', 'guard czyszczenia transkryptu', 'NOT_AVAILABLE', 'pominięte przez SKIP_CLEAN=1');
    return;
  }
  // Fragment z liczbami i datami — dokładnie to, co model najczęściej gubi.
  const source = entry.segments.slice(8, 16).map(segment => segment.text).join(' ');
  try {
    const raw = await generate(artifacts.CLEAN_PROMPT + source + '\n"""', null, 600000);
    const verdict = Core.validateCleanup(source, raw);
    log(`wejście ${verdict.inputLength} zn., wyjście ${verdict.outputLength} zn., ratio ${verdict.ratio.toFixed(2)}`);
    if (verdict.reasons.length) log(`powody odrzucenia: ${verdict.reasons.join(', ')}`);
    record('Real local AI', 'guard czyszczenia transkryptu — realna decyzja',
      'PASS',
      verdict.accepted
        ? `model zachował treść (ratio ${verdict.ratio.toFixed(2)}), guard zaakceptował`
        : `guard ODRZUCIŁ wynik modelu (${verdict.reasons.join(', ')}) i zachowa surowy transkrypt — to zachowanie oczekiwane`,
      { accepted: verdict.accepted, ratio: Number(verdict.ratio.toFixed(3)), reasons: verdict.reasons });
  } catch (error) {
    record('Real local AI', 'guard czyszczenia transkryptu — realna decyzja', 'FAIL', error.message);
  }
}

async function testRetryAndCancel() {
  let attempts = 0;
  try {
    await Core.withRetry(async () => {
      attempts += 1;
      if (attempts < 3) { const error = new Error('HTTP 503'); error.status = 503; throw error; }
      return 'ok';
    }, { attempts: 4, baseDelayMs: 5, jitterMs: 0 });
    record('Real local AI', 'withRetry — ponawianie błędów przejściowych', attempts === 3 ? 'PASS' : 'FAIL',
      `powodzenie po ${attempts} próbach`);
  } catch (error) {
    record('Real local AI', 'withRetry — ponawianie błędów przejściowych', 'FAIL', error.message);
  }

  const controller = new AbortController();
  controller.abort();
  try {
    await Core.withRetry(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
      { attempts: 3, baseDelayMs: 5, jitterMs: 0, signal: controller.signal });
    record('Real local AI', 'withRetry — anulowanie nie jest ponawiane', 'FAIL', 'operacja nie została przerwana');
  } catch (error) {
    record('Real local AI', 'withRetry — anulowanie nie jest ponawiane',
      Core.isAbortError(error) ? 'PASS' : 'FAIL', Core.isAbortError(error) ? 'abort rozpoznany i nie ponawiany' : error.message);
  }
}

// -------------------------------------------------------------------- main

async function main() {
  console.log('='.repeat(72));
  console.log('SKRYPTORIUM — FINAL CLOSURE PASS: realny E2E ścieżki AI');
  console.log('='.repeat(72));

  let artifacts;
  try {
    artifacts = loadProductionArtifacts(ROOT);
    record('Core', 'ekstrakcja produkcyjnych promptów i schematów', 'PASS',
      `z ${artifacts.frontendFile}; wersja promptu ${artifacts.SEMANTIC_CHAPTERS_PROMPT_VERSION}`);
  } catch (error) {
    record('Core', 'ekstrakcja produkcyjnych promptów i schematów', 'FAIL', error.message);
    finish();
    return;
  }

  const detected = await detectTransport();
  if (!detected || !MODEL) {
    record('Real local AI', 'wykrycie Ollamy', 'NOT_AVAILABLE',
      'nie odpowiada ani Local Engine (8765), ani Ollama (11434) — uruchom start_engine.bat oraz ollama serve');
    finish();
    return;
  }
  record('Real local AI', 'wykrycie Ollamy', 'PASS', `${detected.via}; model=${MODEL}; dostępne: ${detected.models.join(', ') || 'brak listy'}`);

  const chapterRun = await testSemanticChapters(artifacts);
  if (chapterRun.chunks) testFallbackMatrix(chapterRun.entry, chapterRun.chunks);
  await testRetryAndCancel();
  await testCleanupGuard(artifacts, chapterRun.entry);
  await testAnalysisPipeline(artifacts, chapterRun.entry);

  finish(chapterRun);
}

function finish(chapterRun) {
  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - started) / 10) / 100,
    transport, model: MODEL,
    node: process.version,
    counts: results.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
    results,
    modelChapterTitles: chapterRun && chapterRun.chapters ? chapterRun.chapters.map(c => ({
      title: c.title, summary: c.summary, startTime: c.startTime, endTime: c.endTime, chunkIds: c.chunkIds,
    })) : null,
  };
  const outFile = path.join(__dirname, 'RESULTS_ai.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log('-'.repeat(72));
  console.log(`Podsumowanie: ${JSON.stringify(summary.counts)} w ${summary.elapsedSec}s`);
  console.log(`Zapisano: ${outFile}`);
  const failed = results.filter(item => item.status === 'FAIL').length;
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error('BŁĄD KRYTYCZNY RUNNERA:', error);
  record('Runner', 'wykonanie', 'FAIL', error.message);
  finish();
});
