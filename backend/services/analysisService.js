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
  "7. MENSCHEN- UND KINDERRECHTE:",
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
  "### JSON-SCHEMA (exakt einhalten):",
  "{",
  '  "score": <number 0-100>,',
  '  "risikoStufe": "<niedrig|mittel|hoch|kritisch>",',
  '  "findings": [',
  "    {",
  '      "typ": "<widerspruch|manipulation|fehlende_evidenz|suggestive_sprache|framing|passivverschleierung|narzissmus_muster|system_vernetzung|benachteiligung|kinderrechte_verletzung|menschenrechte_verletzung>",',
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
  '      "typ": "<systematische_negativdarstellung|eskalation|koordination|fehlende_gegendarstellung|instrumentalisierung_kinder|netzwerk_infektion|flying_monkeys|darvo|gaslighting|isolation|smear_campaign|institutionelle_zerstoerung|rechte_verletzung>",',
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
  '  "fazit": "<Profiler-Zusammenfassung: Gesamtbild des systemischen Musters. Max 5 Saetze>"',
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
      max_tokens: 4096,
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

module.exports = { analyzeLegalDocument, analyzeDossierCrossDocument };
