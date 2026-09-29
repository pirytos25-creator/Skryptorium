'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const Core = require(path.join(ROOT, 'skryptorium-core.js'));

async function run() {
  assert.deepEqual(Core.parseAIJSON('{"ok":true}'), { ok: true });
  assert.deepEqual(Core.parseAIJSON('```json\n{"ok":true,}\n```'), { ok: true });
  assert.deepEqual(Core.parseAIJSON('tekst przed {"ok":true} tekst po'), { ok: true });
  assert.deepEqual(Core.parseAIJSON('Komentarz {"text":"klamra } w tekście"} koniec'), { text: 'klamra } w tekście' });
  assert.deepEqual(Core.parseAIJSON('{"text":"cytat \\\"wewnątrz\\\""}'), { text: 'cytat "wewnątrz"' });
  assert.throws(() => Core.parseAIJSON('{"broken":'), /poprawnego/);
  assert.throws(() => Core.parseAIJSON(''), /poprawnego/);
  assert.throws(() => Core.parseAIJSON('[1,2,3]'), /obiektu/);

  const strictSchema = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'string' } } },
    required: ['ok', 'items'],
  };
  assert.equal(Core.validateJSONSchema({ ok: true, items: ['a'] }, strictSchema).ok, true);
  assert.equal(Core.validateJSONSchema({ ok: 'tak', items: [] }, strictSchema).ok, false);
  assert.throws(() => Core.parseStructuredJSON('{"ok":"tak","items":[]}', strictSchema), /schemat/);
  assert.deepEqual(Core.parseAIJSON('{"ok":"tak","items":[]}'), { ok: 'tak', items: [] }, 'parser must not repair semantics');

  const textChunks = Core.chunkText('Zdanie pierwsze. Zdanie drugie. '.repeat(100), 300, 40);
  assert.ok(textChunks.length > 1);
  assert.ok(textChunks[0].endOffset > textChunks[1].startOffset, 'text chunks should overlap');

  const segments = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `Segment ${i} ma pełną treść.` }));
  const segmentChunks = Core.chunkSegments(segments, 100, 1);
  assert.ok(segmentChunks.length > 1);
  assert.equal(segmentChunks[0].segmentIndexes.at(-1), segmentChunks[1].segmentIndexes[0]);
  assert.equal(segmentChunks[0].chunkNumber, 1);
  assert.equal(segmentChunks[1].chunkNumber, 2);
  assert.equal(segmentChunks[0].startTime, 0);
  assert.ok(segmentChunks[0].endTime > segmentChunks[0].startTime);

  const source = 'To jest pełne zdanie o ważnej sprawie. '.repeat(20);
  const badCleanup = Core.validateCleanup(source, 'Krótkie streszczenie.');
  assert.equal(badCleanup.accepted, false);
  assert.ok(badCleanup.reasons.includes('length_ratio'));
  assert.equal(Core.deterministicCleanTranscript('A   B\n\n\nC'), 'A B\n\nC');
  const ratioInput = 'a'.repeat(100);
  assert.equal(Core.validateCleanup(ratioInput, 'a'.repeat(100)).accepted, true);
  assert.equal(Core.validateCleanup(ratioInput, 'a'.repeat(90)).accepted, true);
  assert.equal(Core.validateCleanup(ratioInput, 'a'.repeat(76)).accepted, true);
  assert.equal(Core.validateCleanup(ratioInput, 'a'.repeat(74)).accepted, false);
  assert.equal(Core.validateCleanup(ratioInput, '').accepted, false);
  assert.ok(Core.validateCleanup('W roku 2026 było 75% głosów.', 'W roku było głosów.').reasons.includes('number_loss'));
  assert.ok(Core.validateCleanup('Pełna treść zdania. '.repeat(10), 'Podsumowanie: ' + 'x'.repeat(200)).reasons.includes('meta_commentary'));

  const merged = Core.mergeAnalyses([
    { theses: ['Wspólna teza', 'Unikalna A'], recommendations: ['Zalecenie.'], concepts: [{ term: 'Dialog', definition: 'Krótko' }] },
    { theses: ['wspólna teza!', 'Unikalna B'], recommendations: ['zalecenie'], concepts: [{ term: 'dialog', definition: 'Dłuższa i pełniejsza definicja' }] },
  ]);
  assert.equal(merged.theses.length, 3);
  assert.match(merged.theses[0], /wspólna teza/i);
  assert.equal(merged.concepts.length, 1);
  assert.equal(merged.concepts[0].definition, 'Dłuższa i pełniejsza definicja');
  const longPartials = Array.from({ length: 50 }, (_, index) => ({
    theses: ['Teza wspólna', `Teza unikalna ${index}`],
    recommendations: ['Rekomendacja wspólna'],
  }));
  const longMerged = Core.mergeAnalyses(longPartials);
  assert.equal(longMerged.theses[0], 'Teza wspólna');
  assert.equal(longMerged.theses.length, 40);
  assert.equal(longMerged.recommendations.length, 1);

  let calls = 0;
  const retries = [];
  const retried = await Core.withRetry(async () => {
    calls += 1;
    if (calls < 3) { const error = new Error('network error'); error.status = 503; throw error; }
    return 'ok';
  }, { baseDelayMs: 0, jitterMs: 0, sleep: async () => {}, onRetry: info => retries.push(info.nextAttempt) });
  assert.equal(retried, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [2, 3]);

  for (const transient of [429, 502, 503, 504]) {
    let transientCalls = 0;
    await Core.withRetry(async () => {
      transientCalls += 1;
      if (transientCalls === 1) { const error = new Error('temporary'); error.status = transient; throw error; }
      return 'ok';
    }, { baseDelayMs: 0, jitterMs: 0, sleep: async () => {} });
    assert.equal(transientCalls, 2);
  }
  for (const message of ['timeout', 'network error']) {
    let transientCalls = 0;
    await Core.withRetry(async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new Error(message);
      return 'ok';
    }, { baseDelayMs: 0, jitterMs: 0, sleep: async () => {} });
    assert.equal(transientCalls, 2);
  }
  let permanentCalls = 0;
  await assert.rejects(() => Core.withRetry(async () => {
    permanentCalls += 1;
    const error = new Error('bad request'); error.status = 400; throw error;
  }, { baseDelayMs: 0, sleep: async () => {} }), /bad request/);
  assert.equal(permanentCalls, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => Core.withRetry(async () => { throw new DOMException('Aborted', 'AbortError'); }, {
    sleep: async () => { throw new Error('should not retry'); },
  }), /Aborted/);

  const retryController = new AbortController();
  const duringBackoff = Core.withRetry(async () => {
    const error = new Error('network error'); error.status = 503; throw error;
  }, { signal: retryController.signal, baseDelayMs: 5000, jitterMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 5));
  retryController.abort();
  await assert.rejects(() => duringBackoff, /Anulowano|Aborted/);

  assert.equal(Core.verifyMigratedEntries([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]).ok, true);
  assert.equal(Core.verifyMigratedEntries([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }]).ok, false);

  const migrationA = { marker: null, legacy: [{ id: 'a', transcriptRaw: 'raw-a' }, { id: 'b', transcriptRaw: 'raw-b' }], entries: [] };
  const migrationAdapters = state => ({
    getMarker: async () => state.marker,
    readLegacy: async () => structuredClone(state.legacy),
    writeEntries: async entriesToWrite => {
      const byId = new Map(state.entries.map(entry => [entry.id, entry]));
      entriesToWrite.forEach(entry => byId.set(entry.id, structuredClone(entry)));
      state.entries = [...byId.values()];
    },
    readEntries: async () => structuredClone(state.entries),
    writeMarker: async marker => { state.marker = marker; },
    now: () => new Date('2026-08-12T12:00:00Z'),
  });
  await Core.migrateLegacyEntries(migrationAdapters(migrationA));
  assert.equal(migrationA.entries.length, 2);
  assert.equal(migrationA.entries[0].transcriptRaw, 'raw-a');
  assert.equal(migrationA.marker.completed, true);

  const migrationB = { marker: null, legacy: structuredClone(migrationA.legacy), entries: [structuredClone(migrationA.legacy[0])] };
  await Core.migrateLegacyEntries(migrationAdapters(migrationB));
  assert.equal(migrationB.entries.length, 2, 'interrupted migration resumes without duplicates');

  const migrationC = { marker: { completed: true, migratedCount: 1 }, legacy: [{ id: 'a', transcriptRaw: 'old' }, { id: 'b' }], entries: [{ id: 'a', transcriptRaw: 'new' }] };
  await Core.migrateLegacyEntries(migrationAdapters(migrationC));
  assert.deepEqual(migrationC.entries, [{ id: 'a', transcriptRaw: 'new' }], 'completed marker makes IndexedDB the source of truth');

  const migrationD = { marker: null, legacy: [{ id: 'safe', transcriptRaw: 'still here' }], entries: [] };
  const failingAdapters = migrationAdapters(migrationD);
  failingAdapters.writeEntries = async () => { throw new Error('synthetic IndexedDB write failure'); };
  await assert.rejects(() => Core.migrateLegacyEntries(failingAdapters), /write failure/);
  assert.equal(migrationD.marker, null, 'failure must not write completion marker');
  assert.equal(migrationD.legacy[0].transcriptRaw, 'still here', 'legacy source must remain untouched');
  assert.match(Core.buildChunkContext({ sessionType: 'panel', title: 'T' }, { startTime: 3, endTime: 8 }, 0, 2), /punkty sporu/i);
  assert.match(Core.buildChunkContext({ sessionType: 'wykład' }, {}, 0, 1), /argumentację/i);
  assert.match(Core.buildChunkContext({ sessionType: 'warsztat' }, {}, 0, 1), /ćwiczenia/i);
  assert.match(Core.buildChunkContext({ sessionType: 'inne' }, {}, 0, 1), /Dopasuj strukturę/i);

  const fingerprintEntry = { id: 'e1', transcriptRaw: 'Źródło', transcript: 'Źródło', title: 'T', speaker: 'S', event: 'E', sessionType: 'panel', language: 'pl' };
  const fingerprintChunks = Core.chunkEntry({ ...fingerprintEntry, segments }, 100, 40, 1);
  const fingerprintConfig = { model: 'm1', promptVersion: 'p1', schemaVersion: 1 };
  const baseFingerprint = Core.analysisFingerprint(fingerprintEntry, fingerprintChunks, fingerprintConfig);
  assert.equal(baseFingerprint, Core.analysisFingerprint(fingerprintEntry, fingerprintChunks, fingerprintConfig));
  assert.notEqual(baseFingerprint, Core.analysisFingerprint({ ...fingerprintEntry, transcript: 'Zmienione' }, fingerprintChunks, fingerprintConfig));
  assert.notEqual(baseFingerprint, Core.analysisFingerprint(fingerprintEntry, fingerprintChunks, { ...fingerprintConfig, model: 'm2' }));
  assert.notEqual(baseFingerprint, Core.analysisFingerprint({ ...fingerprintEntry, sessionType: 'warsztat' }, fingerprintChunks, fingerprintConfig));
  assert.notEqual(baseFingerprint, Core.analysisFingerprint(fingerprintEntry, fingerprintChunks, { ...fingerprintConfig, schemaVersion: 2 }));
  assert.equal(Core.rawTranscriptUnchanged(fingerprintEntry, { ...fingerprintEntry, transcript: 'edycja robocza' }), true);
  assert.equal(Core.rawTranscriptUnchanged(fingerprintEntry, { ...fingerprintEntry, transcriptRaw: 'zmienione źródło' }), false);

  // ROUND 3 A/B: timeline and combined archive search.
  const timelineEntry = {
    id: 'timeline-1', title: 'Panel o dialogu', speaker: 'Anna', event: 'Forum', sessionType: 'panel',
    createdAt: '2026-08-01T10:00:00Z', analysisStatus: 'done', model: 'turbo', hasAudio: true,
    tags: ['dialog', 'miasto'], summary: 'Współpraca z mieszkańcami.',
    transcriptRaw: 'Pierwszy głos o dialogu. Drugi głos o konsultacjach.',
    transcript: 'Pierwszy głos o dialogu. Drugi głos o konsultacjach.',
    segments: [
      { start: 0, end: 4, text: 'Pierwszy głos o dialogu.', speakerId: 'spk_0', speakerLabel: 'Anna' },
      { start: 4, end: 9, text: 'Drugi głos o konsultacjach.', speakerId: 'spk_1', speakerLabel: 'Piotr' },
    ],
  };
  assert.equal(Core.activeSegmentIndex(timelineEntry.segments, 0), 0);
  assert.equal(Core.activeSegmentIndex(timelineEntry.segments, 4.5), 1);
  assert.equal(Core.activeSegmentIndex(timelineEntry.segments, 20), -1);
  assert.equal(Core.stableSegmentId(timelineEntry.segments[0], 0), Core.stableSegmentId(timelineEntry.segments[0], 0));
  assert.equal(Core.findSourceForText(timelineEntry, 'drugi głos o konsultacjach').start, 4);
  const searchIndex = Core.buildSearchIndex([timelineEntry, { ...timelineEntry, id: 'timeline-2', speaker: 'Beata', tags: ['wieś'], analysisStatus: 'not_analyzed', hasAudio: false }]);
  assert.deepEqual(Core.searchArchive(searchIndex, 'konsultacjach', { speaker: 'Anna', event: 'Forum', status: 'done', hasAudio: true, hasAnalysis: true, tags: ['dialog'] }).map(item => item.id), ['timeline-1']);
  assert.equal(Core.searchArchive(searchIndex, '', { dateFrom: '2026-08-02' }).length, 0);

  // ROUND 3 C/D: imports preserve subtitle timing and profiles are deterministic.
  const srtText = '1\n00:00:01,000 --> 00:00:03,500\nDzień dobry.\n\n2\n00:00:04,000 --> 00:00:06,000\nDrugi segment.\n';
  const srtSegments = Core.parseTimedText(srtText, 'srt');
  assert.equal(srtSegments.length, 2);
  assert.equal(srtSegments[0].start, 1);
  assert.equal(srtSegments[1].end, 6);
  const vttSegments = Core.parseTimedText('WEBVTT\n\n00:01.000 --> 00:03.000\n<v Anna>Treść</v>\n', 'vtt');
  assert.equal(vttSegments[0].text, 'Treść');
  assert.equal(vttSegments[0].speakerLabel, 'Anna');
  assert.match(vttSegments[0].speakerId, /^speaker-/);
  const importedSrt = Core.parseImportedDocument('debata.srt', srtText, { importedAt: '2026-08-12T12:00:00Z' });
  assert.equal(importedSrt.sourceType, 'subtitles');
  assert.equal(importedSrt.durationSec, 6);
  assert.equal(importedSrt.hasAudio, false);
  assert.equal(Core.parseImportedDocument('notatka.md', '# Tytuł\n\nTreść.').model, 'import:md');
  assert.equal(Core.parseDocxXml('<w:document><w:p><w:r><w:t>Ala</w:t></w:r></w:p><w:p><w:r><w:t>Ola</w:t></w:r></w:p></w:document>'), 'Ala\nOla');
  assert.equal(Core.resolveProcessingProfile(7200, 'auto').key, 'fast');
  assert.equal(Core.resolveProcessingProfile(2400, 'auto').key, 'balanced');
  assert.equal(Core.resolveProcessingProfile(600, 'auto').key, 'archive');
  assert.equal(Core.resolveProcessingProfile(7200, 'archive').key, 'archive');
  assert.ok(Core.estimateProcessing(3600, 'archive').seconds > Core.estimateProcessing(3600, 'fast').seconds);

  // ROUND 3 E/F/G/H/I: export structures, source links, analytics, chapters and speaker fields.
  assert.match(Core.toCSV([{ text: '=SUM(A1:A2)' }]), /"'=SUM/);
  assert.match(Core.formatSRT(timelineEntry.segments), /00:00:04,000 --> 00:00:09,000/);
  assert.match(Core.formatVTT(timelineEntry.segments), /^WEBVTT/);
  const csvExports = Core.buildCsvExports([timelineEntry]);
  assert.deepEqual(Object.keys(csvExports), ['wpisy.csv', 'pojecia.csv', 'metody.csv', 'segmenty.csv']);
  const docxFiles = Core.buildDocxPackage(timelineEntry, { includeRaw: true, includeClean: true, includeTimestamps: true });
  assert.ok(docxFiles['word/document.xml'].includes('Transkrypt źródłowy'));
  assert.ok(docxFiles['word/styles.xml'].includes('2E74B5'));
  assert.ok(docxFiles['word/document.xml'].includes('w:pgMar w:w="12240"') === false);
  assert.ok(docxFiles['word/document.xml'].includes('w:pgMar w:top="1440"'));
  const xlsxFiles = Core.buildXlsxPackage([timelineEntry]);
  assert.ok(xlsxFiles['xl/worksheets/sheet1.xml'].includes('state="frozen"'));
  assert.ok(xlsxFiles['xl/worksheets/sheet4.xml'].includes('speakerLabel'));
  assert.ok(xlsxFiles['xl/styles.xml'].includes('FF215A6D'));
  const emptyRelationXlsx = Core.buildXlsxPackage([{ id: 'minimal', title: 'Minimalny' }]);
  assert.ok(emptyRelationXlsx['xl/worksheets/sheet2.xml'].includes('definition'), 'empty relation sheets retain headers');
  assert.ok(Core.buildCsvExports([{ id: 'minimal' }])['pojecia.csv'].includes('entryId'), 'empty CSV retains headers');
  const analyticalEntries = [
    { ...timelineEntry, concepts: [{ term: 'Dialog', definition: 'Rozmowa z mieszkańcami' }], methods: [{ name: 'Warsztat', description: 'Praca grupowa' }], theses: ['Dialog wymaga czasu'], recommendations: ['Zaprosić mieszkańców'] },
    { ...timelineEntry, id: 'timeline-3', title: 'Drugi panel', createdAt: '2026-07-01', transcript: 'Dialog społeczny i warsztat mieszkańców.', transcriptRaw: 'Dialog społeczny i warsztat mieszkańców.', concepts: [{ term: 'dialog', definition: 'Proces rozmowy' }], methods: [], theses: [], recommendations: ['Zaprosić mieszkańców'] },
  ];
  const aggregate = Core.aggregateArchive(analyticalEntries);
  assert.equal(aggregate.concepts.length, 1);
  assert.equal(aggregate.concepts[0].sources.length, 2);
  assert.equal(aggregate.recommendations[0].sources.length, 2);
  assert.doesNotMatch(JSON.stringify(aggregate), /_sourceIds/);
  const tfidfA = Core.computeTfIdf(analyticalEntries);
  const tfidfB = Core.computeTfIdf(analyticalEntries);
  assert.deepEqual(tfidfA, tfidfB, 'TF-IDF must be deterministic');
  assert.equal(Core.archiveTrends(analyticalEntries).length, 2);
  assert.ok(Core.cooccurrence(analyticalEntries).length > 0);
  const stats = Core.speechStats(timelineEntry);
  assert.equal(stats.speakers.length, 2);
  assert.equal(stats.speakerTurns, 2);
  assert.ok(stats.wordsPerMinute > 0);
  const chapters = Core.buildSourceChapters({ ...timelineEntry, segments: Array.from({ length: 8 }, (_, i) => ({ start: i * 120, end: i * 120 + 100, text: `Dialog mieszkańców metoda konsultacji etap ${i}`, speakerId: i % 2 ? 'spk_1' : 'spk_0' })) }, 300);
  assert.ok(chapters.length >= 2);
  assert.equal(chapters[0].start, 0);
  assert.ok(chapters[0].segmentIds.length > 0);
  assert.equal(chapters[0].mode, 'structural');
  assert.equal(chapters[0].startTime, chapters[0].start);

  // FINAL PASS: semantic chapters may only group real, contiguous source chunks.
  const semanticFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'semantic-chapters.json'), 'utf8'));
  for (const [fixtureName, fixture] of Object.entries(semanticFixtures)) {
    const semanticEntry = {
      id: `semantic-${fixtureName}`,
      title: fixture.title,
      segments: fixture.segments.map((text, index) => ({ start: index * 60, end: index * 60 + 55, text })),
    };
    const semanticChunks = Core.buildSemanticChapterChunks(semanticEntry, 180);
    assert.ok(semanticChunks.length >= 2, `${fixtureName}: expected multiple source chunks`);
    if (fixture.groups) {
      const plan = { chapters: fixture.groups.map((indexes, index) => ({
        title: `Temat ${index + 1}`,
        summary: `Skrót ${index + 1}`,
        chunkIds: indexes.map(chunkIndex => semanticChunks[chunkIndex].chunkId),
      })) };
      const result = Core.validateSemanticChapterPlan(semanticEntry, semanticChunks, plan, { model: 'fixture-model', promptVersion: 'test-v1' });
      assert.equal(result.valid, true, `${fixtureName}: valid plan should pass`);
      assert.deepEqual(result.chapters.flatMap(chapter => chapter.chunkIds), semanticChunks.map(chunk => chunk.chunkId));
      assert.equal(new Set(result.chapters.flatMap(chapter => chapter.chunkIds)).size, semanticChunks.length);
      assert.equal(result.chapters[0].startTime, semanticChunks[0].startTime);
      assert.equal(result.chapters.at(-1).endTime, semanticChunks.at(-1).endTime);
      assert.ok(result.chapters.every(chapter => chapter.mode === 'semantic' && chapter.model === 'fixture-model'));
    } else {
      const invented = Core.validateSemanticChapterPlan(semanticEntry, semanticChunks, {
        chapters: [{ title: 'Błędny', summary: '', chunkIds: [semanticChunks[0].chunkId, 'invented-id'] }],
      });
      assert.equal(invented.valid, false);
      assert.ok(invented.chapters.length > 0);
      assert.ok(invented.chapters.every(chapter => chapter.mode === 'structural'));
      const duplicate = Core.validateSemanticChapterPlan(semanticEntry, semanticChunks, {
        chapters: [{ title: 'Duplikat', summary: '', chunkIds: [semanticChunks[0].chunkId, semanticChunks[0].chunkId] }],
      });
      assert.equal(duplicate.valid, false);
      const missing = Core.validateSemanticChapterPlan(semanticEntry, semanticChunks, {
        chapters: [{ title: 'Niepełny', summary: '', chunkIds: [semanticChunks[0].chunkId] }],
      });
      assert.equal(missing.valid, false);
      const reordered = Core.validateSemanticChapterPlan(semanticEntry, semanticChunks, {
        chapters: [{ title: 'Zła kolejność', summary: '', chunkIds: semanticChunks.map(chunk => chunk.chunkId).reverse() }],
      });
      assert.equal(reordered.valid, false);
    }
  }

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const embeddedModule = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(embeddedModule, 'embedded frontend module should exist');
  new vm.Script(embeddedModule[1], { filename: 'skryptorium-embedded.js' });
  assert.match(html, /Transkrypt źródłowy \(niezmieniony\)[\s\S]*entry\.transcriptRaw/);
  assert.doesNotMatch(html, /\/api\/ollama\/longtask/);
  assert.doesNotMatch(html, /JSON\.stringify\(state\)/, 'hot paths must not serialize the whole archive');
  assert.match(html, /id="globalSearch"/);
  assert.match(html, /processing_profile/);
  assert.match(html, /data-pane="timeline"/);
  assert.match(html, /data-pane="chapters"/);
  assert.match(html, /data-semantic-chapters/);
  assert.match(html, /archiveSearchRevision !== archiveDataRevision/);
  assert.match(html, /setTimeout\(runArchiveSearch, 160\)/);
  assert.match(html, /archiveDerivedRevision/);
  assert.match(html, /archiveSourceLimits\.get\(key\) \|\| 60/);
  assert.match(html, /data-more-sources/);
  assert.match(html, /\.\/vendor\/jszip\.min\.js/);
  assert.doesNotMatch(html, /https?:\/\/[^'"\s]*jszip/i, 'JSZip must not be fetched from a CDN at runtime');
  assert.match(html, /data-export-entry-docx/);
  assert.match(html, /id="exportXlsxBtn"/);
  assert.match(html, /speakerId: segment\.speakerId \|\| ''/);

  const archiveStressEntries = Array.from({ length: 240 }, (_, entryIndex) => ({
    id: `stress-${entryIndex}`,
    title: `Panel ${entryIndex}`,
    speaker: entryIndex % 3 === 0 ? 'Anna' : 'Piotr',
    event: entryIndex % 2 === 0 ? 'Forum' : 'Kongres',
    sessionType: 'panel',
    createdAt: `2026-${String((entryIndex % 12) + 1).padStart(2, '0')}-01`,
    analysisStatus: entryIndex % 2 ? 'done' : 'not_analyzed',
    hasAudio: entryIndex % 4 !== 0,
    tags: [`tag-${entryIndex % 5}`, 'dialog'],
    transcriptRaw: `Dialog społeczny konsultacje mieszkańcy rekomendacja numer ${entryIndex}. `.repeat(80),
    transcript: `Dialog społeczny konsultacje mieszkańcy rekomendacja numer ${entryIndex}. `.repeat(80),
    segments: [{ start: 0, end: 10, text: `Dialog społeczny numer ${entryIndex}` }],
  }));
  const stressIndex = Core.buildSearchIndex(archiveStressEntries);
  const stressResults = Core.searchArchive(stressIndex, 'konsultacje', { speaker: 'Anna', event: 'Forum', tags: ['dialog'] });
  assert.ok(stressResults.length > 0);
  assert.ok(stressResults.every(result => result.entry.speaker === 'Anna' && result.entry.event === 'Forum'));

  // MOCKED INTEGRATION: 90 minutes at 4 Whisper segments/minute and dense transcript text.
  const ninetyMinuteSegments = Array.from({ length: 360 }, (_, index) => ({
    start: index * 15,
    end: (index + 1) * 15,
    text: `Fragment ${index + 1}: pełna treść wypowiedzi o procesie, metodzie, liczbie ${index + 1000} i rekomendacji dla mieszkańców. `.repeat(4),
  }));
  const ninetyMinuteEntry = {
    id: 'long-90m', title: 'Długi panel', speaker: 'Zespół', event: 'Forum',
    sessionType: 'panel', language: 'pl', segments: ninetyMinuteSegments,
  };
  ninetyMinuteEntry.transcriptRaw = ninetyMinuteSegments.map(segment => segment.text).join(' ');
  ninetyMinuteEntry.transcript = ninetyMinuteEntry.transcriptRaw;
  const ninetyMinuteChunks = Core.chunkEntry(ninetyMinuteEntry, 9000, 450, 1);
  assert.ok(ninetyMinuteChunks.length > 10);
  assert.equal(ninetyMinuteChunks[0].startTime, 0);
  assert.equal(ninetyMinuteChunks.at(-1).endTime, 5400);
  assert.equal(ninetyMinuteChunks[0].segmentIndexes.at(-1), ninetyMinuteChunks[1].segmentIndexes[0]);
  assert.equal(new Set(ninetyMinuteChunks.flatMap(chunk => chunk.segmentIndexes)).size, ninetyMinuteSegments.length);
  const mockedCheckpoint = { sourceFingerprint: Core.analysisFingerprint(ninetyMinuteEntry, ninetyMinuteChunks, { model: 'mock', schemaVersion: 2 }), completed: {} };
  const firstLongChunkId = Core.stableChunkId(ninetyMinuteChunks[0], 0);
  mockedCheckpoint.completed[firstLongChunkId] = { theses: ['Teza 1'] };
  assert.deepEqual(mockedCheckpoint.completed[firstLongChunkId], { theses: ['Teza 1'] });
  assert.notEqual(mockedCheckpoint.sourceFingerprint, Core.analysisFingerprint({ ...ninetyMinuteEntry, transcript: ninetyMinuteEntry.transcript + ' zmiana' }, ninetyMinuteChunks, { model: 'mock', schemaVersion: 2 }));

  // ---- Runda 4: korekta transkryptu i sygnały jakości ----
  assert.equal(Core.segmentConfidence({ avgLogProb: -0.2, compressionRatio: 1.3, noSpeechProb: 0.01 }).level, 'ok');
  assert.equal(Core.segmentConfidence({ avgLogProb: -0.8 }).level, 'check');
  assert.equal(Core.segmentConfidence({ avgLogProb: -1.3 }).level, 'low');
  assert.equal(Core.segmentConfidence({ compressionRatio: 3.1 }).level, 'low');
  assert.equal(Core.segmentConfidence({ avgLogProb: -1.3, edited: true }).level, 'ok', 'ręczna poprawka zdejmuje flagę');
  assert.equal(Core.segmentConfidence({ text: 'import bez metryk' }).level, 'ok');

  const replaced = Core.replaceInText('ConfUI, confui oraz ConfUIx i Mconfui', 'confui', 'ComfyUI');
  assert.equal(replaced.count, 2, 'zamiana wyłącznie całych słów');
  assert.equal(replaced.text, 'ComfyUI, ComfyUI oraz ConfUIx i Mconfui');
  assert.equal(Core.replaceInText('Łódź i łódź', 'łódź', 'Lodz').count, 2, 'polskie znaki i wielkość liter');
  assert.equal(Core.replaceInText('Łódź i łódź', 'łódź', 'Lodz', { ignoreCase: false }).count, 1);
  assert.equal(Core.replaceInText('a.b axb', 'a.b', 'X').text, 'X axb', 'znaki specjalne regex są escapowane');

  const correctionEntry = {
    transcriptRaw: 'Mówił Kowalsky. Potem Kowalsky.',
    transcript: 'Mówił Kowalsky. Potem Kowalsky.',
    cleanTranscript: 'Mówił Kowalsky.',
    segments: [{ start: 0, end: 2, text: 'Mówił Kowalsky.' }, { start: 2, end: 4, text: 'Potem Kowalsky.' }],
  };
  assert.equal(Core.countInEntry(correctionEntry, 'kowalsky'), 3);
  const replaceResult = Core.replaceInEntry(correctionEntry, 'Kowalsky', 'Kowalski');
  assert.equal(replaceResult.fields.segments, 2);
  assert.equal(correctionEntry.transcriptRaw, 'Mówił Kowalsky. Potem Kowalsky.', 'źródło jest nienaruszalne');
  assert.equal(correctionEntry.segments[0].originalText, 'Mówił Kowalsky.');
  assert.equal(correctionEntry.segments[0].edited, true);
  assert.ok(Core.rawTranscriptUnchanged({ transcriptRaw: correctionEntry.transcriptRaw }, correctionEntry));

  const editEntry = { transcript: 'Tak. Ala ma kota. Tak.', segments: [{ text: 'Tak.' }, { text: 'Ala ma kota.' }, { text: 'Tak.' }] };
  assert.deepEqual(Core.applySegmentEdit(editEntry, 1, 'Ala ma  psa.'), { changed: true, propagated: true });
  assert.equal(editEntry.transcript, 'Tak. Ala ma psa. Tak.');
  assert.deepEqual(Core.applySegmentEdit(editEntry, 0, 'Nie.'), { changed: true, propagated: false }, 'niejednoznaczne miejsce nie jest zgadywane');
  assert.equal(editEntry.transcript, 'Tak. Ala ma psa. Tak.');
  assert.equal(editEntry.segments[0].originalText, 'Tak.');
  assert.deepEqual(Core.applySegmentEdit(editEntry, 1, 'Ala ma psa.'), { changed: false, propagated: false });
  assert.deepEqual(Core.applySegmentEdit(editEntry, 1, '   '), { changed: false, propagated: false }, 'pusty tekst nie kasuje segmentu');

  assert.equal(Core.mergeHotwords('Skryptorium, ComfyUI', 'comfyui'), 'Skryptorium, ComfyUI');
  assert.equal(Core.mergeHotwords('', 'Toruń'), 'Toruń');
  assert.equal(Core.mergeHotwords('A,, B ,', 'C'), 'A, B, C');

  const qualityEntry = {
    segments: [{ avgLogProb: -1.4 }, { avgLogProb: -0.8 }, { edited: true, avgLogProb: -1.4 }, { repaired: true }],
    transcriptionQuality: { removedCount: 2, repaired: 1 },
  };
  assert.deepEqual(Core.transcriptQualitySummary(qualityEntry), { low: 1, check: 1, edited: 1, repaired: 1, removed: 2, flagged: 2 });

  const learned = Core.estimateProcessing(600, 'balanced', 5);
  assert.equal(learned.seconds, 120);
  assert.equal(learned.learned, true);
  assert.equal(Core.estimateProcessing(600, 'balanced').learned, false);

  console.log('Frontend core: wszystkie testy przeszły.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
