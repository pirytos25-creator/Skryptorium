'use strict';

const Core = require('../skryptorium-core.js');

function buildEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${index}`,
    title: `Spotkanie konsultacyjne ${index}`,
    speaker: index % 3 === 0 ? 'Anna' : index % 3 === 1 ? 'Piotr' : 'Maria',
    event: index % 2 === 0 ? 'Forum' : 'Kongres',
    sessionType: index % 4 === 0 ? 'panel' : 'wykład',
    createdAt: `2026-${String((index % 12) + 1).padStart(2, '0')}-01T10:00:00Z`,
    analysisStatus: index % 5 === 0 ? 'not_analyzed' : 'done',
    hasAudio: index % 4 !== 0,
    model: index % 2 === 0 ? 'turbo' : 'import',
    tags: ['dialog', `region-${index % 10}`],
    transcriptRaw: `Dialog społeczny i konsultacje mieszkańców. Metoda warsztatowa numer ${index}. Informacja zwrotna oraz rekomendacja dla samorządu.`,
    transcript: `Dialog społeczny i konsultacje mieszkańców. Metoda warsztatowa numer ${index}. Informacja zwrotna oraz rekomendacja dla samorządu.`,
    summary: `Podsumowanie konsultacji numer ${index}.`,
    concepts: [{ term: 'Dialog społeczny', definition: 'Dwustronna komunikacja.' }],
    methods: [{ name: 'Warsztat', description: 'Wspólna praca.' }],
    theses: ['Informacja zwrotna buduje zaufanie.'],
    recommendations: ['Publikować odpowiedzi po konsultacjach.'],
    segments: [{ start: 0, end: 15, text: `Dialog i konsultacje numer ${index}.` }],
  }));
}

function measure(fn) {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(count) {
  const entries = buildEntries(count);
  const samples = { index: [], search: [], filter: [], tfidf: [], aggregate: [] };
  for (let run = 0; run < 3; run++) {
    const indexed = measure(() => Core.buildSearchIndex(entries));
    samples.index.push(indexed.ms);
    samples.search.push(measure(() => Core.searchArchive(indexed.value, 'informacja zwrotna', {})).ms);
    samples.filter.push(measure(() => Core.searchArchive(indexed.value, '', { speaker: 'Anna', event: 'Forum', tags: ['dialog'], hasAnalysis: true })).ms);
    samples.tfidf.push(measure(() => Core.computeTfIdf(entries, 12)).ms);
    samples.aggregate.push(measure(() => Core.aggregateArchive(entries)).ms);
  }
  return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, Number(median(values).toFixed(2))]));
}

const results = [1000, 2500, 5000].map(entries => ({ entries, ...benchmark(entries) }));
console.log(JSON.stringify({ runtime: process.version, runs: 3, statistic: 'median', results }, null, 2));
