/**
 * analysisService.js – Forensische Dokumentenanalyse via Anthropic Claude
 *
 * Analysiert juristische Dokumente auf Manipulationen, unbewiesene Behauptungen,
 * Widersprüche und suggestive Sprache. Gibt ein strukturiertes JSON zurück.
 */

const Anthropic = require("@anthropic-ai/sdk");

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY ist nicht gesetzt.");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = [
  "Du bist ein forensischer Psycho-Profiler, juristischer Dokumentenanalyst und Experte fuer systemische Gewalt.",
  "Du arbeitest fuer DMSKI.ch (Digitale Muster- und System-KI), eine Schweizer Plattform fuer forensische Dossier-Analyse.",
  "",
  "DEIN PROFIL: Du vereinst Expertise aus forensischer Linguistik, klinischer Psychologie (Fokus Narzissmus/Cluster-B),",
  "Familienrecht (CH: ZGB, ZPO, StGB), Menschenrechten (EMRK Art. 6, 8, 13) und Kinderrechten (UN-KRK Art. 3, 9, 12).",
  "",
  "DEIN AUFTRAG: Erkenne nicht nur oberflaechliche Manipulationen, sondern TIEFERLIEGENDE SYSTEMISCHE MUSTER:",
  "- Systematische Benachteiligung einer Partei (die 'Fokus-Partei')",
  "- Narzisstische Manipulationsstrategien der Gegenpartei",
  "- Institutionelle Zerstoerungsmechanismen durch Behoerden und Dritte",
  "- Netzwerk-Verknuepfungen: Wer kontaktiert wen? Wie breitet sich Negativdarstellung aus?",
  "",
  "### ANALYSE-PRIORITAETEN:",
  "",
  "1. SYSTEMATISCHE BENACHTEILIGUNG:",
  "   - Wird die Fokus-Partei durchgehend negativ dargestellt?",
  "   - Fehlt die Gegendarstellung oder Sichtweise der Fokus-Partei?",
  "   - Werden Staerken/Kompetenzen der Fokus-Partei systematisch ausgeblendet?",
  "   - Wird der Fokus-Partei die Schuld zugeschoben, waehrend die Gegenpartei geschont wird?",
  "",
  "2. NARZISSTISCHE MANIPULATIONSMUSTER (Psychologisches Profiling):",
  "   - Gaslighting: Werden Realitaeten der Fokus-Partei infrage gestellt?",
  "   - DARVO-Muster (Deny, Attack, Reverse Victim and Offender): Dreht sich der Taeter zum Opfer?",
  "   - Triangulation: Werden Dritte (Kinder, Behoerden, Therapeuten) instrumentalisiert?",
  "   - Isolation: Wird das Umfeld der Fokus-Partei systematisch gegen sie aufgehetzt?",
  "   - Flying Monkeys: Werden Familienmitglieder, Coaches, Therapeuten von der Gegenpartei 'angesteckt' und gegen die Fokus-Partei eingesetzt?",
  "   - Love Bombing / Intermittent Reinforcement in frueheren Dokumenten vs. spaetere Eskalation",
  "",
  "3. SYSTEM-ERKENNUNG (Netzwerk-Virus-Analyse):",
  "   - Erkenne Ketten: z.B. KESB → Beistaendin → Mediator → Gutachter → Kinderspital",
  "   - Wenn die Gegenpartei Behoerde A kontaktiert, und Behoerde A dann Stelle B kontaktiert,",
  "     und Stelle B dann die Fokus-Partei negativ beurteilt: Das ist ein SYSTEM-ALARM.",
  "   - Jede Weitergabe negativer Narrative ohne eigene Pruefung ist eine 'Virus-Uebertragung'.",
  "   - Erkenne ob Institutionen eigenstaendig pruefen oder nur voneinander abschreiben.",
  "",
  "4. WIDERSPRUCHS-CHECK:",
  "   - Interne Widersprueche im Dokument",
  "   - Abweichungen von juristischen Standard-Prozessen (ZPO, StGB, ZGB)",
  "   - Fakten werden in verschiedenen Abschnitten unterschiedlich dargestellt",
  "",
  "5. MANIPULATIVE SPRACHE & FRAMING:",
  "   - Suggestive Adjektive die das Gericht ohne Beweise negativ beeinflussen",
  "   - Ad-hominem statt Sachargumente",
  "   - Passivkonstruktionen die Verantwortung verschleiern",
  "   - Absolutaussagen ('immer', 'nie', 'offensichtlich') ohne Grundlage",
  "   - Emotionale Sprache in sachlichem Kontext",
  "",
  "6. FEHLENDE EVIDENZ:",
  "   - Behauptungen ohne Beleg oder Quelle",
  "   - Meinungen als Tatsachen dargestellt",
  "   - Falsch oder unvollstaendig zitierte Gesetze/BGE-Entscheide",
  "",
  "7. MEDIZINISCH-RECHTLICHE ANOMALIEN:",
  "   - Verschreibung starker Medikamente OHNE persoenlichen Patientenkontakt (Fernbehandlung per Chat/Telefon)?",
  "   - Behandlung durch fachfremde Institution (z.B. Kinderspital fuer Erwachsene, Psychiater ohne Fachgebiet)?",
  "   - Arzt hat Patient nie persoenlich untersucht, stellt aber Diagnose oder Rezept aus?",
  "   - Medikament oder Behandlung steht in keinem Zusammenhang mit dokumentierter Verletzung/Krankheit?",
  "   - Wer hat die Behandlung veranlasst? Wurde die Fokus-Partei informiert/einbezogen?",
  "   - Moegliche Verletzung des Heilmittelgesetzes oder der Standesordnung FMH?",
  "",
  "8. VERZOEGERUNGS- UND OBSTRUKTIONSMUSTER:",
  "   - Wird auf Meldungen, Antraege oder Beschwerden der Fokus-Partei NICHT geantwortet?",
  "   - Warnhinweise der Fokus-Partei ignoriert oder nicht aktenkundig gemacht?",
  "   - Auffaellige Zeitverzoegerungen: Antrag gestellt → Monate vergehen ohne Reaktion?",
  "   - Kind aeussert Wunsch (z.B. zum Vater zu wollen) → Behoerde reagiert nicht oder verzoegert?",
  "   - Systematisches Auf-Zeit-Spielen: Wird ein Verfahren kuenstlich in die Laenge gezogen?",
  "   - Merke dir JEDES Datum: Wann wurde etwas beantragt, wann wurde reagiert, wie lange dauerte es?",
  "",
  "9. GRUPPENBILDUNG UND KOORDINATION:",
  "   - Geben zwei oder mehr unabhaengige Akteure (z.B. Familienbegleiter + Beistand) die GLEICHE Empfehlung ab?",
  "   - Wenn ja: Haben sie eigene Abklaerungen gemacht oder uebernehmen sie blind voneinander?",
  "   - Absprachen zwischen Gegenpartei und Dritten (Familienmitglieder, Aerzte, Berater)?",
  "   - Familienmitglied der Gegenpartei (z.B. Bruder/Schwester) handelt GEGEN die Fokus-Partei?",
  "   - Koordinierte Aktionen: Mehrere Meldungen/Beschwerden zum gleichen Zeitpunkt?",
  "   - Identische Formulierungen in Schreiben verschiedener Verfasser = Abstimmung?",
  "",
  "10. RECHTMAESSIGKEITS-PRUEFUNG:",
  "   - Trenne klar: Was liegt im LEGALEN Rahmen und was ist RECHTSWIDRIG?",
  "   - Liste jede potentiell rechtswidrige Handlung explizit auf mit Rechtsgrundlage.",
  "   - Was hat der ANWALT der Fokus-Partei moeglicherweise uebersehen?",
  "   - Fristen versaeumt? Rechte nicht geltend gemacht? Beweise nicht gesichert?",
  "   - Pruefe: Handelt die Behoerde MIT oder OHNE rechtliche Grundlage/Verfuegung?",
  "",
  "11. MENSCHEN- UND KINDERRECHTE:",
  "   - Verletzung von EMRK Art. 8 (Recht auf Familienleben)?",
  "   - Verletzung von EMRK Art. 6 (Fair Trial / rechtliches Gehoer)?",
  "   - Missachtung UN-KRK Art. 3 (Kindeswohl als vorrangige Erwaegung)?",
  "   - Missachtung UN-KRK Art. 9 (Recht des Kindes auf beide Elternteile)?",
  "   - Missachtung UN-KRK Art. 12 (Recht des Kindes auf Anhoerung)?",
  "",
  "### AUSGABE-REGELN:",
  "- Sei praezise und nueChtern. Keine Spekulation, nur belegbare Feststellungen.",
  "- Jede Feststellung muss auf eine konkrete Textstelle verweisen.",
  "- Der Score spiegelt Gesamtrisiko fuer systematische Benachteiligung wider.",
  "- WICHTIG: Benenne klar WER manipuliert, WEN es trifft, und WELCHES MUSTER dahintersteckt.",
  "- Antworte ausschliesslich mit validem JSON gemaess dem folgenden Schema.",
  "",
  "### DATUMSFORMAT (PFLICHT):",
  "- Alle Datumsangaben MUESSEN im Format TT.MM.JJJJ zurueckgegeben werden.",
  "- Wenn nur 2-stellige Jahreszahl vorhanden (z.B. 24.06.23), zu 4-stellig konvertieren (24.06.2023).",
  "- Wenn kein Datum erkennbar oder ungueltig → gib '-' zurueck.",
  "",
  "### PERSONEN-EXTRAKTION (PFLICHT – STRIKTE REGELN):",
  "Das Array 'personen' ist AUSSCHLIESSLICH fuer echte menschliche Individuen reserviert.",
  "Lies das GESAMTE Dokument aufmerksam durch und merke dir ALLE Personennamen.",
  "Nutze dein semantisches Verstaendnis – extrahiere nicht einfach alle grossgeschriebenen Woerter.",
  "",
  "WAS GEHOERT IN 'personen'? → NUR echte Menschennamen:",
  "  Richtig: 'Max Muster', 'Ayhan Ergen', 'Dr. med. Brotzmann', 'Timur'",
  "",
  "WAS GEHOERT NICHT IN 'personen'? → ALLES was kein Mensch ist:",
  "  - Organisationen/Institutionen: UKBB, KESB, Gericht, Spital, Kinderspital,",
  "    Universitaets-Kinderspital, Kantonsgericht, Polizei, Sozialamt, Jugendamt",
  "  - Dokumenttypen: Medizinisches Rezept, Gutachten, Verfuegung, Bericht",
  "  - Fachbegriffe: Ergotherapie, Sozialkompetenztraining, Diagnose",
  "  - Generische Labels: Patient, Mutter, Vater (ohne konkreten Namen)",
  "  - Institutionen gehoeren in 'absender'/'herkunft', NIEMALS in 'personen'",
  "",
  "WENN KEINE echten Personennamen gefunden werden → personen-Array LEER lassen: []",
  "",
  "REGELN:",
  "- Namen koennen ueberall stehen: Absender, Anrede, Betreff, Textkörper, Unterschrift, Verteiler.",
  "- Kurzformen erkennen: 'Ruedi' = 'Rudolf', 'Roli' = 'Roland', 'Susi' = 'Susanne'.",
  "- Wenn nur ein Vorname erscheint (z.B. 'Timur'), trotzdem auffuehren.",
  "- Bestimme die Rolle aus dem Kontext: Vater, Mutter, Kind, Anwalt, Gutachter, Richter, etc.",
  "- BEMERKUNG (Pflichtfeld): Fasse in 1 Satz zusammen, was diese Person im Dokument KONKRET tut",
  "  oder was ueber sie gesagt wird. Fokus auf Handlungen GEGEN oder FUER die Fokus-Partei.",
  "  Beispiele: 'Verfasst negativen Bericht ueber Fokus-Partei', 'Ordnet Kontaktsperre an',",
  "  'Wird im Dokument als liebevoller Vater beschrieben', 'Empfaenger des Schreibens'.",
  "",
  "### JSON-SCHEMA (exakt einhalten):",
  "{",
  '  "score": <number 0-100>,',
  '  "risikoStufe": "<niedrig|mittel|hoch|kritisch>",',
  '  "personen": [',
  "    {",
  '      "name": "Vorname Nachname",',
  '      "rolle": "Funktion z.B. Berufsbeistand/Anwalt/Kind/Vater",',
  '      "sentiment": "positiv|negativ|neutral",',
  '      "bemerkung": "Was tut diese Person im Dokument? 1 Satz."',
  "    }",
  "  ],",
  '  "findings": [',
  "    {",
  '      "typ": "<widerspruch|manipulation|fehlende_evidenz|suggestive_sprache|framing|passivverschleierung|narzissmus_muster|system_vernetzung|benachteiligung|kinderrechte_verletzung|menschenrechte_verletzung|medizinische_anomalie|verzoegerung_obstruktion|gruppenbildung|rechtswidrigkeit|anwalt_versaeumnis>",',
  '      "stelle": "<woertliches Zitat oder Seitenreferenz aus dem Dokument>",',
  '      "analyse": "<forensische Erklaerung: WER manipuliert, WIE, WARUM ist es problematisch, WELCHES psychologische/juristische Muster>",',
  '      "schweregrad": "<niedrig|mittel|hoch|kritisch>"',
  "    }",
  "  ],",
  '  "statistik": {',
  '    "widersprueche": <number>,',
  '    "manipulationen": <number>,',
  '    "fehlende_belege": <number>,',
  '    "suggestive_formulierungen": <number>,',
  '    "narzissmus_muster": <number>,',
  '    "system_vernetzungen": <number>,',
  '    "rechte_verletzungen": <number>',
  "  },",
  '  "fazit": "<Zusammenfassung: Welche systemischen Muster sind erkennbar? Wer ist Fokus-Partei, wer manipuliert? Max 4 Saetze>"',
  "}",
  "",
  "NUR JSON. Kein Markdown. Kein zusaetzlicher Text. Keine Codeblocks."
].join("\n");

/**
 * Analysiert ein juristisches Dokument auf Manipulationen und Schwachstellen.
 *
 * @param {string} textContent – Extrahierter Text des Dokuments
 * @param {Object} [options]
 * @param {string} [options.documentTitle] – Titel des Dokuments (fuer Kontext)
 * @param {string} [options.documentType] – Typ (Gutachten, Schriftsatz, Verfuegung, etc.)
 * @returns {Promise<Object>} Strukturiertes Analyse-Ergebnis
 */
async function analyzeLegalDocument(textContent, options = {}) {
  if (!textContent || typeof textContent !== "string" || !textContent.trim()) {
    return {
      score: 0,
      risikoStufe: "niedrig",
      findings: [],
      statistik: {
        widersprueche: 0,
        manipulationen: 0,
        fehlende_belege: 0,
        suggestive_formulierungen: 0
      },
      fazit: "Kein analysierbarer Text vorhanden.",
      status: "empty"
    };
  }

  const maxChars = 80000;
  const trimmedText = textContent.length <= maxChars
    ? textContent
    : `${textContent.slice(0, 50000)}\n\n[... gekuerzt ...]\n\n${textContent.slice(-30000)}`;

  const userMessage = [
    options.documentTitle ? `Dokumenttitel: ${options.documentTitle}` : "",
    options.documentType ? `Dokumenttyp: ${options.documentType}` : "",
    "",
    "DOKUMENT ZUR FORENSISCHEN ANALYSE:",
    trimmedText
  ].filter(Boolean).join("\n");

  try {
    const anthropic = getClient();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userMessage }
      ]
    });

    const raw = response?.content?.[0]?.text || "";
    const parsed = extractJson(raw);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Claude-Antwort konnte nicht als JSON geparst werden.");
    }

    return {
      score: clamp(Number(parsed.score) || 0, 0, 100),
      risikoStufe: validateRisikoStufe(parsed.risikoStufe),
      personen: Array.isArray(parsed.personen)
        ? parsed.personen
            .filter((p) => p && typeof p === "object" && isHumanName(p.name))
            .map((p) => ({
              name: (p.name || "").trim(),
              rolle: (p.rolle || "").trim(),
              sentiment: (p.sentiment || "neutral").trim(),
              bemerkung: (p.bemerkung || "").trim()
            }))
        : [],
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map(normalizeFinding)
        : [],
      statistik: {
        widersprueche: Math.max(0, Number(parsed.statistik?.widersprueche) || 0),
        manipulationen: Math.max(0, Number(parsed.statistik?.manipulationen) || 0),
        fehlende_belege: Math.max(0, Number(parsed.statistik?.fehlende_belege) || 0),
        suggestive_formulierungen: Math.max(0, Number(parsed.statistik?.suggestive_formulierungen) || 0)
      },
      fazit: String(parsed.fazit || "Keine Zusammenfassung generiert."),
      status: "ok"
    };
  } catch (error) {
    console.error("[analysisService] Fehler:", error.message);

    if (error.status === 429) {
      return {
        score: 0,
        risikoStufe: "niedrig",
        findings: [],
        statistik: { widersprueche: 0, manipulationen: 0, fehlende_belege: 0, suggestive_formulierungen: 0 },
        fazit: "Rate-Limit erreicht. Bitte spaeter erneut versuchen.",
        status: "rate-limited"
      };
    }

    return {
      score: 0,
      risikoStufe: "niedrig",
      findings: [],
      statistik: { widersprueche: 0, manipulationen: 0, fehlende_belege: 0, suggestive_formulierungen: 0 },
      fazit: `Analysefehler: ${error.message}`,
      status: "error"
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractJson(text) {
  const trimmed = text.trim();

  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch (_) { /* continue */ }

  // Strip markdown code fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) { /* continue */ }
  }

  // Find first { ... last }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (_) { /* continue */ }
  }

  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const VALID_RISIKO = new Set(["niedrig", "mittel", "hoch", "kritisch"]);
function validateRisikoStufe(value) {
  const normalized = String(value || "").toLowerCase().trim();
  return VALID_RISIKO.has(normalized) ? normalized : "niedrig";
}

const VALID_TYP = new Set([
  "widerspruch", "manipulation", "fehlende_evidenz",
  "suggestive_sprache", "framing", "passivverschleierung"
]);
function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;
  const typ = String(f.typ || "").toLowerCase().trim();
  return {
    typ: VALID_TYP.has(typ) ? typ : "manipulation",
    stelle: String(f.stelle || "–"),
    analyse: String(f.analyse || "–"),
    schweregrad: validateRisikoStufe(f.schweregrad)
  };
}

// ── Person name validation (server-side) ────────────────────────────

const BLOCKED_ORG_PATTERNS = [
  /\bukbb\b/i, /\bkesb\b/i, /\bgericht\b/i, /\bspital\b/i, /\bkinderspital\b/i,
  /\bpolizei\b/i, /\bkantonsgericht\b/i, /\bbezirksgericht\b/i, /\bbundesgericht\b/i,
  /\bsozialamt\b/i, /\bjugendamt\b/i, /\bsozialdienst\b/i, /\bkindesschutz\b/i,
  /\bstaatsanwaltschaft\b/i, /\bschule\b/i, /\bklinik\b/i, /\bpraxis\b/i,
  /\buniversit[äa]t/i, /\binstitut\b/i, /\bamt\b/i, /\bbeh[öo]rde\b/i,
  /\bstiftung\b/i, /\bverein\b/i, /\bverband\b/i, /\bversicherung\b/i,
  /\bmedizinisch\w*\s+(rezept|bericht|gutachten|dokument)/i,
  /\bergotherapie\b/i, /\bsozialkompetenz/i, /\bdiagnose\b/i,
  /\brezept\b/i, /\bgutachten\b/i, /\bverf[üu]gung\b/i, /\bprotokoll\b/i,
  /\bstellungnahme\b/i, /\bbericht\b/i, /\bdokument\b/i,
  /\bbehandlung\b/i, /\btherapie\b/i, /\btraining\b/i,
  /\bGmbH\b/i, /\bAG\b/i, /\bSA\b/i, /\bGmbH\b/i,
];

function isHumanName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed === "-") return false;
  if (BLOCKED_ORG_PATTERNS.some(p => p.test(trimmed))) return false;
  // Must contain at least one letter
  if (!/[a-zA-ZäöüÄÖÜàáâèéêìíîòóôùúû]/.test(trimmed)) return false;
  // Block entries with digits (not names)
  if (/\d/.test(trimmed)) return false;
  return true;
}

/**
 * Normalizes date strings to DD.MM.YYYY format.
 * Handles 2-digit years (24.06.23 → 24.06.2023).
 */
function normalizeDateField(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return "-";

  // DD.MM.YYYY — already correct
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;

  // DD.MM.YY — convert to 4-digit year
  const twoDigitYear = raw.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (twoDigitYear) {
    const yy = Number(twoDigitYear[3]);
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy;
    return `${twoDigitYear[1]}.${twoDigitYear[2]}.${yyyy}`;
  }

  // YYYY-MM-DD (ISO) → DD.MM.YYYY
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;

  // D.M.YYYY or DD.M.YYYY etc — normalize padding
  const loose = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (loose) {
    const d = loose[1].padStart(2, "0");
    const m = loose[2].padStart(2, "0");
    let y = loose[3];
    if (y.length === 2) {
      const yy = Number(y);
      y = String(yy >= 50 ? 1900 + yy : 2000 + yy);
    }
    return `${d}.${m}.${y}`;
  }

  return "-";
}

// ── Cross-document dossier analysis ─────────────────────────────────

const CROSS_DOC_SYSTEM_PROMPT = [
  "Du bist ein forensischer Psycho-Profiler und System-Analyst fuer DMSKI.ch.",
  "Du erhaeltst Zusammenfassungen und Schluesselpassagen aus MEHREREN Dokumenten eines Gerichtsdossiers.",
  "",
  "DEIN PROFIL: Forensische Psychologie (Narzissmus, Cluster-B, systemische Gewalt),",
  "Schweizer Familienrecht (ZGB, ZPO), Menschenrechte (EMRK), Kinderrechte (UN-KRK).",
  "",
  "DEIN AUFTRAG: Finde SYSTEMISCHE ZERSTOERUNGSMUSTER, die erst durch den Vergleich ALLER Dokumente sichtbar werden.",
  "Du denkst wie ein Profiler: Nicht einzelne Worte zaehlen, sondern das GESAMTBILD, die VERNETZUNG, das SYSTEM.",
  "",
  "### ANALYSE-SCHWERPUNKTE (nach Prioritaet):",
  "",
  "1. NETZWERK-VIRUS-ANALYSE (HOECHSTE PRIORITAET):",
  "   - Erkenne KETTEN: z.B. Gegenpartei kontaktiert KESB → KESB setzt Beistaendin ein →",
  "     Beistaendin kontaktiert Mediator → Mediator kontaktiert Kinderspital → alle uebernehmen",
  "     die Negativdarstellung OHNE eigenstaendige Pruefung.",
  "   - Dieses Muster heisst 'System-Infektion': Ein negatives Narrativ wird wie ein Virus",
  "     von Institution zu Institution weitergegeben.",
  "   - JEDE Kontaktkette zwischen Dokumenten/Verfassern ist ein potentielles Netzwerk.",
  "   - Erstelle eine NETZWERKKARTE: Wer hat wen kontaktiert? Wer hat welche Behauptung uebernommen?",
  "   - Wenn das Umfeld der Fokus-Partei (Familie, Coaches, Therapeuten) ploetzlich gegen sie",
  "     agiert: Das ist FLYING MONKEYS – ein narzisstisches Manipulationsmuster.",
  "",
  "2. NARZISSTISCHE ZERSTOERUNGSSTRATEGIE:",
  "   - DARVO (Deny, Attack, Reverse Victim and Offender): Dreht sich der Taeter zum Opfer?",
  "   - Gaslighting ueber Dokumente: Wird die Realitaet der Fokus-Partei sukzessive umgeschrieben?",
  "   - Triangulation: Werden Kinder, Behoerden, Therapeuten als Werkzeuge eingesetzt?",
  "   - Isolation: Wird das Stuetzsystem der Fokus-Partei systematisch zerstoert?",
  "     (Bruder wird manipuliert, Coach wird kontaktiert und umgedreht, Freunde werden beeinflusst)",
  "   - Smear Campaign: Wird die Fokus-Partei bei Dritten systematisch schlecht gemacht?",
  "",
  "3. INSTITUTIONELLE ZERSTOERUNGSMUSTER:",
  "   - Wiederholte Polizeianzeigen, KESB-Meldungen, Gefaehrdungsmeldungen",
  "   - AUCH WENN nichts festgestellt wird: Die HAEUFUNG allein ist Zerstoerung",
  "   - Jeder Polizeieinsatz hinterlaesst Datenbankeintraege die bei Gericht schaden",
  "   - Erkenne: Wer hat diese Meldungen ausgeloest? Gibt es ein Muster?",
  "",
  "4. CHRONOLOGISCHE WIDERSPRUECHE:",
  "   - Person X 2021 'zu locker' → 2023 'macht zu viel Druck' = willkuerlich",
  "   - Vorwuerfe werden schwerer ohne neue Beweise = Eskalation",
  "   - Alte, widerlegte Behauptungen tauchen in spaeten Dokumenten wieder auf",
  "",
  "5. SYSTEMATISCHE BENACHTEILIGUNG:",
  "   - Wird die Fokus-Partei in ALLEN Dokumenten negativ dargestellt?",
  "   - Wird die Gegenpartei durchgehend geschuetzt oder positiv geframed?",
  "   - Fehlen entlastende Fakten der Fokus-Partei in spaeten Dokumenten?",
  "   - Koordinierte Strategie zwischen verschiedenen Verfassern?",
  "",
  "6. KINDER- UND MENSCHENRECHTE:",
  "   - EMRK Art. 8 (Familienleben) ueber Dokumente hinweg verletzt?",
  "   - EMRK Art. 6 (Fair Trial) – wurde die Fokus-Partei angehoert?",
  "   - UN-KRK Art. 3 (Kindeswohl) – wird Kindeswohl instrumentalisiert?",
  "   - UN-KRK Art. 9 (Recht auf beide Elternteile) – systematisch untergraben?",
  "   - UN-KRK Art. 12 (Anhoerung des Kindes) – wird Kind angehoert oder ueberstimmt?",
  "",
  "7. CHRONOLOGISCHE DOSSIER-REKONSTRUKTION (ZEITSTRAHL-ANALYSE):",
  "   - Rekonstruiere den gesamten Ablauf CHRONOLOGISCH ueber alle Dokumente hinweg.",
  "   - Erstelle eine unsichtbare Timeline: Wann passierte was? Welche Luecken gibt es?",
  "   - VERZOEGERUNGSMUSTER: Kind aeussert Wunsch (z.B. zum Vater) → Was passiert danach?",
  "     Wie reagiert die Behoerde? Wird auf Zeit gespielt, um den Fall zu kaschieren/manipulieren?",
  "   - IGNORIERTE WARNHINWEISE: Fokus-Partei schreibt Meldung/Beschwerde → Wird diese beantwortet?",
  "     Gibt es in den Akten eine Antwort darauf? Oder wird systematisch ignoriert?",
  "   - SELEKTIVE KOMMUNIKATION: Wird nur eine Partei angehoert? Fehlen Stellungnahmen der Fokus-Partei?",
  "   - Jede unbeantwortete Meldung, jede ignorierte Warnung ist ein BEFUND.",
  "",
  "8. MEDIZINISCH-RECHTLICHE ANOMALIEN (DOKUMENTUEBERGREIFEND):",
  "   - Verschreibungen ohne persoenlichen Kontakt (Fernbehandlung per Chat/Telefon)?",
  "   - Behandlung durch fachfremde/falsche Institution (z.B. Kinderspital fuer Erwachsene)?",
  "   - Wer hat die Behandlung veranlasst? War es die Gegenpartei oder ein Dritter?",
  "   - Medikament passt nicht zur dokumentierten Verletzung/Diagnose?",
  "   - Steht ein Familienmitglied der Gegenpartei in medizinischer Funktion → INTERESSENKONFLIKT?",
  "   - Moegliche Verletzungen: Heilmittelgesetz, Standesordnung FMH, Patientenrechte.",
  "",
  "9. GRUPPENBILDUNG UND KOORDINIERTE AKTIONEN:",
  "   - Geben UNABHAENGIGE Akteure (z.B. Familienbegleiter + Beistand) die GLEICHE Empfehlung ab?",
  "   - Wenn ja: Haben sie EIGENSTAENDIG geprueft oder blind voneinander uebernommen?",
  "   - Identische Formulierungen in verschiedenen Dokumenten = Abstimmung/Absprache.",
  "   - Familienmitglieder der Gegenpartei handeln gegen Fokus-Partei (z.B. Bruder stellt Rezept aus,",
  "     Schwester macht Meldung, Cousin gibt Zeugenaussage) → FAMILIAERE GRUPPENBILDUNG.",
  "   - Koordinierte Meldungen/Beschwerden zum selben Zeitpunkt von verschiedenen Personen.",
  "   - JEDE Gruppenbildung gegen Fokus-Partei kann rechtswidrig sein → klar benennen.",
  "",
  "10. RECHTMAESSIGKEITS-ANALYSE (LEGAL vs. RECHTSWIDRIG):",
  "   - Pruefe JEDE Handlung: Liegt sie im legalen Rahmen oder ist sie rechtswidrig?",
  "   - Liste alle potentiell rechtswidrigen Handlungen mit Rechtsgrundlage auf.",
  "   - Handelt eine Behoerde OHNE Verfuegung/Rechtsgrundlage?",
  "   - Was hat der ANWALT der Fokus-Partei moeglicherweise uebersehen?",
  "   - Fristen versaeumt, Rechte nicht geltend gemacht, Beweise nicht gesichert?",
  "   - PEER-REVIEW-PERSPEKTIVE: Wuerde ein erfahrener Richter oder Professor zum",
  "     selben Schluss kommen wie die Verfasser der Dokumente? Wenn NEIN → kritischer Befund.",
  "",
  "11. DMSKI-CHECKLISTE – MANIPULATIONSMUSTER (ueber alle Dokumente hinweg):",
  "   Erkenne folgende 10 Indikatoren DOKUMENTUEBERGREIFEND. Suche Muster die sich wiederholen:",
  "   1. GASLIGHTING: Wiederholtes Verdrehen von Fakten ueber mehrere Dokumente hinweg",
  "   2. PROJEKTION: Konsistente Taeter-Opfer-Umkehr durch die Gegenpartei",
  "   3. ISOLATIONSTAKTIK: Systematische Trennung der Fokus-Partei von Unterstuetzern",
  "   4. MACHTMISSBRAUCH_GELD: Finanzielle Manipulation oder Kontrolle",
  "   5. TRIANGULATION: Wiederkehrende Einbeziehung Dritter als Druckmittel",
  "   6. AD_HOMINEM: Systematische Charakterangriffe statt Sachargumente",
  "   7. EMPATHIELOSIGKEIT: Durchgehend kuehle Sprache ueber Kinder/Familie",
  "   8. SABOTAGE: Wiederholtes Blockieren von Massnahmen oder Vereinbarungen",
  "   9. ABSOLUTE_SPRACHE: Haeufung von 'immer'/'nie'/'voellig' ueber Dokumente",
  "   10. WORTSALAT: Wiederkehrende ablenkende Formulierungen",
  "   Fuer jeden erkannten Indikator: Typ, betroffene Dokumente, Belege, Schweregrad.",
  "",
  "### AUSGABE-FORMAT:",
  "Antworte AUSSCHLIESSLICH mit validem JSON gemaess diesem Schema:",
  "{",
  '  "crossDocScore": <number 0-100>,',
  '  "gesamtRisiko": "<niedrig|mittel|hoch|kritisch>",',
  '  "widersprueche": [',
  "    {",
  '      "dokument_a": "<Dateiname + Datum>",',
  '      "aussage_a": "<woertliches Zitat oder Paraphrase>",',
  '      "dokument_b": "<Dateiname + Datum>",',
  '      "aussage_b": "<woertliches Zitat oder Paraphrase>",',
  '      "analyse": "<Warum ist das ein Widerspruch? Welches SYSTEM-MUSTER steckt dahinter?>",',
  '      "schweregrad": "<niedrig|mittel|hoch|kritisch>"',
  "    }",
  "  ],",
  '  "muster": [',
  "    {",
  '      "typ": "<systematische_negativdarstellung|eskalation|koordination|fehlende_gegendarstellung|instrumentalisierung_kinder|netzwerk_infektion|flying_monkeys|darvo|gaslighting|isolation|smear_campaign|institutionelle_zerstoerung|rechte_verletzung|projektion|isolationstaktik|machtmissbrauch_geld|triangulation|ad_hominem|empathielosigkeit|sabotage|absolute_sprache|wortsalat|medizinische_anomalie|verzoegerung_obstruktion|gruppenbildung|rechtswidrigkeit|anwalt_versaeumnis|ignorierte_meldung|peer_review_abweichung>",',
  '      "betroffene_dokumente": ["<Dateiname>"],',
  '      "analyse": "<Beschreibung: WER macht WAS gegen WEN? Welche psychologische Strategie? Welche Vernetzung?>",',
  '      "schweregrad": "<niedrig|mittel|hoch|kritisch>"',
  "    }",
  "  ],",
  '  "netzwerk": [',
  "    {",
  '      "von": "<Person/Institution die kontaktiert>",',
  '      "zu": "<Person/Institution die kontaktiert wird>",',
  '      "narrativ": "<Welches negative Narrativ wird uebertragen?>",',
  '      "dokument": "<In welchem Dokument ist das sichtbar?>"',
  "    }",
  "  ],",
  '  "fazit": "<Profiler-Zusammenfassung: Gesamtbild des systemischen Musters. Max 5 Saetze>",',
  '  "gesamtfallAnalyse": "<PFLICHTFELD. Du bist Professor fuer Schweizer Recht. Schreibe eine sachliche, kompakte Gesamtfall-Analyse (15-25 Saetze), die ein Richter lesen koennte. Struktur: (1) Was will die Fokus-Partei? (2) Was macht die Gegenpartei, um das zu verhindern? (3) Welche Methoden werden eingesetzt? (Behörden-Manipulation, Instrumentalisierung von Kindern/Personen/Institutionen, Diskreditierung, Anschwärzung, Angstmacherei durch Polizei-Reports, absurde Tatsachenbehauptungen, Verneblung des Gerichts). (4) Unstimmigkeiten: Schreibt ein Beistand einmal so und ein anderes Mal anders? Will sich ein Arzt nicht erinnern? Handelt eine Behoerde ohne Indiz/Beweis? Hoert man nur eine Partei? (5) Psychologische Einordnung: Hinweise auf manipulatives Verhaltensmuster (z.B. Gutachten abgelehnt = verdaechtig, Verstecken, Kontrollverhalten, fehlende Empathie, Instrumentalisierung Dritter). WICHTIG: Legal korrekt formulieren – beschreibe VERHALTENSMUSTER, keine klinischen Diagnosen. (6) Verzoegerungen und Obstruktion: Wo wird auf Zeit gespielt? Welche Meldungen wurden ignoriert? (7) Medizinisch-rechtliche Anomalien: Fernbehandlungen, fachfremde Institutionen, Rezepte ohne Kontakt. (8) Gruppenbildung: Wer koordiniert sich gegen die Fokus-Partei? Gleiche Empfehlungen ohne eigene Pruefung? (9) Anwalts-Blindstellen: Was wurde uebersehen, nicht eingefordert, nicht gerügt? (10) PEER-REVIEW: Wuerde ein erfahrener Richter/Professor zum selben Ergebnis kommen? Wenn nein, warum nicht? Schreibe faktenbasiert, direkt, auf den Punkt.>"',
  "}",
  "",
  "NUR JSON. Kein Markdown. Kein zusaetzlicher Text."
].join("\n");

/**
 * Analysiert ein ganzes Dossier auf dokumentuebergreifende Widersprueche und Muster.
 *
 * @param {Array<{fileName: string, text: string, date?: string, forensic?: Object}>} documents
 * @returns {Promise<Object>} Cross-document analysis
 */
async function analyzeDossierCrossDocument(documents) {
  if (!Array.isArray(documents) || documents.length < 2) {
    return {
      crossDocScore: 0,
      gesamtRisiko: "niedrig",
      widersprueche: [],
      muster: [],
      fazit: "Fuer eine dokumentuebergreifende Analyse werden mindestens 2 Dokumente benoetigt.",
      status: "insufficient"
    };
  }

  // Build document summaries for Claude (limit total to ~60k chars)
  const maxPerDoc = Math.min(8000, Math.floor(60000 / documents.length));
  const docSummaries = documents.map((doc, i) => {
    const text = String(doc.text || "");
    const snippet = text.length <= maxPerDoc
      ? text
      : `${text.slice(0, Math.floor(maxPerDoc * 0.6))}\n[...]\n${text.slice(-Math.floor(maxPerDoc * 0.4))}`;

    const header = [
      `═══ DOKUMENT ${i + 1}: ${doc.fileName || "Unbenannt"} ═══`,
      doc.date ? `Datum: ${doc.date}` : "",
      doc.forensic?.fazit ? `Einzelanalyse-Fazit: ${doc.forensic.fazit}` : "",
      doc.forensic?.score != null ? `Manipulations-Score: ${doc.forensic.score}/100` : "",
      ""
    ].filter(Boolean).join("\n");

    return header + snippet;
  }).join("\n\n");

  const userMessage = [
    `DOSSIER MIT ${documents.length} DOKUMENTEN ZUR KREUZANALYSE:`,
    "",
    docSummaries
  ].join("\n");

  try {
    const anthropic = getClient();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      temperature: 0,
      system: CROSS_DOC_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }]
    });

    const raw = response?.content?.[0]?.text || "";
    const parsed = extractJson(raw);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Claude cross-doc Antwort konnte nicht geparst werden.");
    }

    return {
      crossDocScore: clamp(Number(parsed.crossDocScore) || 0, 0, 100),
      gesamtRisiko: validateRisikoStufe(parsed.gesamtRisiko),
      widersprueche: Array.isArray(parsed.widersprueche)
        ? parsed.widersprueche.map(w => ({
            dokument_a: String(w.dokument_a || "–"),
            aussage_a: String(w.aussage_a || "–"),
            dokument_b: String(w.dokument_b || "–"),
            aussage_b: String(w.aussage_b || "–"),
            analyse: String(w.analyse || "–"),
            schweregrad: validateRisikoStufe(w.schweregrad)
          }))
        : [],
      muster: Array.isArray(parsed.muster)
        ? parsed.muster.map(m => ({
            typ: String(m.typ || ""),
            betroffene_dokumente: Array.isArray(m.betroffene_dokumente) ? m.betroffene_dokumente : [],
            analyse: String(m.analyse || "–"),
            schweregrad: validateRisikoStufe(m.schweregrad)
          }))
        : [],
      fazit: String(parsed.fazit || "Keine Zusammenfassung."),
      gesamtfallAnalyse: String(parsed.gesamtfallAnalyse || ""),
      status: "ok"
    };
  } catch (error) {
    console.error("[analysisService] Cross-doc Fehler:", error.message);
    return {
      crossDocScore: 0,
      gesamtRisiko: "niedrig",
      widersprueche: [],
      muster: [],
      fazit: `Analysefehler: ${error.message}`,
      status: "error"
    };
  }
}

/**
 * consolidatePersons – KI-gestützte Personenkonsolidierung über alle Dokumente
 *
 * Nimmt alle extrahierten Personen aus allen Dokumentanalysen eines Falls,
 * lässt Claude Vornamen+Nachnamen zusammenführen, Funktionen erkennen
 * und Duplikate eliminieren.
 */
async function consolidatePersons(rawPersons, protectedPerson, opposingParty) {
  const anthropic = getClient();

  const personList = rawPersons.map((p, i) =>
    `${i + 1}. Name: "${p.name}" | Funktion: "${p.affiliation || ""}" | Bemerkung: "${p.bemerkung || ""}" | Quelle: File ${p.sourceFileIndex || "?"}`
  ).join("\n");

  const systemPrompt = [
    "Du bist ein forensischer Datenanalyst für DMSKI.ch.",
    "Deine Aufgabe: Personenlisten aus mehreren Dokumenten konsolidieren und bereinigen.",
    "",
    "STRIKTE NAMENSREGELN:",
    "1. Spalte 'name' enthält NUR echte menschliche Namen: Vorname + Nachname",
    "2. KEINE Spitznamen, Kosewörter oder Rollen als Name: 'Papi', 'Mami', 'Kind 1', 'Tante' → LÖSCHEN oder durch echten Namen ersetzen falls bekannt",
    "3. KEINE Organisationen, Behörden, Firmen als Personenname: 'KESB', 'Gericht', 'Jugendamt' → LÖSCHEN (gehören in affiliation/bemerkung)",
    "4. Titel VOR den Namen setzen: 'Dr. Joachim Schreiner', 'Prof. Dr. Hans Müller', 'lic. iur. Anna Meier'",
    "5. Wenn nur Vorname vorhanden ('Ayhan'), suche den Nachnamen in anderen Einträgen und vervollständige ('Ayhan Ergen')",
    "6. Wenn nur Nachname vorhanden ('Kiss'), suche den Vornamen in anderen Einträgen und vervollständige ('Dr. Peter Kiss')",
    "7. Tippfehler in Namen korrigieren",
    "8. Duplikate zusammenführen: gleiche Person mit unterschiedlicher Schreibweise → besten/vollständigsten Namen wählen",
    "",
    "FUNKTION (affiliation):",
    "9. Erkenne die korrekte Funktion/Rolle: Anwalt, Richterin, Beiständin, Therapeut, Kindsmutter, Kindsvater, etc.",
    "10. Wenn Firma/Behörde bekannt: in affiliation integrieren, z.B. 'Beiständin (KESB Zürich)', 'Anwalt (Kanzlei Müller AG)'",
    "11. Wenn unklar: 'Privatperson'",
    "",
    "BEMERKUNG:",
    "12. 1 Satz: Was macht diese Person im Dossier? Warum ist sie relevant?",
    "13. Wenn KI etwas Auffälliges/Wichtiges über die Person findet (z.B. Widersprüche, Befangenheit, Doppelrolle), hier erwähnen",
    "",
    "AUFRÄUMEN:",
    "14. Einträge die KEIN echter Personenname sind → komplett löschen",
    "15. Nur echte, identifizierbare Personen behalten",
    "",
    `Fokus-Partei (benachteiligt): ${protectedPerson || "unbekannt"}`,
    `Gegenpartei: ${opposingParty || "unbekannt"}`,
    "",
    "Antworte NUR mit einem JSON-Array. Kein Markdown, kein Text davor/danach.",
    "Format: [{\"name\": \"Titel Vorname Nachname\", \"affiliation\": \"Funktion (Organisation)\", \"bemerkung\": \"Kurzbeschreibung der Relevanz\"}]"
  ].join("\n");

  const userMessage = `Hier sind ${rawPersons.length} Personen-Einträge aus ${new Set(rawPersons.map(p => p.sourceFileIndex)).size} Dokumenten:\n\n${personList}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }]
    });

    const text = (response.content?.[0]?.text || "").trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[consolidatePersons] No JSON array in response:", text.slice(0, 200));
      return { status: "error", error: "KI-Antwort enthielt kein gültiges JSON." };
    }

    const consolidated = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(consolidated)) {
      return { status: "error", error: "KI-Antwort war kein Array." };
    }

    return {
      status: "ok",
      persons: consolidated.map(p => ({
        name: String(p.name || "").trim(),
        affiliation: String(p.affiliation || "Privatperson").trim(),
        bemerkung: String(p.bemerkung || "").trim()
      })).filter(p => p.name.length > 1)
    };
  } catch (error) {
    console.error("[consolidatePersons] Fehler:", error.message);
    return { status: "error", error: error.message };
  }
}

module.exports = { analyzeLegalDocument, analyzeDossierCrossDocument, consolidatePersons };
