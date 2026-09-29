'use strict';
/**
 * Fixture: polski wykład o partycypacji obywatelskiej.
 *
 * 32 segmenty po ~45 s => ~24 minuty materiału.
 * Cztery WYRAŹNIE rozdzielone bloki tematyczne, po 8 segmentów każdy.
 *
 * Przy produkcyjnym chunkowaniu (buildSemanticChapterChunks, targetSeconds=180)
 * daje to 8 chunków po 4 segmenty. Granice tematów wypadają dokładnie na
 * granicach chunków, więc REFERENCYJNY podział ręczny to:
 *     [chunk 1,2] [chunk 3,4] [chunk 5,6] [chunk 7,8]
 * czyli 4 rozdziały. To jest wzorzec z sekcji 4 specyfikacji closure passu.
 */

const TOPICS = [
  {
    label: 'Czym są konsultacje społeczne',
    lines: [
      'Dzień dobry, dzisiaj porozmawiamy o konsultacjach społecznych jako narzędziu zarządzania miastem.',
      'Konsultacje społeczne to zorganizowany dialog między władzą publiczną a mieszkańcami przed podjęciem decyzji.',
      'Podstawę prawną daje ustawa o samorządzie gminnym oraz uchwały konsultacyjne przyjmowane lokalnie.',
      'Kluczowe jest rozróżnienie: konsultacje to nie referendum i nie głosowanie, tylko zbieranie opinii.',
      'Decyzja pozostaje po stronie organu, ale organ ma obowiązek uzasadnić, co zrobił z uwagami.',
      'Standardem minimum jest siedem zasad konsultacji: dobra wiara, powszechność, przejrzystość i responsywność.',
      'Do tego dochodzi koordynacja, przewidywalność oraz poszanowanie interesu ogólnego mieszkańców.',
      'Bez informacji zwrotnej cały proces traci sens i mieszkańcy przestają wierzyć w kolejne zaproszenia.',
    ],
  },
  {
    label: 'Budżet obywatelski w praktyce',
    lines: [
      'Przechodzimy teraz do budżetu obywatelskiego, czyli najbardziej rozpoznawalnego narzędzia partycypacji.',
      'Budżet obywatelski to wydzielona część budżetu gminy, o której przeznaczeniu decydują bezpośrednio mieszkańcy.',
      'W miastach na prawach powiatu jest on obowiązkowy i wynosi co najmniej pół procenta wydatków.',
      'Cykl wygląda tak: nabór projektów, weryfikacja formalna, głosowanie, realizacja i rozliczenie.',
      'Gdynia prowadzi budżet obywatelski od dwa tysiące trzynastego roku i wypracowała model dzielnicowy.',
      'Dąbrowa Górnicza postawiła na spotkania dzielnicowe zamiast wyłącznie internetowego formularza.',
      'Największym błędem jest traktowanie weryfikacji jako etapu czysto urzędniczego, bez rozmowy z autorem.',
      'Dobry budżet obywatelski uczy mieszkańców myślenia o wspólnych ograniczeniach, a nie tylko o własnym podwórku.',
    ],
  },
  {
    label: 'Bariery i typowe błędy',
    lines: [
      'Teraz część najtrudniejsza, czyli bariery, o których rzadko mówi się na konferencjach.',
      'Pierwsza bariera to pozorność: konsultacje ogłaszane wtedy, gdy decyzja jest już faktycznie podjęta.',
      'Druga to język. Dokumenty planistyczne są nieczytelne dla osoby bez wykształcenia technicznego.',
      'Trzecia bariera to frekwencja i jej struktura, bo przychodzą zawsze te same aktywne osoby.',
      'Osoby pracujące zmianowo, opiekunowie i młodzież są systemowo nieobecni w godzinach urzędowania.',
      'Czwarta bariera to brak zasobów po stronie urzędu, gdzie konsultacje robi jedna osoba przy innych obowiązkach.',
      'Piąta to brak pętli zwrotnej, czyli nieodpowiadanie na uwagi, które wpłynęły w poprzedniej edycji.',
      'Efektem kumulacji tych barier jest zmęczenie partycypacyjne i spadek zaufania do samorządu.',
    ],
  },
  {
    label: 'Rekomendacje i narzędzia cyfrowe',
    lines: [
      'Na koniec rekomendacje, które da się wdrożyć bez zmiany ustawy i bez dużego budżetu.',
      'Rekomendacja pierwsza: konsultuj wcześnie, na etapie założeń, a nie gotowego projektu uchwały.',
      'Rekomendacja druga: publikuj raport z konsultacji z tabelą uwaga po uwadze i decyzją wraz z uzasadnieniem.',
      'Rekomendacja trzecia: łącz kanały. Panel internetowy nie zastąpi spotkania, spotkanie nie zastąpi ankiety.',
      'Narzędzia cyfrowe, takie jak platformy konsultacyjne, obniżają próg wejścia, ale wykluczają osoby starsze.',
      'Dlatego zawsze trzeba mieć ścieżkę offline, papierową lub telefoniczną, dla osób bez kompetencji cyfrowych.',
      'Warto też testować panele obywatelskie z losowaniem uczestników, bo dają przekrój, a nie samych aktywistów.',
      'Podsumowując: partycypacja to nie wydarzenie, tylko proces, który mierzy się jakością odpowiedzi na uwagi.',
    ],
  },
];

const SEGMENT_SECONDS = 45;

function buildEntry() {
  const segments = [];
  let index = 0;
  for (const topic of TOPICS) {
    for (const text of topic.lines) {
      const start = index * SEGMENT_SECONDS;
      segments.push({
        start,
        end: start + SEGMENT_SECONDS - 1,
        text,
        segmentId: `seg-${String(index + 1).padStart(3, '0')}`,
        avgLogProb: -0.24,
        compressionRatio: 1.35,
        noSpeechProb: 0.01,
      });
      index += 1;
    }
  }
  return {
    id: 'closure_fixture_wyklad',
    title: 'Partycypacja obywatelska — wykład testowy',
    createdAt: new Date().toISOString(),
    durationSec: segments.length * SEGMENT_SECONDS,
    speaker: 'Prelegent testowy',
    event: 'Forum Praktyków Partycypacji (fixture)',
    sessionType: 'wykład',
    language: 'pl',
    segments,
    transcript: segments.map(segment => segment.text).join(' '),
    transcriptRaw: segments.map(segment => segment.text).join(' '),
  };
}

/** Ile segmentów przypada na każdy blok tematyczny — do wzorca referencyjnego. */
const TOPIC_SIZES = TOPICS.map(topic => topic.lines.length);
const TOPIC_LABELS = TOPICS.map(topic => topic.label);

module.exports = { buildEntry, TOPIC_SIZES, TOPIC_LABELS, SEGMENT_SECONDS };
