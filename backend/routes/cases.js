const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
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
const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const supabaseBucketName = String(process.env.SUPABASE_STORAGE_BUCKET || "case-files").trim();

let supabaseStorageClient = null;

function getStorageBucket() {
  if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseBucketName) {
    return null;
  }

  if (!supabaseStorageClient) {
    const client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    supabaseStorageClient = client.storage.from(supabaseBucketName);
  }

  return supabaseStorageClient;
}

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn("Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(new Error("Nur PDF, JPG, JPEG, PNG erlaubt."));
      return;
    }
    cb(null, true);
  }
});

function createStoredName(originalName) {
  const decodedName = decodeOriginalFileName(originalName);
  const safeName = decodedName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const randomPart = crypto.randomUUID().slice(0, 8);
  return `${Date.now()}_${randomPart}_${safeName}`;
}

function deriveTitleFromFileName(fileName) {
  const raw = normalizeWhitespace(String(fileName || ""));
  if (!raw) {
    return "";
  }

  const withoutExt = raw.replace(/\.[a-z0-9]{2,5}$/i, "");
  const normalized = normalizeWhitespace(withoutExt.replace(/[_-]+/g, " "));
  if (!normalized || looksLikePersonName(normalized)) {
    return "";
  }

  return normalized;
}

function resolveStorageObjectPath(caseId, storedName) {
  const value = String(storedName || "").trim();
  if (!value) {
    return "";
  }

  if (value.includes("/")) {
    return value;
  }

  return `${caseId}/${value}`;
}

async function downloadStorageFile(caseId, storedName) {
  const bucket = getStorageBucket();
  if (!bucket) {
    const err = new Error("Supabase Storage ist nicht konfiguriert.");
    err.statusCode = 503;
    throw err;
  }

  const objectPath = resolveStorageObjectPath(caseId, storedName);
  const { data, error } = await bucket.download(objectPath);

  if (error || !data) {
    const err = new Error(error?.message || "Datei fehlt im Supabase Storage.");
    err.statusCode = 404;
    throw err;
  }

  return Buffer.from(await data.arrayBuffer());
}

let openAiClient = null;
let pdfParseFn;
let pdfParseLoadLogged = false;
let analysisStorageInitPromise = null;

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

function getPreferredAnalysisModels() {
  const envModels = String(process.env.OPENAI_ANALYSIS_MODELS || "").trim();
  const models = envModels
    ? envModels.split(",").map((item) => normalizeWhitespace(item)).filter(Boolean)
    : ["gpt-4.1", "gpt-4o"];

  return models.length > 0 ? models : ["gpt-4o"];
}

function isRecoverableModelError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return /model|not found|unsupported|permission|access|unavailable|does not exist/.test(msg)
    || /model|permission|not_found/.test(code);
}

async function createChatCompletionWithFallback(client, payload) {
  const models = getPreferredAnalysisModels();
  let lastError = null;

  for (const model of models) {
    try {
      return await client.chat.completions.create({
        ...payload,
        model
      });
    } catch (error) {
      lastError = error;
      if (!isRecoverableModelError(error)) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("No model available for forensic analysis.");
}

async function ensureAnalysisStorageTable() {
  if (!analysisStorageInitPromise) {
    analysisStorageInitPromise = pool.query(
      `CREATE TABLE IF NOT EXISTS case_document_analysis (
        document_id UUID PRIMARY KEY REFERENCES case_documents(id) ON DELETE CASCADE,
        analysis_json JSONB NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ).catch((error) => {
      analysisStorageInitPromise = null;
      throw error;
    });
  }

  await analysisStorageInitPromise;
}

async function loadStoredDocumentAnalysis(documentId) {
  try {
    await ensureAnalysisStorageTable();
    const result = await pool.query(
      "SELECT analysis_json FROM case_document_analysis WHERE document_id = $1 LIMIT 1",
      [documentId]
    );
    return result.rows[0]?.analysis_json || null;
  } catch (error) {
    console.error("Load stored analysis warning:", error.message);
    return null;
  }
}

async function saveDocumentAnalysis(documentId, analysis) {
  try {
    await ensureAnalysisStorageTable();
    await pool.query(
      `INSERT INTO case_document_analysis (document_id, analysis_json, updated_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (document_id)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json, updated_at = CURRENT_TIMESTAMP`,
      [documentId, JSON.stringify(analysis || {})]
    );
  } catch (error) {
    console.error("Save analysis warning:", error.message);
  }
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

const BACKEND_INSTANCE_STARTED_AT = new Date().toISOString();

function getAnalysisEngineVersion() {
  const raw = String(
    process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.RENDER_GIT_COMMIT
    || process.env.SOURCE_VERSION
    || process.env.npm_package_version
    || "local"
  ).trim();
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

function withAnalysisRuntimeMeta(payload) {
  const safe = payload && typeof payload === "object" ? payload : {};
  return {
    ...safe,
    analysisEngineVersion: getAnalysisEngineVersion(),
    backendStartedAt: BACKEND_INSTANCE_STARTED_AT
  };
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
    "abteilung",
    "freundliche",
    "gruesse",
    "grusse",
    "datum",
    "monat",
    "kantonales",
    "sozialamt",
    "unterhaltszahlungen",
    "ausstehende",
    "liestal",
    "sachbearbeiter",
    "sachbearbeiterin",
    "kinder",
    "debitoren",
    "kontoauszug",
    "alimente",
    "geburtsdatum",
    "heimatort",
    "heimatland",
    "montag",
    "dienstag",
    "mittwoch",
    "donnerstag",
    "freitag",
    "samstag",
    "sonntag",
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

  return parts.every((part) => /^(?:\p{Lu}[\p{Ll}\p{M}'-]+|\p{Lu}[\p{Ll}\p{M}'-]*\.)$/u.test(part));
}

function isAliasPerson(value) {
  const alias = normalizeWhitespace(value).toLowerCase();
  const allowedAliases = new Set([
    "kindsvater",
    "kindsmutter",
    "kindesvater",
    "kindesmutter"
  ]);
  return allowedAliases.has(alias);
}

function normalizeDateSwiss(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) {
    return "";
  }

  const dotted = raw.match(/\b(\d{2})[.](\d{2})[.](\d{4})\b/);
  if (dotted) {
    return `${dotted[1]}.${dotted[2]}.${dotted[3]}`;
  }

  const slashed = raw.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (slashed) {
    return `${slashed[1]}.${slashed[2]}.${slashed[3]}`;
  }

  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
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
  return normalizePeopleWithBlacklist(values, new Set());
}

function normalizeAffiliation(value) {
  const raw = normalizeWhitespace(value).toLowerCase();
  if (!raw) {
    return "Privatperson";
  }

  if (raw.includes("gericht") || raw.includes("court") || raw.includes("tribunal")) {
    return "Gericht";
  }

  if (raw.includes("beh") || raw.includes("amt") || raw.includes("kesb") || raw.includes("polizei") || raw.includes("staatsanw")) {
    return "Behörde";
  }

  if (raw.includes("schule") || raw.includes("lehr") || raw.includes("kindergarten")) {
    return "Schule";
  }

  if (raw.includes("firma") || raw.includes("gmbh") || raw.includes("ag") || raw.includes("versicherung") || raw.includes("bank")) {
    return "Firma";
  }

  if (raw.includes("privat")) {
    return "Privatperson";
  }

  return "Privatperson";
}

function inferAffiliationForPerson(rawText, personName) {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/).map((line) => normalizeWhitespace(line.toLowerCase()));
  const nameNeedle = normalizeWhitespace(personName).toLowerCase();

  if (!nameNeedle) {
    return "Privatperson";
  }

  for (const line of lines) {
    if (!line || !line.includes(nameNeedle)) {
      continue;
    }

    if (/gericht|tribunal|court/.test(line)) {
      return "Gericht";
    }
    if (/beh|amt|kesb|polizei|staatsanw/.test(line)) {
      return "Behörde";
    }
    if (/schule|lehr|kindergarten/.test(line)) {
      return "Schule";
    }
    if (/firma|gmbh|\bag\b|versicherung|bank/.test(line)) {
      return "Firma";
    }
  }

  return "Privatperson";
}

function normalizePeopleDetailed(values, rawText = "", blockedNames = new Set(), authorName = "") {
  const seen = new Set();
  const list = [];
  const blocked = blockedNames instanceof Set ? blockedNames : new Set();
  const authorKey = normalizeWhitespace(authorName).toLowerCase();

  for (const value of Array.isArray(values) ? values : []) {
    const inputName = typeof value === "string" ? value : value?.name;
    const inputAffiliation = typeof value === "object" && value ? value.affiliation : "";
    const allowSingleToken = typeof value === "object" && value ? value.allowSingleToken === true : false;

    let normalized = normalizeWhitespace(inputName).replace(/[;,]+$/g, "");
    normalized = normalized.replace(/^(Herr|Frau|Bruder|Schwester|Mutter|Vater)\s+/i, "");

    if (!normalized || normalized.length < 3) {
      continue;
    }

    if (/[\-ÔÇô]\s*$/.test(normalized)) {
      continue;
    }

    if (!looksLikePersonName(normalized) && !isAliasPerson(normalized)) {
      const singleTokenPattern = /^\p{Lu}[\p{Ll}\p{M}'-]{2,}$/u;
      if (!(allowSingleToken && singleTokenPattern.test(normalized))) {
        continue;
      }
    }

    const key = normalized.toLowerCase();
    if (blocked.has(key) || key === authorKey || seen.has(key)) {
      continue;
    }

    seen.add(key);
    list.push({
      name: normalized,
      affiliation: normalizeAffiliation(inputAffiliation || inferAffiliationForPerson(rawText, normalized))
    });
  }

  return list.slice(0, 20);
}

function normalizePeopleWithBlacklist(values, blockedNames) {
  const seen = new Set();
  const list = [];
  const blocked = blockedNames instanceof Set ? blockedNames : new Set();

  for (const value of Array.isArray(values) ? values : []) {
    let normalized = normalizeWhitespace(value).replace(/[;,]+$/g, "");
    normalized = normalized
      .replace(/^(Herr|Frau|Bruder|Schwester|Mutter|Vater)\s+/i, "");

    if (!normalized || normalized.length < 3) {
      continue;
    }

    if (/[\-ÔÇô]\s*$/.test(normalized)) {
      continue;
    }

    if (!looksLikePersonName(normalized)) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (blocked.has(key)) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push(normalized);
  }

  return list.slice(0, 8);
}

function extractBlockedPersonCandidates(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line));

  const blocked = new Set();
  const streetPattern = /(strasse|straße|gasse|weg|platz|allee)\b/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!streetPattern.test(line)) {
      continue;
    }

    const sameLine = line.match(/^(\p{Lu}[\p{Ll}\p{M}'-]+\s+\p{Lu}[\p{Ll}\p{M}'-]+)/u);
    if (sameLine && sameLine[1]) {
      blocked.add(normalizeWhitespace(sameLine[1]).toLowerCase());
    }

    const prev = lines[i - 1] || "";
    const prevCandidate = normalizeWhitespace(prev.replace(/[\-ÔÇô]\s*$/, ""));
    if (looksLikePersonName(prevCandidate)) {
      blocked.add(prevCandidate.toLowerCase());
    }
  }

  return blocked;
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

function extractPeopleFromText(rawText, blockedNames = new Set()) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line));
  const people = [];

  const personPatterns = [
    /\b(\p{Lu}[\p{Ll}\p{M}'-]+\s+\p{Lu}[\p{Ll}\p{M}'-]+)\b/gu,
    /\b(\p{Lu}[\p{Ll}\p{M}'-]+\.\p{Lu}[\p{Ll}\p{M}'-]+)\b/gu
  ];

  for (const line of lines) {
    if (!line || line.length > 320) {
      continue;
    }

    for (const pattern of personPatterns) {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        people.push(match[1]);
      }
    }
  }

  return normalizePeopleWithBlacklist(people, blockedNames);
}

function extractPeopleFromFullText(rawText, blockedNames = new Set()) {
  const text = String(rawText || "");
  const matches = text.matchAll(/\b(\p{Lu}[\p{Ll}\p{M}'-]{1,}\s+\p{Lu}[\p{Ll}\p{M}'-]{1,})\b/gu);
  const names = [];

  for (const match of matches) {
    names.push(match[1]);
  }

  return normalizePeopleWithBlacklist(names, blockedNames).slice(0, 24);
}

function extractPeopleFromStructuredRows(rawText, blockedNames = new Set()) {
  const text = String(rawText || "");
  const names = [];

  const surnameFirstWithMeta = text.matchAll(/\b([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})\s*,\s*\d{2,}(?:\s*,\s*\d{2}\.\d{2}\.\d{4})?/gu);
  for (const match of surnameFirstWithMeta) {
    names.push(`${match[2]} ${match[1]}`);
  }

  const paymentRows = text.matchAll(/\bf(?:u|ü)r\s+(?:Kinder\s+)?([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})\b/giu);
  for (const match of paymentRows) {
    names.push(`${match[2]} ${match[1]}`);
  }

  return normalizePeopleWithBlacklist(names, blockedNames).slice(0, 24);
}

function extractPeopleFromContextPhrases(rawText, blockedNames = new Set()) {
  const text = String(rawText || "");
  const candidates = [];
  const patterns = [
    /\b(?:fuer|für|gegen|zulasten von|zu lasten von|betreffend)\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+\s+[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+)/giu,
    /\b([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+\s+[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+)\s+ist\s+/giu
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      candidates.push(match[1]);
    }
  }

  return normalizePeopleWithBlacklist(candidates, blockedNames);
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

function extractPeopleFromLabeledFields(rawText, blockedNames = new Set()) {
  const recipients = extractLabeledValue(rawText, ["An", "To", "Empfänger", "Empfaenger", "Cc", "Kopie"]);
  if (!recipients) {
    return [];
  }

  const capitalizeWord = (word) => {
    const raw = normalizeWhitespace(word).toLowerCase();
    if (!raw) {
      return "";
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  };

  const parts = recipients
    .split(/[;,]/)
    .map((part) => normalizeWhitespace(part.replace(/<[^>]+>/g, "")))
    .filter(Boolean);

  const candidates = [];
  for (const part of parts) {
    const email = extractFirstEmail(part);
    if (!email) {
      candidates.push({ name: part, allowSingleToken: false });
      continue;
    }

    const local = (email.split("@")[0] || "").toLowerCase();
    if (local.includes(".")) {
      const name = local
        .split(".")
        .map((token) => capitalizeWord(token.replace(/[^\p{L}'-]/gu, "")))
        .filter(Boolean)
        .join(" ");

      if (name) {
        candidates.push({ name, allowSingleToken: false });
      }
    } else {
      const token = capitalizeWord(local.replace(/[^\p{L}'-]/gu, ""));
      if (token) {
        candidates.push({ name: token, allowSingleToken: true });
      }
    }
  }

  const blocked = blockedNames instanceof Set ? blockedNames : new Set();
  return candidates.filter((c) => !blocked.has(normalizeWhitespace(c.name).toLowerCase()));
}

function extractPeopleFromSalutation(rawText, blockedNames = new Set()) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line));
  const candidates = [];

  const salutationRegex = /^Sehr\s+geehrte[rsn]?\s+(?:Frau|Herr)\s+(\p{Lu}[\p{Ll}\p{M}'-]{2,})/iu;
  for (const line of lines) {
    const match = line.match(salutationRegex);
    if (match && match[1]) {
      candidates.push({ name: match[1], allowSingleToken: true });
    }
  }

  const blocked = blockedNames instanceof Set ? blockedNames : new Set();
  return candidates.filter((c) => !blocked.has(normalizeWhitespace(c.name).toLowerCase()));
}

function extractDisadvantagedPerson(rawText, people = [], author = "") {
  const authorKey = normalizeWhitespace(author).toLowerCase();
  const fromLabel = extractLabeledValue(rawText, [
    "Benachteiligte Person",
    "Benachteiligter",
    "Betroffene Person",
    "Zu benachteiligen",
    "Nachteil fuer",
    "Zulasten von"
  ]);

  if (looksLikePersonName(fromLabel) && fromLabel.toLowerCase() !== authorKey) {
    return fromLabel;
  }

  const text = String(rawText || "");
  const phraseMatch = text.match(/(?:benachteiligt(?:e|en)?|zulasten von|zu lasten von|nachteil(?:ig)? fuer)\s*[:\-]?\s*([A-Z├ä├û├£][a-z├ñ├Â├╝├ƒ'-]+\s+[A-Z├ä├û├£][a-z├ñ├Â├╝├ƒ'-]+)/u);
  if (phraseMatch && looksLikePersonName(phraseMatch[1]) && phraseMatch[1].toLowerCase() !== authorKey) {
    return normalizeWhitespace(phraseMatch[1]);
  }

  const names = (Array.isArray(people) ? people : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .map((name) => normalizeWhitespace(name))
    .filter(Boolean);

  const lower = text.toLowerCase();
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx === -1) {
      continue;
    }
    const start = Math.max(0, idx - 120);
    const end = Math.min(lower.length, idx + name.length + 120);
    const windowText = lower.slice(start, end);
    if (/benachteilig|zulasten|zu lasten|nachteil/.test(windowText) && name.toLowerCase() !== authorKey) {
      return name;
    }
  }

  return "";
}

function extractFirstEmail(value) {
  const raw = String(value || "");
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function extractSenderInstitution(rawText, author = "") {
  const fromValue = extractLabeledValue(rawText, ["Von", "From", "Absender", "Sender"]);
  const domainEmail = extractFirstEmail(fromValue);
  const domain = domainEmail ? domainEmail.split("@")[1].toLowerCase() : "";
  const normalizedAuthor = normalizeWhitespace(author);

  // Check domain for institution clues
  if (domain && domain.includes("kesb")) {
    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);

    const preferredKesb = lines.find((line) => /^KESB\s+[A-Za-z].+/i.test(line) && line.length > 7);
    if (preferredKesb) {
      return preferredKesb;
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^KESB\s+/i.test(line)) {
        return line;
      }
    }
    return "KESB";
  }

  if (domain) {
    const stem = domain.split(".")[0] || "";
    if (stem) {
      return stem.toUpperCase();
    }
  }

  // No sender domain available: default to private author identity.
  if (normalizedAuthor && looksLikePersonName(normalizedAuthor)) {
    return "Privat";
  }

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const authorKey = normalizeWhitespace(author).toLowerCase();

  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if (
      /\b(kesb|gericht|amt|behoerde|behörde|schule|sozialdienst|gmbh|\bag\b|versicherung|bank|verwaltung|kanzlei)\b/i.test(line)
      && !looksLikePersonName(line)
      && !/\d{3,}/.test(line)
      && lower !== authorKey
    ) {
      candidates.push(line);
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const kesbA = /kesb/i.test(a) ? 1 : 0;
      const kesbB = /kesb/i.test(b) ? 1 : 0;
      if (kesbA !== kesbB) {
        return kesbB - kesbA;
      }
      return b.length - a.length;
    });
    return candidates[0];
  }

  return "";
}

function classifyMentionPolarity(text) {
  const lower = normalizeWhitespace(text).toLowerCase();
  if (!lower) {
    return "neutral";
  }

  const negative = /(benachteilig|beleidig|droh|diffam|anschwarz|angriff|verletz|abwert|schlecht|nachteil|zulasten|zu lasten|konkurs|kuendigung|sanktion|verweigert)/.test(lower);
  const positive = /(unterstuetz|hilf|lieb|freundlich|respekt|fair|gut|positiv|stark|foerder|ermutig|sicher)/.test(lower);

  if (negative && !positive) {
    return "negative";
  }
  if (positive && !negative) {
    return "positive";
  }
  return "neutral";
}

function countPolaritySignals(text) {
  const lower = normalizeWhitespace(text).toLowerCase();
  if (!lower) {
    return { positive: 0, negative: 0 };
  }

  const negativeRegex = /(benachteilig|beleidig|droh|diffam|anschwarz|angriff|verletz|abwert|schlecht|nachteil|zulasten|zu lasten|konkurs|kuendigung|sanktion|verweigert|unkooperativ|defizit|untauglich|ungeeignet|vorwurf|durchbox|mehr\s+muehe|muehe\s+.*akzept|nicht\s+.*interessen\s+.*kinder|konfliktarsenal|unp[uü]nkt|selten\s+gelingt|immer\s+wieder\s+nicht|egozentrisch|narziss|rigide?\b|stur\b|uneinsicht|unflexib|wenig\s+kompromiss|nicht\s+in\s+der\s+lage|instrumentalis|mangel|es\s+fehlt\s+an|kein\s+verstaendnis|ohne\s+einsicht|eingeschraenkt\s+.*faehig|kaum\s+.*bereit|destruktiv|feindsel|eskalier|blockier|provozi|entwert|herabsetz|diskreditier|unverantwort|r[uü]cksichtslos|manipulat|grenzueberschreit|parentifizier|kindswohl.*gefaehrd|obstrukt|verweigerungshalt|loyalit[aä]tskonflikt|entfremd)/g;
  const positiveRegex = /(unterstuetz|hilf|lieb|freundlich|respekt|fair|gut|positiv|stark|foerder|ermutig|sicher|kompetent|kooperativ|konstruktiv|empath|nimmt\s+.*aufgaben\s+.*wahr|zugetraut|in\s+der\s+lage|gute\s+argumente|kontinuitaet|beibehaltung\s+.*obhut|alleinzuweisung|geeignet|faehig|flexibil|umsetzung\s+von\s+empfehl|reflektiert|stabil|zuverl[aä]ssig|engagiert|stabilisier|verantwortungsvoll|dem\s+wohl\s+.*dienlich|liebevoll|foerderlich|warmherzig|beziehungsf[aä]hig|bindungstol|einfuehlsam|selbstreflekt|ausgewogen|kindgerecht|altersgerecht|ressourcenorient|loesungsorient|wertschaetz|verlaesslich|aufmerksam|f[uü]rsorglich)/g;

  return {
    negative: (lower.match(negativeRegex) || []).length,
    positive: (lower.match(positiveRegex) || []).length
  };
}

function splitIntoClaimClauses(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?;:])\s+|\n+/)
    .flatMap((sentence) => String(sentence || "").split(/,(?=\s)/))
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 5);
}

function countDistinctClaimSignals(clause) {
  const lower = normalizeForSearch(clause);
  const positiveSignals = [
    /\beher\s+in\s+der\s+lage\b/,
    /\bin\s+der\s+lage\b/,
    /\bgeeignet\b/,
    /\bsinnvoll\b/,
    /\bvertretbar\b/,
    /\bangemessen\b/,
    /\bgerechtfertigt\b/,
    /\bempfohlen\b/,
    /\bbeibehalten\b/,
    /\bbelassen\b/,
    /\bsoll\b.*\bbleiben\b/,
    /\bsoll\b.*\bzugeteilt\b/,
    /\bsoll\b.*\bzugewiesen\b/,
    /\bsoll\b.*\bubertragen\b/,
    /\bkooperativ/,
    /\bargumentationsstark\b/,
    /\bmehr\s+kindesorientiert\b/,
    /\bstabil/,
    /\bkontinuitaet\b/,
    /\bgute\s+argumente\b/
  ];

  const negativeSignals = [
    /\bweniger\s+kooperativ\b/,
    /\bnicht\s+kooperativ\b/,
    /\bdurchsetzungsorientiert\b/,
    /\bhat\s+muehe\b/,
    /\bmuehe\s+mit\b/,
    /\bgelingt\s+selten\b/,
    /\bnicht\s+im\s+blick\b/,
    /\bdurchsetzen\s+wollen\b/,
    /\bweniger\s+kompromissbereit\b/,
    /\bweniger\s+kindesorientiert\b/,
    /\bweniger\s+in\s+der\s+lage\b/,
    /\bnicht\s+in\s+der\s+lage\b/,
    /\bkeine\s+losungen\s+finden\b/,
    /\bkann\s+keine\s+losungen\s+finden\b/,
    /\brigid\b/,
    /\bproblematisch\b/,
    /\beigene\s+interessen\b/,
    /\bnicht\s+berucksichtigt\b/
  ];

  return {
    positive: positiveSignals.filter((regex) => regex.test(lower)).length,
    negative: negativeSignals.filter((regex) => regex.test(lower)).length
  };
}

function countStrictPartyClaims(rawText, protectedAliases = [], opposingAliases = []) {
  const clauses = splitIntoClaimClauses(rawText);
  const result = {
    groupA: { positive: 0, negative: 0 },
    groupB: { positive: 0, negative: 0 }
  };

  for (const clause of clauses) {
    const mentionsA = hasAnyPartyNeedle(clause, protectedAliases);
    const mentionsB = hasAnyPartyNeedle(clause, opposingAliases);
    if (!mentionsA && !mentionsB) {
      continue;
    }

    if (mentionsA && mentionsB) {
      continue;
    }

    const counts = countDistinctClaimSignals(clause);
    if (counts.positive === 0 && counts.negative === 0) {
      continue;
    }

    if (mentionsA) {
      result.groupA.positive += counts.positive;
      result.groupA.negative += counts.negative;
    }
    if (mentionsB) {
      result.groupB.positive += counts.positive;
      result.groupB.negative += counts.negative;
    }
  }

  return result;
}

function normalizeForSearch(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildNameNeedles(name) {
  const raw = normalizeWhitespace(name);
  if (!raw) {
    return [];
  }

  const stopwords = new Set(["der", "die", "das", "und", "von", "vom", "zur", "zum", "im", "in"]);
  const parts = raw
    .split(/\s+/)
    .map((part) => normalizeForSearch(part))
    .filter((part) => part.length >= 3 && !stopwords.has(part));

  const full = normalizeForSearch(raw);
  return Array.from(new Set([full, ...parts]));
}

function parsePartyAliases(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) {
    return { primary: "", aliases: [] };
  }

  const aliases = raw
    .split(",")
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const primary = aliases[0] || raw;
  return { primary, aliases: aliases.length > 0 ? aliases : [primary] };
}

function hasAnyPartyNeedle(text, aliases = []) {
  const lowerText = normalizeForSearch(text);
  if (!lowerText) {
    return false;
  }

  const needles = Array.from(new Set(
    (Array.isArray(aliases) ? aliases : [])
      .flatMap((alias) => buildNameNeedles(alias))
      .filter(Boolean)
  ));

  return needles.some((needle) => new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lowerText));
}

function countProtectedMentions(rawText, protectedName, impactRanking = [], aliases = []) {
  const name = normalizeWhitespace(protectedName);
  if (!name) {
    return { positiveMentions: 0, negativeMentions: 0 };
  }

  const aliasList = Array.isArray(aliases) && aliases.length > 0
    ? aliases.map((entry) => normalizeWhitespace(entry)).filter(Boolean)
    : [name];

  let positiveMentions = 0;
  let negativeMentions = 0;
  const targetKey = name.toLowerCase();
  const rankingEntry = (Array.isArray(impactRanking) ? impactRanking : []).find(
    (entry) => normalizeWhitespace(entry?.name).toLowerCase() === targetKey
  );

  const evidenceItems = Array.isArray(rankingEntry?.items) ? rankingEntry.items : [];
  for (const item of evidenceItems) {
    const counts = countPolaritySignals(item);
    if (counts.positive === 0 && counts.negative === 0) {
      const polarity = classifyMentionPolarity(item);
      if (polarity === "positive") {
        positiveMentions += 1;
      } else if (polarity === "negative") {
        negativeMentions += 1;
      }
    } else {
      positiveMentions += counts.positive;
      negativeMentions += counts.negative;
    }
  }

  if (positiveMentions > 0 || negativeMentions > 0) {
    return { positiveMentions, negativeMentions };
  }

  const normalizedText = String(rawText || "");
  const normalizedSearchText = normalizeForSearch(normalizedText);
  const needles = Array.from(new Set(aliasList.flatMap((alias) => buildNameNeedles(alias))));
  const sentenceCandidates = normalizedSearchText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const mentionsInText = sentenceCandidates.filter((sentence) =>
    needles.some((needle) => new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sentence))
  );

  for (const sentence of mentionsInText) {
    const counts = countPolaritySignals(sentence);
    positiveMentions += counts.positive;
    negativeMentions += counts.negative;
  }

  if ((positiveMentions === 0 && negativeMentions === 0) && Number(rankingEntry?.count || 0) > 0) {
    negativeMentions = Math.max(negativeMentions, Number(rankingEntry.count || 0));
  }

  return { positiveMentions, negativeMentions };
}

function buildImpactRanking(people = [], disadvantagedPerson = "", aiItems = {}) {
  const disadvantagedKey = normalizeWhitespace(disadvantagedPerson).toLowerCase();
  const entries = (Array.isArray(people) ? people : [])
    .map((item) => {
      const name = typeof item === "string" ? normalizeWhitespace(item) : normalizeWhitespace(item?.name);
      if (!name) {
        return null;
      }

      const nameKey = name.toLowerCase();
      const ai = aiItems[nameKey] || {};
      const isDisadvantaged = nameKey === disadvantagedKey;
      const count = typeof ai.count === "number" ? ai.count : (isDisadvantaged ? 1 : 0);
      const items = Array.isArray(ai.items) ? ai.items.filter((s) => typeof s === "string" && s.trim()) : [];

      return {
        name,
        impact: (count > 0 || isDisadvantaged) ? "benachteiligt" : "neutral",
        count,
        items
      };
    })
    .filter(Boolean);

  entries.sort((a, b) => {
    if (a.impact === b.impact) {
      return a.name.localeCompare(b.name, "de-CH");
    }
    return a.impact === "benachteiligt" ? -1 : 1;
  });

  return entries;
}

function classifyImpact(rawText, disadvantagedPerson = "") {
  if (normalizeWhitespace(disadvantagedPerson)) {
    return "Person benachteiligt";
  }

  const lower = String(rawText || "").toLowerCase();
  if (/(benachteilig|abgewiesen|entzogen|kündigung|kuendigung|sanktion|verweigert|zulasten|zu lasten|nachteil|unterschiedlich\s+gut|ungleich\s+behand|schlechter\s+gestellt|diskriminier|nicht\s+gleich)/.test(lower)) {
    return "Person benachteiligt";
  }

  return "Neutral";
}

function buildHeuristicAnalysisFromText(rawText, pdfInfo = {}) {
  const blockedPeople = extractBlockedPersonCandidates(rawText);
  const titleFromSubject = extractLabeledValue(rawText, ["Betreff", "Subject", "Titel"]);
  const titleFromText = extractTitleFromText(rawText);
  const titleCandidate = titleFromSubject || (titleFromText && !/^von\s*:/i.test(titleFromText) ? titleFromText : "");

  const authorFromLabel = extractLabeledValue(rawText, ["Von", "From", "Absender", "Verfasser", "Autor", "Sachbearbeiter", "Sachbearbeiterin"]);
  const authorFromSignature = extractAuthorFromSignature(rawText);
  const author = authorFromLabel || authorFromSignature || normalizeWhitespace(pdfInfo.Author);

  const dateFromLabel = extractLabeledValue(rawText, ["Datum", "Date", "Verfasst am", "Erstellt am", "Gesendet", "Sent"]);
  const authoredDate = normalizeDateSwiss(
    dateFromLabel || parsePdfMetadataDate(pdfInfo.CreationDate || pdfInfo.ModDate || "") || extractDateFromText(rawText)
  );

  const title = looksLikePersonName(titleCandidate) ? "" : titleCandidate;

  const people = normalizePeopleDetailed([
    ...extractPeopleFromLabeledFields(rawText, blockedPeople),
    ...extractPeopleFromSalutation(rawText, blockedPeople),
    ...extractPeopleFromText(rawText, blockedPeople),
    ...extractPeopleFromContextPhrases(rawText, blockedPeople),
    ...extractPeopleFromStructuredRows(rawText, blockedPeople)
  ], rawText, blockedPeople, author);

  const disadvantagedPerson = extractDisadvantagedPerson(rawText, people, author);
  const senderInstitution = extractSenderInstitution(rawText, author);
  const impactAssessment = classifyImpact(rawText, disadvantagedPerson);
  const impactRanking = buildImpactRanking(people, disadvantagedPerson);

  return buildFallbackAnalysis({
    title,
    author,
    authoredDate,
    people,
    disadvantagedPerson,
    senderInstitution,
    impactAssessment,
    impactRanking,
    rawText,
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

function buildFallbackAnalysis({ title = "", author = "", authoredDate = "", documentType = "", people = [], disadvantagedPerson = "", senderInstitution = "", impactAssessment = "", impactRanking = [], positiveMentions = 0, negativeMentions = 0, opposingPositiveMentions = 0, opposingNegativeMentions = 0, rawText = "", message = "" }) {
  const normalizedAuthor = normalizeWhitespace(author);
  const normalizedTitle = normalizeWhitespace(title);

  const correctedAuthor = (!normalizedAuthor && looksLikePersonName(normalizedTitle))
    ? normalizedTitle
    : normalizedAuthor;

  const correctedTitle = (looksLikePersonName(normalizedTitle) && correctedAuthor)
    ? ""
    : normalizedTitle;

  const mergedPeople = [
    ...(Array.isArray(people) ? people : []),
    ...extractPeopleFromLabeledFields(rawText, new Set()),
    ...extractPeopleFromSalutation(rawText, new Set()),
    ...extractPeopleFromText(rawText, new Set()),
    ...extractPeopleFromContextPhrases(rawText, new Set()),
    ...extractPeopleFromStructuredRows(rawText, new Set())
  ];

  const normalizedPeople = normalizePeopleDetailed(mergedPeople, rawText, new Set(), correctedAuthor);
  const explicitDisadvantaged = normalizeWhitespace(disadvantagedPerson);
  const computedDisadvantaged = explicitDisadvantaged || extractDisadvantagedPerson(rawText, normalizedPeople, correctedAuthor);
  const normalizedDisadvantaged = computedDisadvantaged.toLowerCase() === correctedAuthor.toLowerCase()
    ? ""
    : computedDisadvantaged;
  let normalizedSenderInstitution = normalizeWhitespace(senderInstitution) || extractSenderInstitution(rawText, correctedAuthor);
  const textSuggestsInstitution = /\b(kesb\s+[a-z]|kesb|gericht|behoerde|behörde|kanzlei|amt|verwaltung)\b/i.test(String(rawText || ""));
  const senderLooksInstitutional = /\b(kesb|gericht|amt|behoerde|behörde|verwaltung|kanzlei|anwal|schule|bank|versicherung|gmbh|\bag\b|zivil|bezirks|kantons)\b/i.test(normalizedSenderInstitution);
  if (/\bbrief\b/i.test(String(documentType || ""))
    && correctedAuthor
    && looksLikePersonName(correctedAuthor)
    && !senderLooksInstitutional
    && !textSuggestsInstitution) {
    normalizedSenderInstitution = "Privat";
  }
  const aiItemsLookup = {};
  if (Array.isArray(impactRanking)) {
    impactRanking.forEach((entry) => {
      const key = normalizeWhitespace(entry?.name || "").toLowerCase();
      if (key) {
        aiItemsLookup[key] = {
          count: typeof entry.count === "number" ? entry.count : undefined,
          items: Array.isArray(entry.items) ? entry.items : []
        };
      }
    });
  }
  const normalizedImpactRanking = buildImpactRanking(normalizedPeople, normalizedDisadvantaged, aiItemsLookup);
  const normalizedImpactAssessment = normalizeWhitespace(impactAssessment) || classifyImpact(rawText, normalizedDisadvantaged);

  return {
    status: "ok",
    title: correctedTitle,
    author: correctedAuthor,
    documentType: normalizeWhitespace(documentType),
    authoredDate: normalizeDateSwiss(authoredDate),
    people: normalizedPeople,
    disadvantagedPerson: normalizedDisadvantaged,
    senderInstitution: normalizedSenderInstitution,
    impactAssessment: normalizedImpactAssessment,
    impactRanking: normalizedImpactRanking,
    positiveMentions: Number(positiveMentions) || 0,
    negativeMentions: Number(negativeMentions) || 0,
    opposingPositiveMentions: Number(opposingPositiveMentions) || 0,
    opposingNegativeMentions: Number(opposingNegativeMentions) || 0,
    message: normalizeWhitespace(message),
    analysisEngineVersion: getAnalysisEngineVersion(),
    backendStartedAt: BACKEND_INSTANCE_STARTED_AT
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

function mapSwissForensicJsonToAnalysis(parsed, fallback = {}, rawText = "") {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const mappedPeople = Array.isArray(src.personen)
    ? src.personen
      .map((entry) => {
        const name = normalizeWhitespace(entry?.name || "");
        if (!name) {
          return null;
        }
        const rolle = normalizeWhitespace(entry?.rolle || "");
        return {
          name,
          affiliation: rolle || "Privatperson"
        };
      })
      .filter(Boolean)
    : (Array.isArray(src.people) ? src.people : []);

  // When AI returned persons, do NOT re-run heuristics (they add garbage).
  const effectiveRawText = mappedPeople.length > 0 ? "" : rawText;

  return buildFallbackAnalysis({
    title: src.dokument_titel || src.title || fallback.title,
    author: src.verfasser || src.author || fallback.author,
    documentType: src.dokument_typ || src.documentType || fallback.documentType || "",
    authoredDate: src.datum_verfassung || src.authoredDate || fallback.authoredDate,
    people: mappedPeople.length > 0 ? mappedPeople : fallback.people,
    disadvantagedPerson: src.disadvantagedPerson || fallback.disadvantagedPerson,
    senderInstitution: src.herkunft || src.senderInstitution || fallback.senderInstitution,
    impactAssessment: src.bewertung_kurz || src.impactAssessment || fallback.impactAssessment,
    impactRanking: Array.isArray(src.impactRanking) && src.impactRanking.length > 0 ? src.impactRanking : fallback.impactRanking,
    positiveMentions: src.positiveMentions ?? fallback.positiveMentions ?? 0,
    negativeMentions: src.negativeMentions ?? fallback.negativeMentions ?? 0,
    opposingPositiveMentions: src.opposingPositiveMentions ?? fallback.opposingPositiveMentions ?? 0,
    opposingNegativeMentions: src.opposingNegativeMentions ?? fallback.opposingNegativeMentions ?? 0,
    rawText: effectiveRawText,
    message: src.benachteiligung_indiz || src.message || fallback.message
  });
}

function mapBiasForensicJsonToAnalysis(parsed, fallback = {}, rawText = "") {
  const src = parsed && typeof parsed === "object" ? parsed : {};

  const disadvantaged = src.benachteiligte_person && typeof src.benachteiligte_person === "object"
    ? src.benachteiligte_person
    : null;
  const opposing = src.gegenpartei && typeof src.gegenpartei === "object"
    ? src.gegenpartei
    : null;

  // Backward compatibility for previous prompt iterations.
  const targetA = src.target_a && typeof src.target_a === "object" ? src.target_a : null;
  const targetB = src.target_b && typeof src.target_b === "object" ? src.target_b : null;

  const finalPosA = Math.max(
    0,
    Number(disadvantaged?.positiv ?? src.benachteiligte_person_positiv ?? targetA?.positive ?? 0)
  );
  const finalNegA = Math.max(
    0,
    Number(disadvantaged?.negativ ?? src.benachteiligte_person_negativ ?? targetA?.negative ?? 0)
  );
  const finalPosB = Math.max(
    0,
    Number(opposing?.positiv ?? src.gegenpartei_positiv ?? targetB?.positive ?? 0)
  );
  const finalNegB = Math.max(
    0,
    Number(opposing?.negativ ?? src.gegenpartei_negativ ?? targetB?.negative ?? 0)
  );

  // People list
  const peopleSource = Array.isArray(src.personen) ? src.personen : [];
  const mappedPeople = peopleSource
    .map((entry) => {
      const name = normalizeWhitespace(typeof entry === "string" ? entry : entry?.name || "");
      if (!name) return null;
      return { name, affiliation: "Privatperson" };
    })
    .filter(Boolean);

  const impactRanking = [];
  if (finalNegA > 0 || finalPosA > 0) {
    impactRanking.push({
      name: fallback.disadvantagedPerson || "Benachteiligte Person",
      impact: finalNegA > 0 ? "benachteiligt" : "neutral",
      count: finalNegA,
      items: []
    });
  }
  if (finalNegB > 0 || finalPosB > 0) {
    impactRanking.push({
      name: "Gegenpartei",
      impact: finalNegB > 0 ? "benachteiligt" : "neutral",
      count: finalNegB,
      items: []
    });
  }

  const qualitativeSummaryRaw = normalizeWhitespace(src.zusammenfassung || "");
  const qualitativeSummary = normalizeWhitespace(
    qualitativeSummaryRaw
      .replace(/\bMoechten\s+Sie\b[\s\S]*$/i, "")
      .replace(/\bMöchten\s+Sie\b[\s\S]*$/i, "")
      .replace(/\d+/g, "")
  );

  const topTitle = normalizeWhitespace(src.titel || "");
  const topAuthor = normalizeWhitespace(src.verfasser || "");
  const topDate = normalizeWhitespace(src.datum || "");
  const topSender = normalizeWhitespace(src.absender || src.herkunft || "");

  const effectivePeople = mappedPeople.length > 0 ? mappedPeople : fallback.people;

  return buildFallbackAnalysis({
    title: topTitle || fallback.title,
    author: topAuthor || topSender || fallback.author,
    documentType: fallback.documentType || "Brief",
    authoredDate: topDate || fallback.authoredDate,
    people: effectivePeople,
    disadvantagedPerson: fallback.disadvantagedPerson || "",
    senderInstitution: topSender || fallback.senderInstitution,
    impactAssessment: qualitativeSummary || fallback.impactAssessment,
    impactRanking: impactRanking.length > 0 ? impactRanking : fallback.impactRanking,
    positiveMentions: finalPosA,
    negativeMentions: finalNegA,
    opposingPositiveMentions: finalPosB,
    opposingNegativeMentions: finalNegB,
    rawText: effectivePeople.length > 0 ? "" : rawText,
    message: fallback.message
  });
}

function hasStrictForensicShape(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }

  const disadvantaged = parsed.benachteiligte_person;
  const opposing = parsed.gegenpartei;
  const hasNestedGroups = disadvantaged && opposing
    && typeof disadvantaged === "object"
    && typeof opposing === "object";

  if (hasNestedGroups) {
    const nums = [
      disadvantaged.positiv,
      disadvantaged.negativ,
      opposing.positiv,
      opposing.negativ
    ].map((v) => Number(v));
    return nums.every((v) => Number.isFinite(v) && v >= 0);
  }

  // Flat 4-number schema
  const hasFlatKeys = "benachteiligte_person_positiv" in parsed
    && "benachteiligte_person_negativ" in parsed
    && "gegenpartei_positiv" in parsed
    && "gegenpartei_negativ" in parsed;

  if (hasFlatKeys) {
    const nums = [
      parsed.benachteiligte_person_positiv,
      parsed.benachteiligte_person_negativ,
      parsed.gegenpartei_positiv,
      parsed.gegenpartei_negativ
    ].map((v) => Number(v));
    return nums.every((v) => Number.isFinite(v) && v >= 0);
  }

  // Fallback: target_a/target_b schema
  const tA = parsed.target_a;
  const tB = parsed.target_b;
  if (!tA || !tB || typeof tA !== "object" || typeof tB !== "object") {
    return false;
  }
  const nums = [tA.positive, tA.negative, tB.positive, tB.negative].map((v) => Number(v));
  return nums.every((v) => Number.isFinite(v) && v >= 0);
}

function hasUsableForensicResult(result) {
  const safe = result && typeof result === "object" ? result : {};
  const totalMentions = Number(safe.positiveMentions || 0)
    + Number(safe.negativeMentions || 0)
    + Number(safe.opposingPositiveMentions || 0)
    + Number(safe.opposingNegativeMentions || 0);

  return Boolean(
    normalizeWhitespace(safe.title || "")
    || normalizeWhitespace(safe.author || "")
    || normalizeWhitespace(safe.senderInstitution || "")
    || (Array.isArray(safe.people) && safe.people.length > 0)
    || totalMentions > 0
  );
}

function buildQuantitativeForensicPrompt(protectedPersonName = "", opposingPartyName = "") {
  const focusRaw = normalizeWhitespace(protectedPersonName);
  const referenceRaw = normalizeWhitespace(opposingPartyName);

  const focusAliases = focusRaw
    .split(",")
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const referenceAliases = referenceRaw
    .split(",")
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const focusKeywords = focusAliases.length > 0 ? focusAliases.join(", ") : "(keine)";
  const referenceKeywords = referenceAliases.length > 0 ? referenceAliases.join(", ") : "(keine)";

  return [
    "Du bist ein neutraler forensischer Linguistik-Experte fuer die Analyse von Behoerden- und Gerichtskommunikation.",
    "Deine Aufgabe ist die objektive Dekonstruktion von Texten auf institutionelle Voreingenommenheit (Bias).",
    "",
    "### 1. DYNAMISCHE DATEN-EXTRAKTION:",
    "Analysiere das Dokument und extrahiere folgende Metadaten:",
    "- TITEL: Erstelle einen praezisen Titel (z.B. 'Stellungnahme KESB').",
    "- VERFASSER: Die natuerliche Person, die das Dokument unterzeichnet hat.",
    "- DATUM: Erstellungsdatum (DD.MM.YYYY).",
    "- ABSENDER: Die Organisation oder Behoerde im Briefkopf (z.B. 'KESB Leimental').",
    "- PERSONEN: Extrahiere ALLE im Text genannten Klarnamen (inkl. Kinder, Partner, Sachbearbeiter) als Liste.",
    "",
    "### 2. IDENTIFIKATION DER PARTEIEN:",
    "Nutze fuer die Zuordnung der Parteien sowohl Dokumentkontext als auch die bereitgestellten Alias-Listen:",
    `- BENACHTEILIGTE_PERSON_KEYWORDS = [${focusKeywords}]`,
    `- GEGENPARTEI_KEYWORDS = [${referenceKeywords}]`,
    "- Fokus-Person = benachteiligte Person.",
    "- Referenz-Person = Gegenpartei.",
    "- Alle Aliase einer Liste gehoeren zu genau einer Partei und duerfen nicht als separate Personen behandelt werden.",
    "",
    "### 3. METHODISCHES ZAEHLVERFAHREN (FBI-PROFILING):",
    "Untersuche den Text Wort fuer Wort auf wertende Zuschreibungen und zaehle die Vorkommen im gesamten Dokument.",
    "",
    "NEGATIVE ERWAEHNUNG (ROT):",
    "Jede Stelle, an der Kritik, Abwertung, Defizitzuschreibung, Unterstellung mangelnder Kooperation oder Charakter-Diskreditierung erfolgt.",
    "Beispiele: 'will Interessen durchboxen', 'mangelnde Einsicht', 'weniger kooperativ', 'hat Muehe', 'selten gelingt'.",
    "",
    "POSITIVE ERWAEHNUNG (GRUEN):",
    "Jede Stelle, an der Lob, Kompetenzzuschreibung, Validierung von Argumenten, Eignung, Stabilitaet oder Empathie durch den Verfasser erfolgt.",
    "Beispiele: 'argumentationsfaehig', 'loesungsorientiert', 'geeignet', 'vertretbar', 'sinnvoll', 'eher in der Lage'.",
    "",
    "### 4. OUTPUT-REGELN (STRENGES FORMAT):",
    "- ZUSAMMENFASSUNG: Beschreibe das Muster der asymmetrischen Darstellung und die psychologische Tendenz des Verfassers in maximal 2 Saetzen. Nenne KEINE Zahlen im Text.",
    "- NULLEN-LOGIK: Gib fuer jede Person exakt EINE Summe fuer Positiv und EINE Summe fuer Negativ zurueck.",
    "- Zaehle konservativ, aber ignoriere keine klar wertenden Formulierungen.",
    "- Ignoriere neutrale Verfahrensangaben, reine Fakten, Adressen, Titel und Daten ohne Wertung.",
    "- Wenn mehrere Aliase derselben Partei in einer Aussage vorkommen, zaehlt das nur einmal fuer diese Partei.",
    "",
    "### JSON-SCHEMA (exakt einhalten):",
    "{",
    '  "titel": "",',
    '  "verfasser": "",',
    '  "datum": "",',
    '  "absender": "",',
    '  "personen": ["Name1", "Name2"],',
    '  "benachteiligte_person": {',
    '    "positiv": 0,',
    '    "negativ": 0',
    '  },',
    '  "gegenpartei": {',
    '    "positiv": 0,',
    '    "negativ": 0',
    '  },',
    '  "zusammenfassung": "Max 2 Saetze"',
    "}",
    "",
    "NUR JSON. Kein Markdown. Kein zusaetzlicher Text."
  ].join("\n");
}

function mapChatForensicJsonToAnalysis(parsed, fallback = {}) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const links = src?.beteiligte?.links || {};
  const rechts = src?.beteiligte?.rechts || {};
  const leftName = normalizeWhitespace(links?.name || "");
  const rightName = normalizeWhitespace(rechts?.name || "");

  const leftScore = src?.forensik_score?.links || {};
  const rightScore = src?.forensik_score?.rechts || {};
  const leftNeg = Math.max(0, Number(leftScore?.negativ_count || 0));
  const rightNeg = Math.max(0, Number(rightScore?.negativ_count || 0));

  let disadvantagedPerson = "";
  if (leftNeg > rightNeg && rightName && !/unbekannt/i.test(rightName)) {
    disadvantagedPerson = rightName;
  } else if (rightNeg > leftNeg && leftName && !/unbekannt/i.test(leftName)) {
    disadvantagedPerson = leftName;
  }

  const people = [];
  if (leftName && !/unbekannt/i.test(leftName)) {
    people.push({ name: leftName, affiliation: normalizeWhitespace(links?.rolle || "Partei A") || "Partei A" });
  }
  if (rightName && !/unbekannt/i.test(rightName)) {
    people.push({ name: rightName, affiliation: normalizeWhitespace(rechts?.rolle || "Partei B") || "Partei B" });
  }

  const impactRanking = [];
  if (leftName && !/unbekannt/i.test(leftName)) {
    impactRanking.push({
      name: leftName,
      impact: leftNeg > 0 ? "benachteiligt" : "neutral",
      count: leftNeg,
      items: Array.isArray(leftScore?.belege_negativ) ? leftScore.belege_negativ : []
    });
  }
  if (rightName && !/unbekannt/i.test(rightName)) {
    impactRanking.push({
      name: rightName,
      impact: rightNeg > 0 ? "benachteiligt" : "neutral",
      count: rightNeg,
      items: Array.isArray(rightScore?.belege_negativ) ? rightScore.belege_negativ : []
    });
  }

  return buildFallbackAnalysis({
    title: "Forensische Chat-Analyse",
    author: leftName && !/unbekannt/i.test(leftName) ? leftName : "",
    documentType: "Chat",
    authoredDate: "",
    people,
    disadvantagedPerson,
    senderInstitution: "Privat",
    impactAssessment: normalizeWhitespace(src?.analyse_fazit || ""),
    impactRanking,
    message: normalizeWhitespace(src?.benachteiligung_score || "") || fallback.message
  });
}

async function analyzeTextWithAi(documentText, fallback = {}, protectedPersonName = "", opposingPartyName = "") {
  const client = getOpenAiClient();
  if (!client) {
    return buildFallbackAnalysis(fallback);
  }

  const normalizedDocumentText = String(documentText || "");
  const maxChars = 50000;
  const textSnippet = normalizedDocumentText.length <= maxChars
    ? normalizedDocumentText
    : `${normalizedDocumentText.slice(0, 30000)}\n\n[... gekuerzt ...]\n\n${normalizedDocumentText.slice(-20000)}`;

  const aiCandidateNames = [
    ...extractPeopleFromLabeledFields(normalizedDocumentText, new Set()),
    ...extractPeopleFromSalutation(normalizedDocumentText, new Set()),
    ...extractPeopleFromContextPhrases(normalizedDocumentText, new Set()),
    ...extractPeopleFromStructuredRows(normalizedDocumentText, new Set())
  ]
    .map((entry) => (typeof entry === "string" ? normalizeWhitespace(entry) : normalizeWhitespace(entry?.name)))
    .filter(Boolean)
    .slice(0, 24);
  if (!textSnippet.trim()) {
    return buildFallbackAnalysis(fallback);
  }

  try {
    const response = await createChatCompletionWithFallback(client, {
      temperature: 0,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: buildQuantitativeForensicPrompt(protectedPersonName, opposingPartyName)
        },
        {
          role: "user",
          content: [
            aiCandidateNames.length > 0
              ? `Potenzielle Namen aus Voranalyse: ${aiCandidateNames.join(", ")}`
              : "Potenzielle Namen aus Voranalyse: (keine)",
            "",
            "TEXT ZUM ANALYSIEREN:",
            textSnippet
          ].join("\n")
        }
      ],
      response_format: { type: "json_object" }
    });

    const responseText = response?.choices?.[0]?.message?.content || "";
    let parsed = extractJsonObject(responseText);
    let mapped = null;

    if (parsed && typeof parsed === "object") {
      if (parsed?.benachteiligte_person || parsed?.gegenpartei || "benachteiligte_person_positiv" in parsed || parsed?.target_a || parsed?.target_b || parsed?.personen_auswertung || parsed?.auswertung || parsed?.statistik || parsed?.metadaten || parsed?.analyse_score) {
        mapped = mapBiasForensicJsonToAnalysis(parsed, fallback, textSnippet);
      } else {
        mapped = mapSwissForensicJsonToAnalysis(parsed, fallback, textSnippet);
      }
    }

    const needsRetry = !parsed
      || !hasStrictForensicShape(parsed)
      || !hasUsableForensicResult(mapped);

    if (!needsRetry) {
      return mapped;
    }

    const retry = await createChatCompletionWithFallback(client, {
      temperature: 0,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: [
            buildQuantitativeForensicPrompt(protectedPersonName, opposingPartyName),
            "",
            "KORREKTURHINWEIS:",
            "Deine letzte Antwort war nicht schema-konform oder nicht ausreichend auswertbar.",
            "Erzeuge jetzt NUR ein valides JSON gemass Schema.",
            "Keine Erklaerung, keine Einleitung, keine Rueckfrage."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            aiCandidateNames.length > 0
              ? `Potenzielle Namen aus Voranalyse: ${aiCandidateNames.join(", ")}`
              : "Potenzielle Namen aus Voranalyse: (keine)",
            "",
            "TEXT ZUM ANALYSIEREN:",
            textSnippet
          ].join("\n")
        }
      ],
      response_format: { type: "json_object" }
    });

    const retryText = retry?.choices?.[0]?.message?.content || "";
    const retryParsed = extractJsonObject(retryText);
    if (retryParsed && typeof retryParsed === "object") {
      if (retryParsed?.benachteiligte_person || retryParsed?.gegenpartei || "benachteiligte_person_positiv" in retryParsed || retryParsed?.target_a || retryParsed?.target_b || retryParsed?.personen_auswertung || retryParsed?.auswertung || retryParsed?.statistik || retryParsed?.metadaten || retryParsed?.analyse_score) {
        const retryMapped = mapBiasForensicJsonToAnalysis(retryParsed, fallback, textSnippet);
        if (hasUsableForensicResult(retryMapped)) {
          return retryMapped;
        }
      }
    }

    return mapped && hasUsableForensicResult(mapped)
      ? mapped
      : buildFallbackAnalysis(fallback);
  } catch (error) {
    console.error("Analyze text error:", error.message);
    return buildFallbackAnalysis(fallback);
  }
}

async function extractTitleFromImageWithAi(fileBuffer, mimeType, originalName = "", protectedPersonName = "", opposingPartyName = "") {
  const client = getOpenAiClient();
  if (!client) {
    return {
      status: "needs-ocr",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      disadvantagedPerson: "",
      message: "Bildtitel ben├Âtigt OCR oder KI-Analyse."
    };
  }

  const base64 = fileBuffer.toString("base64");

  const isChatHint = /whats?app|chat|nachricht|dialog|sms|signal|telegram|screen|screenshot/i.test(String(originalName || "").toLowerCase());

  try {
    const response = await createChatCompletionWithFallback(client, {
      temperature: 0,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: isChatHint
            ? [
              "Du bist ein forensischer Analyst fuer Dokumenten- und Kommunikationspruefung. Deine Aufgabe ist es, die Dynamik in diesem Dialog objektiv zu quantifizieren.",
              "",
              "1. ROLLEN-IDENTIFIKATION (VISUELLE LOGIK):",
              "- PARTEI A (Links/Absender): Die Person oder Sprechblase auf der linken Seite.",
              "- PARTEI B (Rechts/Empfaenger): Die Person oder Sprechblase auf der rechten Seite.",
              "- Identifiziere die Klarnamen beider Parteien aus dem Textinhalt, falls vorhanden.",
              "",
              "2. QUANTITATIVE BEPUNKTUNG (SENTIMENT-CHECK):",
              "Zaehle fuer jede Partei separat:",
              "- POSITIVE HINWEISE (+): Sachlichkeit, Kooperationsbereitschaft, Lob, neutrale Information.",
              "- NEGATIVE HINWEISE (-): Vorwuerfe, Beleidigungen, manipulative Unterstellungen, Drohungen, Rufschaedigung.",
              "",
              "3. FORENSISCHE MUSTERERKENNUNG:",
              "Suche nach Anzeichen von Charakter-Assassination, einseitiger Aggression und Systembenachteiligung.",
              "",
              "4. OUTPUT-FORMAT (STRENGES JSON):",
              "{",
              "  \"beteiligte\": {",
              "    \"links\": { \"name\": \"Name oder 'Unbekannt'\", \"rolle\": \"Partei A\" },",
              "    \"rechts\": { \"name\": \"Name oder 'Unbekannt'\", \"rolle\": \"Partei B\" }",
              "  },",
              "  \"forensik_score\": {",
              "    \"links\": { \"positiv_count\": 0, \"negativ_count\": 0, \"belege_negativ\": [] },",
              "    \"rechts\": { \"positiv_count\": 0, \"negativ_count\": 0, \"belege_negativ\": [] }",
              "  },",
              "  \"analyse_fazit\": \"Zusammenfassung der Dynamik und Identifikation der benachteiligten/angegriffenen Person.\",",
              "  \"benachteiligung_score\": \"Skala 1-10 (10 = extreme einseitige Benachteiligung)\"",
              "}"
            ].join("\n")
            : buildQuantitativeForensicPrompt(protectedPersonName, opposingPartyName)
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analysiere dieses Dokument und gib das JSON zurueck:"
            },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType || "image/png"};base64,${base64}` }
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    });

    const responseText = response?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(responseText);

    if (!parsed || typeof parsed !== "object") {
      return {
        status: "empty",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        disadvantagedPerson: "",
        message: "Kein klarer Inhalt im Bild erkannt."
      };
    }

    const normalized = parsed?.beteiligte
      ? mapChatForensicJsonToAnalysis(parsed, {})
      : (parsed?.auswertung || parsed?.statistik || parsed?.metadaten || parsed?.analyse_score)
        ? mapBiasForensicJsonToAnalysis(parsed, {}, "")
        : mapSwissForensicJsonToAnalysis(parsed, {}, "");

    const hasQuantitativeStats = Number(normalized.positiveMentions || 0) > 0
      || Number(normalized.negativeMentions || 0) > 0
      || Number(normalized.opposingPositiveMentions || 0) > 0
      || Number(normalized.opposingNegativeMentions || 0) > 0
      || Boolean(normalizeWhitespace(normalized.senderInstitution || ""));

    if (!hasQuantitativeStats && !normalized.title && !normalized.author && !normalized.authoredDate && normalized.people.length === 0) {
      return {
        status: "empty",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        disadvantagedPerson: "",
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
        disadvantagedPerson: "",
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
        disadvantagedPerson: "",
        message: "OpenAI-Limit erreicht. Bitte sp├ñter erneut versuchen."
      };
    }

    throw error;
  }
}

async function extractTextFromImageWithOcr(fileBuffer) {
  const languageCandidates = ["deu+eng", "eng"];

  try {
    const { createWorker } = require("tesseract.js");

    for (const lang of languageCandidates) {
      const worker = await createWorker(lang);
      try {
        const result = await worker.recognize(fileBuffer);
        const text = normalizeWhitespace(result?.data?.text || "");
        if (text.length >= 20) {
          return text;
        }
      } finally {
        await worker.terminate();
      }
    }

    return "";
  } catch (error) {
    console.warn("OCR warning:", error.message);
    return "";
  }
}

async function analyzeImageWithFallback(fileBuffer, mimeType, originalName = "", protectedPersonName = "", opposingPartyName = "") {
  const fileNameTitle = deriveTitleFromFileName(originalName);

  try {
    const imageResult = await extractTitleFromImageWithAi(fileBuffer, mimeType, originalName, protectedPersonName, opposingPartyName);
    if (imageResult.status !== "needs-ocr" && imageResult.status !== "needs-config") {
      return imageResult;
    }

    const ocrText = await extractTextFromImageWithOcr(fileBuffer);
    if (!ocrText) {
      return {
        ...imageResult,
        title: imageResult.title || fileNameTitle,
        message: "Bildtext konnte nicht klar via OCR erkannt werden."
      };
    }

    const fallback = buildHeuristicAnalysisFromText(ocrText, {});
    if (getOpenAiClient()) {
      const aiFromText = await analyzeTextWithAi(ocrText, fallback, protectedPersonName, opposingPartyName);
      if (aiFromText.status === "ok") {
        return aiFromText;
      }
    }

    return buildFallbackAnalysis({
      ...fallback,
      title: fallback.title || fileNameTitle,
      message: fallback.message || "Bildtext via OCR erkannt."
    });
  } catch (error) {
    const ocrText = await extractTextFromImageWithOcr(fileBuffer);
    if (!ocrText) {
      const statusCode = Number(error?.status || 0);
      const message = String(error?.message || "");
      if (statusCode === 401 || /Missing scopes:|insufficient permissions/i.test(message)) {
        return {
          status: "needs-config",
          title: fileNameTitle,
          author: "",
          authoredDate: "",
          people: [],
          disadvantagedPerson: "",
          message: "OpenAI-Bildanalyse nicht verfuegbar und OCR ohne klaren Text."
        };
      }
      throw error;
    }

    const fallback = buildHeuristicAnalysisFromText(ocrText, {});
    return buildFallbackAnalysis({
      ...fallback,
      title: fallback.title || fileNameTitle,
      message: fallback.message || "Bildanalyse via OCR-Fallback erstellt."
    });
  }
}

let ensureCaseColumnsPromise = null;

async function ensureCaseOptionalColumns() {
  if (!ensureCaseColumnsPromise) {
    ensureCaseColumnsPromise = (async () => {
      try {
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS protected_person_name text");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS opposing_party text");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS country text");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS locality text");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS region text");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS city text");
      } catch (err) {
        // If permissions are restricted, the compat fallbacks below still keep app functional.
        console.warn("Ensure case columns warning:", err.message);
      }

      try {
        await pool.query(
          "CREATE TABLE IF NOT EXISTS case_party_fallback (case_id text PRIMARY KEY, protected_person_name text, opposing_party text, country text, locality text, region text, city text)"
        );
        await pool.query("ALTER TABLE case_party_fallback ADD COLUMN IF NOT EXISTS country text");
        await pool.query("ALTER TABLE case_party_fallback ADD COLUMN IF NOT EXISTS locality text");
        await pool.query("ALTER TABLE case_party_fallback ADD COLUMN IF NOT EXISTS region text");
        await pool.query("ALTER TABLE case_party_fallback ADD COLUMN IF NOT EXISTS city text");
      } catch (err) {
        console.warn("Ensure case fallback table warning:", err.message);
      }
    })();
  }

  await ensureCaseColumnsPromise;
}

async function upsertCasePartiesFallback(caseId, protectedPerson, opposingParty, country, locality, region, city) {
  const normalizedId = String(caseId || "").trim();
  if (!/^\d{6}$/.test(normalizedId)) {
    return;
  }

  try {
    await pool.query(
      "INSERT INTO case_party_fallback (case_id, protected_person_name, opposing_party, country, locality, region, city) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (case_id) DO UPDATE SET protected_person_name = EXCLUDED.protected_person_name, opposing_party = EXCLUDED.opposing_party, country = EXCLUDED.country, locality = EXCLUDED.locality, region = EXCLUDED.region, city = EXCLUDED.city",
      [normalizedId, protectedPerson || null, opposingParty || null, country || null, locality || null, region || null, city || null]
    );
  } catch (err) {
    // Non-fatal: main flow must not break if fallback table is unavailable.
    console.warn("Upsert case fallback warning:", err.message);
  }
}

async function loadCasePartiesFallbackMap(caseIds = []) {
  const normalizedIds = Array.isArray(caseIds)
    ? caseIds.map((id) => String(id || "").trim()).filter((id) => /^\d{6}$/.test(id))
    : [];

  if (normalizedIds.length === 0) {
    return new Map();
  }

  try {
    const result = await pool.query(
      "SELECT case_id, protected_person_name, opposing_party, country, locality, region, city FROM case_party_fallback WHERE case_id = ANY($1::text[])",
      [normalizedIds]
    );

    const map = new Map();
    for (const row of result.rows || []) {
      map.set(String(row.case_id), {
        protected_person_name: normalizeWhitespace(row.protected_person_name || ""),
        opposing_party: normalizeWhitespace(row.opposing_party || ""),
        country: normalizeWhitespace(row.country || ""),
        locality: normalizeWhitespace(row.locality || ""),
        region: normalizeWhitespace(row.region || ""),
        city: normalizeWhitespace(row.city || "")
      });
    }
    return map;
  } catch (err) {
    return new Map();
  }
}

async function mergeCasePartiesFromFallback(rows = []) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const ids = inputRows.map((row) => String(row?.id || "")).filter((id) => /^\d{6}$/.test(id));
  const fallbackMap = await loadCasePartiesFallbackMap(ids);

  return inputRows.map((row) => {
    const id = String(row?.id || "");
    const fallback = fallbackMap.get(id);
    if (!fallback) {
      return {
        ...row,
        protected_person_name: row?.protected_person_name ?? null,
        opposing_party: row?.opposing_party ?? null,
        country: row?.country ?? null,
        locality: row?.locality ?? null,
        region: row?.region ?? null,
        city: row?.city ?? null
      };
    }

    const protectedFromRow = normalizeWhitespace(row?.protected_person_name || "");
    const opposingFromRow = normalizeWhitespace(row?.opposing_party || "");
    const countryFromRow = normalizeWhitespace(row?.country || "");
    const localityFromRow = normalizeWhitespace(row?.locality || "");
    const regionFromRow = normalizeWhitespace(row?.region || "");
    const cityFromRow = normalizeWhitespace(row?.city || "");

    return {
      ...row,
      protected_person_name: protectedFromRow || fallback.protected_person_name || null,
      opposing_party: opposingFromRow || fallback.opposing_party || null,
      country: countryFromRow || fallback.country || null,
      locality: localityFromRow || fallback.locality || null,
      region: regionFromRow || fallback.region || null,
      city: cityFromRow || fallback.city || null
    };
  });
}

async function listCasesCompat() {
  await ensureCaseOptionalColumns();
  try {
    const result = await pool.query(
      "SELECT id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city, created_at FROM cases ORDER BY created_at DESC LIMIT 200"
    );
    return mergeCasePartiesFromFallback(result.rows);
  } catch (err) {
    if (err?.code === "42703") {
      try {
        const fallback = await pool.query(
          "SELECT id, case_date, case_name, protected_person_name, country, locality, region, city, created_at FROM cases ORDER BY created_at DESC LIMIT 200"
        );
        return mergeCasePartiesFromFallback(fallback.rows.map((row) => ({ ...row, opposing_party: null })));
      } catch (err2) {
        if (err2?.code === "42703") {
          const fallback2 = await pool.query(
            "SELECT id, case_date, case_name, country, locality, region, city, created_at FROM cases ORDER BY created_at DESC LIMIT 200"
          );
          return mergeCasePartiesFromFallback(fallback2.rows.map((row) => ({ ...row, protected_person_name: null, opposing_party: null })));
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function createCaseCompat(caseId, caseDate, caseName, protectedPerson, opposingParty, country, locality, region, city) {
  await ensureCaseOptionalColumns();
  try {
    const result = await pool.query(
      "INSERT INTO cases (id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city, created_at",
      [caseId, caseDate, caseName, protectedPerson, opposingParty, country, locality, region, city]
    );
    await upsertCasePartiesFallback(caseId, protectedPerson, opposingParty, country, locality, region, city);
    return result.rows[0];
  } catch (err) {
    if (err?.code === "42703") {
      try {
        const fallback = await pool.query(
          "INSERT INTO cases (id, case_date, case_name, protected_person_name, country, locality, region, city) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, case_date, case_name, protected_person_name, country, locality, region, city, created_at",
          [caseId, caseDate, caseName, protectedPerson, country, locality, region, city]
        );
        await upsertCasePartiesFallback(caseId, protectedPerson, opposingParty, country, locality, region, city);
        return { ...fallback.rows[0], opposing_party: null };
      } catch (err2) {
        if (err2?.code === "42703") {
          const fallback2 = await pool.query(
            "INSERT INTO cases (id, case_date, case_name, country, locality, region, city) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, case_date, case_name, country, locality, region, city, created_at",
            [caseId, caseDate, caseName, country, locality, region, city]
          );
          await upsertCasePartiesFallback(caseId, protectedPerson, opposingParty, country, locality, region, city);
          return { ...fallback2.rows[0], protected_person_name: null, opposing_party: null };
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function getCaseParties(caseId) {
  await ensureCaseOptionalColumns();
  try {
    const result = await pool.query(
      "SELECT protected_person_name, opposing_party, country, locality, region, city FROM cases WHERE id = $1 LIMIT 1",
      [caseId]
    );
    const fallbackMap = await loadCasePartiesFallbackMap([caseId]);
    const fb = fallbackMap.get(String(caseId)) || { protected_person_name: "", opposing_party: "", country: "", locality: "", region: "", city: "" };
    const protectedFromRow = normalizeWhitespace(result.rows[0]?.protected_person_name || "");
    const opposingFromRow = normalizeWhitespace(result.rows[0]?.opposing_party || "");
    const countryFromRow = normalizeWhitespace(result.rows[0]?.country || "");
    const localityFromRow = normalizeWhitespace(result.rows[0]?.locality || "");
    const regionFromRow = normalizeWhitespace(result.rows[0]?.region || "");
    const cityFromRow = normalizeWhitespace(result.rows[0]?.city || "");
    return {
      protectedPersonName: protectedFromRow || fb.protected_person_name,
      opposingPartyName: opposingFromRow || fb.opposing_party,
      country: countryFromRow || fb.country,
      locality: localityFromRow || fb.locality,
      region: regionFromRow || fb.region,
      city: cityFromRow || fb.city
    };
  } catch (err) {
    if (err?.code === "42703") {
      try {
        const fallback = await pool.query(
          "SELECT protected_person_name, country, locality, region, city FROM cases WHERE id = $1 LIMIT 1",
          [caseId]
        );
        const fallbackMap = await loadCasePartiesFallbackMap([caseId]);
        const fb = fallbackMap.get(String(caseId)) || { protected_person_name: "", opposing_party: "", country: "", locality: "", region: "", city: "" };
        return {
          protectedPersonName: normalizeWhitespace(fallback.rows[0]?.protected_person_name || "") || fb.protected_person_name,
          opposingPartyName: fb.opposing_party,
          country: normalizeWhitespace(fallback.rows[0]?.country || "") || fb.country,
          locality: normalizeWhitespace(fallback.rows[0]?.locality || "") || fb.locality,
          region: normalizeWhitespace(fallback.rows[0]?.region || "") || fb.region,
          city: normalizeWhitespace(fallback.rows[0]?.city || "") || fb.city
        };
      } catch (err2) {
        if (err2?.code === "42703") {
          const fallbackMap = await loadCasePartiesFallbackMap([caseId]);
          const fb = fallbackMap.get(String(caseId)) || { protected_person_name: "", opposing_party: "", country: "", locality: "", region: "", city: "" };
          return {
            protectedPersonName: fb.protected_person_name,
            opposingPartyName: fb.opposing_party,
            country: fb.country,
            locality: fb.locality,
            region: fb.region,
            city: fb.city
          };
        }
        throw err2;
      }
    }
    throw err;
  }
}

function applyProtectedPersonFocus(analysis, rawText, protectedPersonName = "", opposingPartyName = "") {
  const protectedIdentity = parsePartyAliases(protectedPersonName);
  const opposingIdentity = parsePartyAliases(opposingPartyName);
  const protectedName = normalizeWhitespace(protectedIdentity.primary);
  const opposingName = normalizeWhitespace(opposingIdentity.primary);
  if ((!protectedName && !opposingName) || !analysis || typeof analysis !== "object") {
    return analysis;
  }

  const output = {
    ...analysis,
    people: Array.isArray(analysis.people) ? [...analysis.people] : [],
    impactRanking: Array.isArray(analysis.impactRanking) ? [...analysis.impactRanking] : []
  };

  const hasProtectedInPeople = output.people.some((entry) => {
    const name = normalizeWhitespace(typeof entry === "string" ? entry : entry?.name);
    return hasAnyPartyNeedle(name, protectedIdentity.aliases);
  });

  const lowerText = String(rawText || "").toLowerCase();
  const nameInText = hasAnyPartyNeedle(rawText, protectedIdentity.aliases);
  const hasAttackTerms = /(benachteilig|diskriminier|beleidig|angriff|abwert|verletz|schlecht\s+gemacht|unterschiedlich\s+gut|ungleich\s+behand)/.test(lowerText);
  const assessmentSuggestsHarm = /benachteiligt/i.test(String(output.impactAssessment || ""));

  if (!hasProtectedInPeople && (nameInText || protectedName)) {
    output.people.push({ name: protectedName, affiliation: "Privatperson", allowSingleToken: true });
  }

  const hasOpposingInPeople = output.people.some((entry) => {
    const name = normalizeWhitespace(typeof entry === "string" ? entry : entry?.name);
    return hasAnyPartyNeedle(name, opposingIdentity.aliases);
  });
  if (opposingName && !hasOpposingInPeople) {
    output.people.push({ name: opposingName, affiliation: "Privatperson", allowSingleToken: true });
  }

  const shouldFlagProtected = protectedName
    ? (nameInText && hasAttackTerms) || (hasProtectedInPeople && assessmentSuggestsHarm)
    : false;
  if (shouldFlagProtected) {
    output.disadvantagedPerson = protectedName;
    output.impactAssessment = "Person benachteiligt";
  }

  const normalizedPeople = normalizePeopleDetailed(output.people, rawText, new Set(), output.author || "");
  const existing = new Map();
  for (const item of output.impactRanking) {
    const key = normalizeWhitespace(item?.name).toLowerCase();
    if (!key) {
      continue;
    }
    existing.set(key, {
      count: Number(item?.count || 0),
      items: Array.isArray(item?.items) ? item.items : []
    });
  }

  if (shouldFlagProtected) {
    const key = protectedName.toLowerCase();
    const prev = existing.get(key) || { count: 0, items: [] };
    const hasTargetQuote = prev.items.some((it) => /unterschiedlich gute zusammenarbeit/i.test(String(it || "")));
    existing.set(key, {
      count: Math.max(1, prev.count),
      items: hasTargetQuote ? prev.items : [...prev.items, "Für die unterschiedlich gute Zusammenarbeit"]
    });
  }

  const aiLookup = {};
  for (const [nameKey, value] of existing.entries()) {
    aiLookup[nameKey] = value;
  }

  output.people = normalizedPeople;
  output.impactRanking = buildImpactRanking(normalizedPeople, output.disadvantagedPerson || "", aiLookup);

  const strictCounts = countStrictPartyClaims(rawText, protectedIdentity.aliases, opposingIdentity.aliases);
  const hasStrictCounts = strictCounts.groupA.positive > 0
    || strictCounts.groupA.negative > 0
    || strictCounts.groupB.positive > 0
    || strictCounts.groupB.negative > 0;

  if (hasStrictCounts) {
    output.positiveMentions = Math.max(0, strictCounts.groupA.positive);
    output.negativeMentions = Math.max(0, strictCounts.groupA.negative);
    output.opposingPositiveMentions = Math.max(0, strictCounts.groupB.positive);
    output.opposingNegativeMentions = Math.max(0, strictCounts.groupB.negative);
  }

  if (!normalizeWhitespace(output.author) && normalizeWhitespace(output.senderInstitution)) {
    output.author = normalizeWhitespace(output.senderInstitution);
  }

  const senderRaw = normalizeWhitespace(output.senderInstitution);
  const senderLower = senderRaw.toLowerCase();
  const authorLower = normalizeWhitespace(output.author).toLowerCase();
  const senderLooksInstitutional = /\b(kesb|gericht|amt|behoerde|behörde|verwaltung|kanzlei|anwal|schule|bank|versicherung|gmbh|\bag\b|zivil|bezirks|kantons)\b/i.test(senderRaw);
  const textSuggestsInstitution = /\b(kesb\s+[a-z]|kesb|gericht|behoerde|behörde|kanzlei|amt|verwaltung)\b/i.test(String(rawText || ""));

  if ((!senderRaw || senderLower === "privat") && textSuggestsInstitution) {
    const extracted = extractSenderInstitution(rawText, output.author || "");
    if (extracted) {
      output.senderInstitution = extracted;
    }
  }

  if (/\bbrief\b/i.test(String(output.documentType || ""))
    && normalizeWhitespace(output.author)
    && looksLikePersonName(output.author)
    && !senderLooksInstitutional
    && !textSuggestsInstitution
    && (!senderLower || senderLower === authorLower || senderLower.endsWith("(privat)"))) {
    output.senderInstitution = "Privat";
  }

  return output;
}

router.post("/", requireAuth, async (req, res) => {
  const {
    caseId,
    caseDate,
    caseName,
    protected_person_name: protectedPersonInput,
    opposing_party: opposingPartyInput,
    country: countryInput,
    locality: localityInput,
    region: regionInput,
    city: cityInput
  } = req.body;

  if (!caseId || !caseDate || !caseName) {
    return res.status(400).json({ error: "ID, Datum und Name sind erforderlich." });
  }

  const normalizedCaseId = String(caseId).trim();
  const normalizedCaseName = String(caseName).trim();

  if (!/^\d{6}$/.test(normalizedCaseId)) {
    return res.status(400).json({ error: "ID muss 6-stellig sein." });
  }

  try {
    const protectedPerson = String(protectedPersonInput || "").trim() || null;
    const opposingParty = String(opposingPartyInput || "").trim() || null;
    const country = String(countryInput || "").trim() || null;
    const locality = String(localityInput || "").trim() || null;
    const region = String(regionInput || "").trim() || null;
    const city = String(cityInput || "").trim() || null;
    const created = await createCaseCompat(normalizedCaseId, caseDate, normalizedCaseName, protectedPerson, opposingParty, country, locality, region, city);
    return res.status(201).json(created);
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
    const cases = await listCasesCompat();
    return res.json({ cases });
  } catch (err) {
    console.error("List cases error:", err.message);
    return res.status(500).json({ error: "Fallliste konnte nicht geladen werden." });
  }
});

router.delete("/:caseId", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }

  try {
    const result = await pool.query("DELETE FROM cases WHERE id = $1 RETURNING id", [caseId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Fall nicht gefunden." });
    }
    return res.json({ ok: true, caseId });
  } catch (err) {
    console.error("Delete case error:", err.message);
    return res.status(500).json({ error: "Fall konnte nicht gelöscht werden." });
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

    const bucket = getStorageBucket();
    if (!bucket) {
      return res.status(503).json({ error: "Supabase Storage ist nicht konfiguriert." });
    }

    try {
      const caseExists = await pool.query("SELECT id FROM cases WHERE id = $1 LIMIT 1", [caseId]);
      if (caseExists.rows.length === 0) {
        return res.status(404).json({ error: "Fall nicht gefunden." });
      }

      const inserted = [];
      for (const file of req.files) {
        const decodedOriginalName = decodeOriginalFileName(file.originalname);
        const storedName = createStoredName(decodedOriginalName);
        const objectPath = `${caseId}/${storedName}`;

        const { error: uploadError } = await bucket.upload(objectPath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

        if (uploadError) {
          throw new Error(`Storage upload failed: ${uploadError.message}`);
        }

        let result;
        try {
          result = await pool.query(
            "INSERT INTO case_documents (case_id, original_name, stored_name, mime_type, size_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING id, case_id, original_name, mime_type, size_bytes, uploaded_at",
            [caseId, decodedOriginalName, objectPath, file.mimetype, file.size]
          );
        } catch (dbError) {
          await bucket.remove([objectPath]);
          throw dbError;
        }

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
    return res.status(400).json({ error: "Ung├╝ltige Fall-ID." });
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
    return res.status(400).json({ error: "Ung├╝ltige Fall-ID." });
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

    const fileBuffer = await downloadStorageFile(caseId, file.stored_name);

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    return res.send(fileBuffer);
  } catch (err) {
    if (Number(err?.statusCode || 0) === 404 || Number(err?.statusCode || 0) === 503) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Preview file error:", err.message);
    return res.status(500).json({ error: "Dateivorschau konnte nicht geladen werden." });
  }
});

router.get("/:caseId/files/:fileId/download", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ung├╝ltige Fall-ID." });
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

    const fileBuffer = await downloadStorageFile(caseId, file.stored_name);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    return res.send(fileBuffer);
  } catch (err) {
    if (Number(err?.statusCode || 0) === 404 || Number(err?.statusCode || 0) === 503) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Download file error:", err.message);
    return res.status(500).json({ error: "Datei konnte nicht heruntergeladen werden." });
  }
});

router.get("/:caseId/files/:fileId/analysis", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();
  const forceRefresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
  const onlyStored = ["1", "true", "yes"].includes(String(req.query.onlyStored || "").toLowerCase());

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ung├╝ltige Fall-ID." });
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

    if (!forceRefresh) {
      const stored = await loadStoredDocumentAnalysis(file.id);
      if (stored && typeof stored === "object") {
        return res.json(withAnalysisRuntimeMeta(stored));
      }
      if (onlyStored) {
        return res.json(withAnalysisRuntimeMeta({
          status: "empty",
          documentType: "",
          title: "",
          author: "",
          authoredDate: "",
          people: [],
          disadvantagedPerson: "",
          senderInstitution: "",
          impactAssessment: "",
          impactRanking: [],
          message: "Analyse noch nicht vorhanden. Bitte auf das KI-Icon klicken oder beim Upload analysieren."
        }));
      }
    }

    const fileBuffer = await downloadStorageFile(caseId, file.stored_name);

    if (String(file.mime_type || "").includes("pdf")) {
      try {
        const parties = await getCaseParties(caseId);
        const pdfParse = getPdfParse();
        if (!pdfParse) {
          return res.json(withAnalysisRuntimeMeta({
            status: "empty",
            title: "",
            author: "",
            authoredDate: "",
            people: [],
            disadvantagedPerson: "",
            message: "PDF-Parser ist aktuell nicht verfuegbar."
          }));
        }
        const parsed = await pdfParse(fileBuffer);
        const fallback = buildHeuristicAnalysisFromText(parsed?.text || "", parsed?.info || {});
        const aiResult = await analyzeTextWithAi(parsed?.text || "", fallback, parties.protectedPersonName, parties.opposingPartyName);
        const focused = applyProtectedPersonFocus(aiResult, parsed?.text || "", parties.protectedPersonName, parties.opposingPartyName);
        await saveDocumentAnalysis(file.id, focused);
        return res.json(withAnalysisRuntimeMeta(focused));
      } catch (pdfError) {
        console.error("PDF parse warning:", pdfError.message);
        const fallback = {
          status: "empty",
          title: "",
          author: "",
          authoredDate: "",
          people: [],
          disadvantagedPerson: "",
          message: "PDF-Inhalt konnte nicht gelesen werden (m├Âglicherweise Scan oder defekter Textlayer)."
        };
        await saveDocumentAnalysis(file.id, fallback);
        return res.json(withAnalysisRuntimeMeta(fallback));
      }
    }

    if (String(file.mime_type || "").startsWith("image/")) {
      const parties = await getCaseParties(caseId);
      const imageResult = await analyzeImageWithFallback(fileBuffer, file.mime_type, file.original_name, parties.protectedPersonName, parties.opposingPartyName);
      const focused = applyProtectedPersonFocus(imageResult, "", parties.protectedPersonName, parties.opposingPartyName);
      await saveDocumentAnalysis(file.id, focused);
      return res.json(withAnalysisRuntimeMeta(focused));
    }

    const unsupported = {
      status: "empty",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      disadvantagedPerson: "",
      message: "Analyse f├╝r diesen Dateityp nicht verf├╝gbar."
    };
    await saveDocumentAnalysis(file.id, unsupported);
    return res.json(withAnalysisRuntimeMeta(unsupported));
  } catch (err) {
    if (Number(err?.statusCode || 0) === 404 || Number(err?.statusCode || 0) === 503) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Analyze file error:", err.message);
    return res.status(500).json({ error: "Dateianalyse konnte nicht geladen werden." });
  }
});

router.delete("/:caseId/files/:fileId", requireAuth, async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ung├╝ltige Fall-ID." });
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

    const bucket = getStorageBucket();
    if (!bucket) {
      return res.status(503).json({ error: "Supabase Storage ist nicht konfiguriert." });
    }

    await pool.query("DELETE FROM case_documents WHERE case_id = $1 AND id = $2", [caseId, fileId]);

    const objectPath = resolveStorageObjectPath(caseId, file.stored_name);
    const { error: removeError } = await bucket.remove([objectPath]);
    if (removeError) {
      console.warn("Storage delete warning:", removeError.message);
    }

    return res.json({ ok: true, id: fileId });
  } catch (err) {
    console.error("Delete file error:", err.message);
    return res.status(500).json({ error: "Datei konnte nicht gel├Âscht werden." });
  }
});

module.exports = router;
