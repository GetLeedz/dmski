const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { Pool } = require("pg");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function decodeOriginalFileName(name) {
  const value = String(name || "");
  try {
    const decoded = Buffer.from(value, "latin1").toString("utf8");
    if (!decoded.includes("\uFFFD")) {
      return decoded;
    }
  } catch {
    // Fall back to original value.
  }
  return value;
}

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) {
    return rawUrl;
  }

  const trimmed = String(rawUrl)
    .trim()
    .replace(/^['\"]|['\"]$/g, "")
    .replace(/\s+/g, "");

  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    const match = trimmed.match(/^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@([^/]+)\/(.+)$/i);
    if (!match) {
      return trimmed;
    }

    const [, protocol, user, password, host, dbPath] = match;
    return `${protocol}${user}:${encodeURIComponent(password)}@${host}/${dbPath}`;
  }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const decodedName = decodeOriginalFileName(file.originalname);
    const safeName = decodedName.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(new Error("Nur PDF, JPG, JPEG, PNG erlaubt."));
      return;
    }
    cb(null, true);
  }
});

let openAiClient = null;
let pdfParseFn;
let pdfParseLoadLogged = false;

function getPdfParse() {
  if (pdfParseFn !== undefined) {
    return pdfParseFn;
  }

  try {
    const mod = require("pdf-parse");
    pdfParseFn = (typeof mod === "function") ? mod : (mod?.default || null);
  } catch (err) {
    pdfParseFn = null;
    if (!pdfParseLoadLogged) {
      console.error("PDF parser unavailable:", err.message);
      pdfParseLoadLogged = true;
    }
  }

  return pdfParseFn;
}

function getOpenAiClient() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    return null;
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({ apiKey: key });
  }

  return openAiClient;
}

function extractTitleFromText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 4 || line.length > 180) {
      continue;
    }

    if (!/[\p{L}]/u.test(line)) {
      continue;
    }

    if (/^seite\s+\d+$/i.test(line)) {
      continue;
    }

    return line;
  }

  return "";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikePersonName(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return false;
  }

  const cleaned = text.replace(/[.,;:!?()\[\]"']/g, "");
  const forbidden = [
    "strasse",
    "straße",
    "assekuranz",
    "mail",
    "telefon",
    "tel",
    "fax",
    "www",
    "http",
    "kesb",
    "gericht",
    "bei rueckfragen",
    "ihren aufzeichnungen",
    "aufzeichnungen"
  ];

  const lower = cleaned.toLowerCase();
  if (forbidden.some((item) => lower.includes(item))) {
    return false;
  }

  if (/\d/.test(cleaned)) {
    return false;
  }

  const parts = cleaned
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}-]/gu, ""))
    .filter(Boolean);

  if (parts.length < 2 || parts.length > 4) {
    return false;
  }

  return parts.every((part) => /^(?:[A-ZÄÖÜ][a-zäöüß-]+|[A-ZÄÖÜ][a-zäöüß-]*\.)$/u.test(part));
}

function normalizeDateIso(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) {
    return "";
  }

  const dotted = raw.match(/\b(\d{2})[.](\d{2})[.](\d{4})\b/);
  if (dotted) {
    return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  }

  const slashed = raw.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (slashed) {
    return `${slashed[3]}-${slashed[2]}-${slashed[1]}`;
  }

  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  return raw;
}

function extractAuthorFromSignature(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/[;,]+$/g, "")))
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (looksLikePersonName(line)) {
      return line;
    }
  }

  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const line = lines[i];
    if (looksLikePersonName(line)) {
      return line;
    }
  }

  return "";
}

function normalizePeople(values) {
  const seen = new Set();
  const list = [];

  for (const value of Array.isArray(values) ? values : []) {
    let normalized = normalizeWhitespace(value).replace(/[;,]+$/g, "");
    normalized = normalized
      .replace(/^(Herr|Frau|Bruder|Schwester|Mutter|Vater)\s+/i, "")
      .replace(/[-–]\s*$/g, "");

    if (!normalized || normalized.length < 3) {
      continue;
    }

    if (!looksLikePersonName(normalized)) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push(normalized);
  }

  return list.slice(0, 8);
}

function extractDateFromText(rawText) {
  const text = String(rawText || "");
  const patterns = [
    /\b(\d{2}\.\d{2}\.\d{4})\b/,
    /\b(\d{2}\/\d{2}\/\d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function extractPeopleFromText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line));
  const people = [];

  const personPatterns = [
    /\b([A-ZÄÖÜ][a-zäöüß'-]+\s+[A-ZÄÖÜ][a-zäöüß'-]+)\b/g,
    /\b([A-ZÄÖÜ][a-zäöüß'-]+\.[A-ZÄÖÜ][a-zäöüß'-]+)\b/g
  ];

  for (const line of lines) {
    if (!line || line.length > 140) {
      continue;
    }

    for (const pattern of personPatterns) {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        people.push(match[1]);
      }
    }
  }

  return normalizePeople(people);
}

function extractLabeledValue(rawText, labels) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line));

  for (const line of lines) {
    for (const label of labels) {
      const pattern = new RegExp(`^${label}\\s*[:\\-]\\s*(.+)$`, "i");
      const match = line.match(pattern);
      if (match && match[1]) {
        return normalizeWhitespace(match[1]);
      }
    }
  }

  return "";
}

function extractPeopleFromLabeledFields(rawText) {
  const recipients = extractLabeledValue(rawText, ["An", "To", "Empfänger", "Empfaenger", "Cc", "Kopie"]);
  if (!recipients) {
    return [];
  }

  const values = recipients
    .split(/[;,]/)
    .map((part) => normalizeWhitespace(part.replace(/<[^>]+>/g, "")))
    .filter(Boolean);

  return normalizePeople(values);
}

function buildHeuristicAnalysisFromText(rawText, pdfInfo = {}) {
  const titleFromSubject = extractLabeledValue(rawText, ["Betreff", "Subject", "Titel"]);
  const titleFromText = extractTitleFromText(rawText);
  const titleCandidate = titleFromSubject || (titleFromText && !/^von\s*:/i.test(titleFromText) ? titleFromText : "");

  const authorFromLabel = extractLabeledValue(rawText, ["Von", "From", "Absender", "Verfasser", "Autor", "Sachbearbeiter", "Sachbearbeiterin"]);
  const authorFromSignature = extractAuthorFromSignature(rawText);
  const author = authorFromLabel || authorFromSignature || normalizeWhitespace(pdfInfo.Author);

  const dateFromLabel = extractLabeledValue(rawText, ["Datum", "Date", "Verfasst am", "Erstellt am", "Gesendet", "Sent"]);
  const authoredDate = normalizeDateIso(
    dateFromLabel || parsePdfMetadataDate(pdfInfo.CreationDate || pdfInfo.ModDate || "") || extractDateFromText(rawText)
  );

  const title = (looksLikePersonName(titleCandidate) && author)
    ? "Stellungnahme"
    : titleCandidate;

  const people = normalizePeople([
    author,
    ...extractPeopleFromLabeledFields(rawText),
    ...extractPeopleFromText(rawText)
  ]);

  return buildFallbackAnalysis({
    title,
    author,
    authoredDate,
    people,
    message: ""
  });
}

function parsePdfMetadataDate(value) {
  const raw = normalizeWhitespace(value);
  const match = raw.match(/(\d{4})(\d{2})(\d{2})/);
  if (!match) {
    return "";
  }

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

function buildFallbackAnalysis({ title = "", author = "", authoredDate = "", people = [], message = "" }) {
  const normalizedAuthor = normalizeWhitespace(author);
  const normalizedTitle = normalizeWhitespace(title);

  const correctedAuthor = (!normalizedAuthor && looksLikePersonName(normalizedTitle))
    ? normalizedTitle
    : normalizedAuthor;

  const correctedTitle = (looksLikePersonName(normalizedTitle) && correctedAuthor)
    ? "Stellungnahme"
    : normalizedTitle;

  const normalizedPeople = normalizePeople([correctedAuthor, ...(Array.isArray(people) ? people : [])]);

  return {
    status: "ok",
    title: correctedTitle,
    author: correctedAuthor,
    authoredDate: normalizeDateIso(authoredDate),
    people: normalizedPeople,
    message: normalizeWhitespace(message)
  };
}

function extractJsonObject(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}

async function analyzeTextWithAi(documentText, fallback = {}) {
  const client = getOpenAiClient();
  if (!client) {
    return buildFallbackAnalysis(fallback);
  }

  const textSnippet = String(documentText || "").slice(0, 12000);
  if (!textSnippet.trim()) {
    return buildFallbackAnalysis(fallback);
  }

  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 300,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Analysiere dieses Dokument und extrahiere strukturierte Fakten.",
                "Antworte ausschliesslich als JSON-Objekt mit genau diesen Feldern:",
                '{"title":"","author":"","authoredDate":"","people":[],"message":""}',
                "Regeln:",
                "- title = kurzer Dokumenttitel aus dem Inhalt, nicht der Dateiname und nicht nur ein Personenname.",
                "- author = Verfasser/Absender, bevorzugt aus Unterschrift am Ende oder Briefkopf am Anfang.",
                "- authoredDate = Datum der Verfassung im Format YYYY-MM-DD.",
                "- people = nur echte Personennamen als Array ohne Duplikate.",
                "- people darf KEINE Strassen, Orte, Satzfragmente oder Floskeln enthalten.",
                "- message = kurzer Hinweis, falls etwas unklar ist.",
                "- Wenn etwas fehlt, leeres Feld verwenden.",
                "Dokumenttext:",
                textSnippet
              ].join("\n")
            }
          ]
        }
      ]
    });

    const parsed = extractJsonObject(extractResponseText(response));
    if (!parsed || typeof parsed !== "object") {
      return buildFallbackAnalysis(fallback);
    }

    return buildFallbackAnalysis({
      title: parsed.title || fallback.title,
      author: parsed.author || fallback.author,
      authoredDate: parsed.authoredDate || fallback.authoredDate,
      people: Array.isArray(parsed.people) && parsed.people.length > 0 ? parsed.people : fallback.people,
      message: parsed.message || fallback.message
    });
  } catch (error) {
    const statusCode = Number(error?.status || 0);
    const message = String(error?.message || "");

    if (statusCode === 401 || /Missing scopes:|insufficient permissions/i.test(message)) {
      return {
        status: "needs-config",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: "OpenAI-Key erkannt, aber ohne ausreichende API-Scopes (model.request / api.responses.write)."
      };
    }

    if (statusCode === 429) {
      return {
        status: "needs-config",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: "OpenAI-Limit erreicht. Bitte später erneut versuchen."
      };
    }

    return buildFallbackAnalysis(fallback);
  }
}

async function extractTitleFromImageWithAi(absolutePath, mimeType) {
  const client = getOpenAiClient();
  if (!client) {
    return {
      status: "needs-ocr",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      message: "Bildtitel benötigt OCR oder KI-Analyse."
    };
  }

  const fileBuffer = await fs.promises.readFile(absolutePath);
  const base64 = fileBuffer.toString("base64");

  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 300,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Analysiere dieses Dokumentbild und extrahiere strukturierte Fakten.",
                "Antworte ausschliesslich als JSON-Objekt mit genau diesen Feldern:",
                '{"title":"","author":"","authoredDate":"","people":[],"message":""}',
                "Regeln:",
                "- title = kurzer sichtbarer Dokumenttitel, kein reiner Personenname.",
                "- author = sichtbarer Verfasser/Absender aus Briefkopf oder Unterschrift.",
                "- authoredDate = sichtbares Verfassungsdatum im Format YYYY-MM-DD.",
                "- people = nur erkennbare reale Personennamen als Array ohne Duplikate.",
                "- people darf KEINE Strassen, Orte oder Satzfragmente enthalten.",
                "- message = kurzer Hinweis, wenn etwas nicht sicher lesbar ist.",
                "- Wenn nichts erkennbar ist, Felder leer lassen."
              ].join("\n")
            },
            {
              type: "input_image",
              image_url: `data:${mimeType || "image/png"};base64,${base64}`
            }
          ]
        }
      ]
    });

    const parsed = extractJsonObject(extractResponseText(response));

    if (!parsed || typeof parsed !== "object") {
      return {
        status: "empty",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: "Kein klarer Inhalt im Bild erkannt."
      };
    }

    const normalized = buildFallbackAnalysis({
      title: parsed.title,
      author: parsed.author,
      authoredDate: parsed.authoredDate,
      people: parsed.people,
      message: parsed.message
    });

    if (!normalized.title && !normalized.author && !normalized.authoredDate && normalized.people.length === 0) {
      return {
        status: "empty",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: normalized.message || "Kein klarer Inhalt im Bild erkannt."
      };
    }

    return normalized;
  } catch (error) {
    const statusCode = Number(error?.status || 0);
    const message = String(error?.message || "");

    if (statusCode === 401 || /Missing scopes:|insufficient permissions/i.test(message)) {
      return {
        status: "needs-config",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: "OpenAI-Key erkannt, aber ohne ausreichende API-Scopes (model.request / api.responses.write)."
      };
    }

    if (statusCode === 429) {
      return {
        status: "needs-config",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        message: "OpenAI-Limit erreicht. Bitte später erneut versuchen."
      };
    }

    throw error;
  }
}

router.post("/", requireAuth, async (req, res) => {
  const { caseId, caseDate, caseName } = req.body;

  if (!caseId || !caseDate || !caseName) {
    return res.status(400).json({ error: "ID, Datum und Name sind erforderlich." });
  }

  const normalizedCaseId = String(caseId).trim();
  const normalizedCaseName = String(caseName).trim();

  if (!/^\d{6}$/.test(normalizedCaseId)) {
    return res.status(400).json({ error: "ID muss 6-stellig sein." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO cases (id, case_date, case_name) VALUES ($1, $2, $3) RETURNING id, case_date, case_name, created_at",
      [normalizedCaseId, caseDate, normalizedCaseName]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Fall-ID existiert bereits." });
    }
    console.error("Create case error:", err.message);
    return res.status(500).json({ error: "Fall konnte nicht erstellt werden." });
  }
});

router.get("/", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, case_date, case_name, created_at FROM cases ORDER BY created_at DESC LIMIT 200"
    );

    return res.json({ cases: result.rows });
  } catch (err) {
    console.error("List cases error:", err.message);
    return res.status(500).json({ error: "Fallliste konnte nicht geladen werden." });
  }
});

router.post("/:caseId/files", requireAuth, (req, res) => {
  upload.array("files", 20)(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || "Upload fehlgeschlagen." });
    }

    const caseId = String(req.params.caseId || "").trim();
    if (!/^\d{6}$/.test(caseId)) {
      return res.status(400).json({ error: "Ungueltige Fall-ID." });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Keine Dateien erhalten." });
    }

    try {
      const caseExists = await pool.query("SELECT id FROM cases WHERE id = $1 LIMIT 1", [caseId]);
      if (caseExists.rows.length === 0) {
        return res.status(404).json({ error: "Fall nicht gefunden." });
      }

      const inserted = [];
      for (const file of req.files) {
        const decodedOriginalName = decodeOriginalFileName(file.originalname);
        const result = await pool.query(
          "INSERT INTO case_documents (case_id, original_name, stored_name, mime_type, size_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING id, case_id, original_name, mime_type, size_bytes, uploaded_at",
          [caseId, decodedOriginalName, file.filename, file.mimetype, file.size]
        );
        inserted.push(result.rows[0]);
      }

      return res.status(201).json({ uploaded: inserted });
    } catch (err) {
      console.error("File upload error:", err.message);
      return res.status(500).json({ error: "Datei-Upload fehlgeschlagen." });
    }
  });
});

router.get("/:caseId/files", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungültige Fall-ID." });
  }

  try {
    const result = await pool.query(
      "SELECT id, case_id, original_name, mime_type, size_bytes, uploaded_at FROM case_documents WHERE case_id = $1 ORDER BY uploaded_at DESC",
      [caseId]
    );

    return res.json({ files: result.rows });
  } catch (err) {
    console.error("List files error:", err.message);
    return res.status(500).json({ error: "Dateiliste konnte nicht geladen werden." });
  }
});

router.get("/:caseId/files/:fileId/preview", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungültige Fall-ID." });
  }

  try {
    const result = await pool.query(
      "SELECT id, original_name, stored_name, mime_type FROM case_documents WHERE case_id = $1 AND id = $2 LIMIT 1",
      [caseId, fileId]
    );

    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: "Datei nicht gefunden." });
    }

    const absolutePath = path.join(uploadDir, file.stored_name);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "Datei fehlt im Speicher." });
    }

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    return res.sendFile(absolutePath);
  } catch (err) {
    console.error("Preview file error:", err.message);
    return res.status(500).json({ error: "Dateivorschau konnte nicht geladen werden." });
  }
});

router.get("/:caseId/files/:fileId/download", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungültige Fall-ID." });
  }

  try {
    const result = await pool.query(
      "SELECT id, original_name, stored_name FROM case_documents WHERE case_id = $1 AND id = $2 LIMIT 1",
      [caseId, fileId]
    );

    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: "Datei nicht gefunden." });
    }

    const absolutePath = path.join(uploadDir, file.stored_name);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "Datei fehlt im Speicher." });
    }

    return res.download(absolutePath, file.original_name);
  } catch (err) {
    console.error("Download file error:", err.message);
    return res.status(500).json({ error: "Datei konnte nicht heruntergeladen werden." });
  }
});

router.get("/:caseId/files/:fileId/analysis", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungültige Fall-ID." });
  }

  try {
    const result = await pool.query(
      "SELECT id, original_name, stored_name, mime_type FROM case_documents WHERE case_id = $1 AND id = $2 LIMIT 1",
      [caseId, fileId]
    );

    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: "Datei nicht gefunden." });
    }

    const absolutePath = path.join(uploadDir, file.stored_name);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "Datei fehlt im Speicher." });
    }

    if (String(file.mime_type || "").includes("pdf")) {
      try {
        const buffer = await fs.promises.readFile(absolutePath);
        const pdfParse = getPdfParse();
        if (!pdfParse) {
          return res.json({
            status: "empty",
            title: "",
            author: "",
            authoredDate: "",
            people: [],
            message: "PDF-Parser ist aktuell nicht verfuegbar."
          });
        }
        const parsed = await pdfParse(buffer);
        const fallback = buildHeuristicAnalysisFromText(parsed?.text || "", parsed?.info || {});

        const aiResult = await analyzeTextWithAi(parsed?.text || "", fallback);
        return res.json(aiResult);
      } catch (pdfError) {
        console.error("PDF parse warning:", pdfError.message);
        return res.json({
          status: "empty",
          title: "",
          author: "",
          authoredDate: "",
          people: [],
          message: "PDF-Inhalt konnte nicht gelesen werden (möglicherweise Scan oder defekter Textlayer)."
        });
      }
    }

    if (String(file.mime_type || "").startsWith("image/")) {
      const imageResult = await extractTitleFromImageWithAi(absolutePath, file.mime_type);
      return res.json(imageResult);
    }

    return res.json({
      status: "empty",
      title: "",
      message: "Analyse für diesen Dateityp nicht verfügbar."
    });
  } catch (err) {
    console.error("Analyze file error:", err.message);
    return res.status(500).json({ error: "Dateianalyse konnte nicht geladen werden." });
  }
});

router.delete("/:caseId/files/:fileId", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungültige Fall-ID." });
  }

  try {
    const existing = await pool.query(
      "SELECT id, stored_name FROM case_documents WHERE case_id = $1 AND id = $2 LIMIT 1",
      [caseId, fileId]
    );

    const file = existing.rows[0];
    if (!file) {
      return res.status(404).json({ error: "Datei nicht gefunden." });
    }

    await pool.query("DELETE FROM case_documents WHERE case_id = $1 AND id = $2", [caseId, fileId]);

    const absolutePath = path.join(uploadDir, file.stored_name);
    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }

    return res.json({ ok: true, id: fileId });
  } catch (err) {
    console.error("Delete file error:", err.message);
    return res.status(500).json({ error: "Datei konnte nicht gelöscht werden." });
  }
});

module.exports = router;
