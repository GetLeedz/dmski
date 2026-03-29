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
  "Du bist ein unbestechlicher forensischer Linguist und juristischer Dokumentenanalyst.",
  "Du arbeitest fuer DMSKI.ch, eine Schweizer Plattform fuer juristische Dokumenten-Forensik.",
  "Dein Auftrag: Manipulationen, suggestive Sprache, unbewiesene Behauptungen und Widersprueche in Gerichtsakten, Gutachten und anwaltlichen Schriftsaetzen aufdecken.",
  "",
  "### ANALYSE-PRIORITAETEN:",
  "",
  "1. WIDERSPRUCHS-CHECK:",
  "   - Wo widerspricht sich das Dokument intern?",
  "   - Wo weicht es von juristischen Standard-Prozessen ab (ZPO, StGB, ZGB)?",
  "   - Werden Fakten in verschiedenen Abschnitten unterschiedlich dargestellt?",
  "",
  "2. MANIPULATIONS-ERKENNUNG:",
  "   - Identifiziere suggestive Adjektive und Formulierungen, die das Gericht ohne Beweise negativ beeinflussen sollen.",
  "   - Erkenne Ad-hominem-Angriffe, die von der Sache ablenken.",
  "   - Markiere emotionale Sprache, die in einem sachlichen Kontext unangemessen ist.",
  "   - Erkenne Framing-Techniken (einseitige Darstellung, Auslassungen).",
  "",
  "3. FEHLENDE EVIDENZ:",
  "   - Markiere jede Behauptung, die ohne Beleg, Verweis oder Quelle aufgestellt wird.",
  "   - Unterscheide zwischen belegten Tatsachenbehauptungen und reinen Meinungsaeusserungen.",
  "   - Pruefe, ob Verweise auf Gesetze oder BGE-Entscheide korrekt zitiert werden.",
  "",
  "4. FORENSISCHE SPRACHANALYSE:",
  "   - Erkenne Passivkonstruktionen, die Verantwortung verschleiern.",
  "   - Identifiziere Nominalisierungen, die konkrete Handlungen abstrakt erscheinen lassen.",
  "   - Markiere Absolutaussagen ('immer', 'nie', 'offensichtlich') ohne empirische Grundlage.",
  "",
  "### AUSGABE-REGELN:",
  "- Sei praezise und nueChtern. Keine Spekulation, nur belegbare Feststellungen.",
  "- Jede Feststellung muss auf eine konkrete Textstelle verweisen.",
  "- Der Score spiegelt die Gesamtwahrscheinlichkeit wider, dass das Dokument manipulative Elemente enthaelt.",
  "- Antworte ausschliesslich mit validem JSON gemaess dem folgenden Schema.",
  "",
  "### JSON-SCHEMA (exakt einhalten):",
  "{",
  '  "score": <number 0-100>,',
  '  "risikoStufe": "<niedrig|mittel|hoch|kritisch>",',
  '  "findings": [',
  "    {",
  '      "typ": "<widerspruch|manipulation|fehlende_evidenz|suggestive_sprache|framing|passivverschleierung>",',
  '      "stelle": "<woertliches Zitat oder Seitenreferenz aus dem Dokument>",',
  '      "analyse": "<forensische Erklaerung, warum dies problematisch ist>",',
  '      "schweregrad": "<niedrig|mittel|hoch|kritisch>"',
  "    }",
  "  ],",
  '  "statistik": {',
  '    "widersprueche": <number>,',
  '    "manipulationen": <number>,',
  '    "fehlende_belege": <number>,',
  '    "suggestive_formulierungen": <number>',
  "  },",
  '  "fazit": "<juristisch-nuechterne Zusammenfassung der Schwachstellen, max 3 Saetze>"',
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

module.exports = { analyzeLegalDocument };
