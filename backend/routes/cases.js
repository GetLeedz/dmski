const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { requireAuth, requireCaseAccess, setCaseAccessPool } = require("../middleware/auth");
const { analyzeLegalDocument, analyzeDossierCrossDocument, consolidatePersons } = require("../services/analysisService");

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
setCaseAccessPool(pool);
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
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  // Images
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  // Videos
  "video/quicktime",
  "video/mp4",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
  "video/avi",
  "video/3gpp",
  // Audio
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  // E-Mails
  "application/vnd.ms-outlook",
  "message/rfc822"
]);

const allowedExtensions = new Set([
  "pdf","doc","docx","xls","xlsx","ppt","pptx","txt","csv",
  "jpg","jpeg","png","tiff","tif","webp","heic","heif","gif","bmp",
  "mov","mp4","avi","mkv","webm","3gp","m4v","wmv","flv","ts","mts","m2ts",
  "mp3","m4a","wav","aac","ogg","flac","wma","opus","m4b",
  "msg","eml"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    // Accept if MIME type is in the allowed set
    if (allowedMimeTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    // Fallback: accept if file extension is in the allowed set
    const ext = String(file.originalname || "").toLowerCase().split(".").pop() || "";
    if (allowedExtensions.has(ext)) {
      return cb(null, true);
    }
    // Accept generic octet-stream (browser didn't detect MIME – allow and let analysis decide)
    if (file.mimetype === "application/octet-stream" || !file.mimetype) {
      return cb(null, true);
    }
    cb(new Error("Nicht unterstütztes Dateiformat. Bitte PDF, DOCX, JPG, PNG, MOV, MP4, MP3, WAV u.v.m. hochladen."));
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
let pdfJsLibPromise = null;
let pdfJsLoadLogged = false;
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
  // Legacy – kept for compatibility but Claude is now preferred
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) return null;
  if (!openAiClient) openAiClient = new OpenAI({ apiKey: key });
  return openAiClient;
}

// ── Claude API for all analyses (replaces OpenAI) ──
const Anthropic = require("@anthropic-ai/sdk");
let anthropicClient = null;

function getAnthropicClient() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

async function callClaudeText(systemPrompt, userContent, maxTokens = 2000) {
  const client = getAnthropicClient();
  if (!client) return null;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }]
  });

  return response?.content?.[0]?.text || "";
}

async function callClaudeVision(systemPrompt, userText, base64Image, mimeType, maxTokens = 1500) {
  const client = getAnthropicClient();
  if (!client) return null;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    temperature: 0,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: userText },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType || "image/png",
            data: base64Image
          }
        }
      ]
    }]
  });

  return response?.content?.[0]?.text || "";
}

async function getPdfJsLib() {
  if (pdfJsLibPromise) {
    return pdfJsLibPromise;
  }

  pdfJsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((mod) => mod || null)
    .catch((error) => {
      if (!pdfJsLoadLogged) {
        console.error("PDF.js unavailable:", error.message);
        pdfJsLoadLogged = true;
      }
      return null;
    });

  return pdfJsLibPromise;
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

// ── Strict person/date validation for analysis output ──

const BLOCKED_ORG_PATTERNS_CASES = [
  /\bukbb\b/i, /\bkesb\b/i, /\bgericht\b/i, /\bspital\b/i, /\bkinderspital\b/i,
  /\bpolizei\b/i, /\bkantonsgericht\b/i, /\bbezirksgericht\b/i, /\bbundesgericht\b/i,
  /\bsozialamt\b/i, /\bjugendamt\b/i, /\bsozialdienst\b/i, /\bkindesschutz\b/i,
  /\bstaatsanwaltschaft\b/i, /\bschule\b/i, /\bklinik\b/i, /\bpraxis\b/i,
  /\buniversit[äa]t/i, /\binstitut\b/i, /\bamt\b/i, /\bbeh[öo]rde\b/i,
  /\bstiftung\b/i, /\bverein\b/i, /\bverband\b/i, /\bversicherung\b/i,
  /\bmedizinisch/i, /\brezept\b/i, /\bgutachten\b/i, /\bverf[üu]gung\b/i,
  /\bprotokoll\b/i, /\bstellungnahme\b/i, /\bbericht\b/i, /\bdokument\b/i,
  /\bergotherapie\b/i, /\bsozialkompetenz/i, /\bdiagnose\b/i,
  /\bbehandlung\b/i, /\btherapie\b/i, /\btraining\b/i,
  /\bGmbH\b/i, /\b(AG|SA)\b/,
];

function isHumanNameCases(name) {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed === "-") return false;
  if (BLOCKED_ORG_PATTERNS_CASES.some(p => p.test(trimmed))) return false;
  if (!/[a-zA-ZäöüÄÖÜàáâèéêìíîòóôùúû]/.test(trimmed)) return false;
  if (/\d/.test(trimmed)) return false;
  return true;
}

function normalizeDateFieldCases(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return "-";
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;
  const twoDigitYear = raw.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (twoDigitYear) {
    const yy = Number(twoDigitYear[3]);
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy;
    return `${twoDigitYear[1]}.${twoDigitYear[2]}.${yyyy}`;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
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

/**
 * Detects semantically garbage text that looks "readable" to simple char-based
 * quality checks but is actually OCR noise (random words, no sentence structure).
 *
 * Heuristics:
 * - Very few real German/French words (< 20% dictionary hit rate)
 * - Too many ALL-CAPS or single-char tokens
 * - No sentence-ending punctuation (no periods, question marks)
 * - Average word length is abnormal (< 2.5 or > 12)
 */
function isGarbageText(value) {
  const text = String(value || "").trim();
  if (!text || text.length < 30) return true;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return true;

  // Check for sentence structure: at least some periods or sentence-enders
  const sentenceEnders = (text.match(/[.!?;:]\s/g) || []).length;
  const hasSentences = sentenceEnders >= 1;

  // Average word length
  const totalLen = tokens.reduce((sum, t) => sum + t.length, 0);
  const avgLen = totalLen / tokens.length;
  if (avgLen < 2.2 || avgLen > 14) return true;

  // Count very short tokens (1-2 chars, excluding common particles)
  const shortParticles = new Set(["in", "am", "an", "im", "um", "zu", "da", "so", "ob", "ja", "es", "er", "du", "ab", "je"]);
  const shortTokens = tokens.filter(t => t.length <= 2 && !shortParticles.has(t.toLowerCase())).length;
  if (shortTokens / tokens.length > 0.35) return true;

  // Count ALL-CAPS tokens (more than 3 chars) — normal text has few
  const capsTokens = tokens.filter(t => t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t)).length;
  if (capsTokens / tokens.length > 0.25) return true;

  // Common German words check — at least 15% should be recognizable
  const commonWords = new Set([
    "der", "die", "das", "und", "ist", "ein", "eine", "den", "dem", "des",
    "mit", "auf", "für", "von", "aus", "bei", "nach", "über", "vor", "wie",
    "als", "auch", "oder", "aber", "nicht", "wird", "hat", "sind", "war",
    "sich", "dass", "werden", "kann", "wurde", "haben", "sein", "sehr",
    "wir", "sie", "ich", "zur", "zum", "vom", "bis", "nur", "noch",
    "herr", "frau", "liebe", "guten", "tag", "datum", "betreff", "basel",
    "bern", "zürich", "schweiz", "kanton", "kind", "kinder", "eltern",
    "le", "la", "les", "de", "du", "des", "et", "en", "pour", "par",
    "patient", "patientin", "name", "adresse", "telefon", "mail"
  ]);
  const knownCount = tokens.filter(t => commonWords.has(t.toLowerCase().replace(/[.,;:!?()]/g, ""))).length;
  const knownRatio = knownCount / tokens.length;

  // If no sentences AND low known-word ratio → garbage
  if (!hasSentences && knownRatio < 0.12) return true;

  // Even with some sentences, very low known ratio is suspicious
  if (knownRatio < 0.06) return true;

  return false;
}

function normalizeExtractedDocumentText(value) {
  return String(value || "")
    .replace(/-\s*\r?\n\s*/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/(?<=\p{L})\n(?=\p{L})/gu, " ")
    .replace(/\bsollso\b/gi, "soll so")
    .replace(/\s+/g, " ")
    .trim();
}

function countSuspiciousPdfTokens(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => /�|[;:_]{2,}|["'`][\p{L}\p{N}]|[\p{L}\p{N}]["'`][\p{L}\p{N}]|[\p{L}][^\s]*[";:_][^\s]*[\p{L}]/u.test(token))
    .length;
}

function scoreExtractedTextQuality(value) {
  const text = String(value || "");
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const suspiciousTokens = countSuspiciousPdfTokens(trimmed);
  const letters = (trimmed.match(/\p{L}/gu) || []).length;
  const readableChars = (trimmed.match(/[\p{L}\p{N}\s.,;:!?()/%-]/gu) || []).length;
  const tokenQuality = Math.max(0, (tokens.length - suspiciousTokens) / Math.max(tokens.length, 1));
  const charQuality = readableChars / Math.max(trimmed.length, 1);
  const letterDensity = Math.min(1, letters / Math.max(trimmed.length * 0.45, 1));

  return (tokenQuality * 0.5) + (charQuality * 0.25) + (letterDensity * 0.25);
}

function shouldUsePdfOcrFallback(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return true;
  }

  const suspiciousTokens = countSuspiciousPdfTokens(trimmed);
  const quality = scoreExtractedTextQuality(trimmed);
  return suspiciousTokens >= 8 || quality < 0.84;
}

/**
 * Detects and removes duplicate pages from extracted PDF text.
 * PDFs sometimes contain repeated pages (scanned twice, copied pages).
 * Duplicate content inflates AI scoring and wastes tokens.
 *
 * Strategy: Split text into page-sized blocks, fingerprint each,
 * remove blocks whose fingerprint matches an earlier block.
 */
function deduplicatePdfPages(text) {
  if (!text || typeof text !== "string") return text;

  // Split by form-feed (common page delimiter in pdf-parse output)
  // or by double-newline + page-like breaks
  let pages = text.split(/\f/);

  // If no form-feeds, try splitting by common page break patterns
  if (pages.length <= 1) {
    pages = text.split(/\n{3,}/);
  }

  // Only deduplicate if we have multiple segments
  if (pages.length <= 1) return text;

  const seen = new Set();
  const unique = [];

  for (const page of pages) {
    const trimmed = page.trim();
    if (!trimmed) continue;

    // Create a fingerprint: lowercase, collapse whitespace, take first 200 + last 200 chars
    const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");

    // Skip very short segments (headers, page numbers)
    if (normalized.length < 50) {
      unique.push(page);
      continue;
    }

    // Fingerprint: first 200 + last 200 chars (handles minor OCR differences)
    const fp = normalized.slice(0, 200) + "||" + normalized.slice(-200);

    if (seen.has(fp)) {
      // Duplicate page detected – skip it
      continue;
    }

    // Also check for high similarity (>90% overlap) with existing pages
    let isDuplicate = false;
    for (const existingFp of seen) {
      if (existingFp.length > 0 && fp.length > 0) {
        // Quick check: if first 100 chars match, likely duplicate
        const fpStart = fp.slice(0, 100);
        const existStart = existingFp.slice(0, 100);
        if (fpStart === existStart) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) continue;

    seen.add(fp);
    unique.push(page);
  }

  return unique.join("\n\n");
}

function pickBetterPdfText(primaryText, ocrText) {
  // Deduplicate pages BEFORE normalization (form-feeds are lost after normalize)
  const dedupedPrimary = deduplicatePdfPages(String(primaryText || ""));
  const dedupedOcr = deduplicatePdfPages(String(ocrText || ""));

  const normalizedPrimary = normalizeExtractedDocumentText(dedupedPrimary);
  const normalizedOcr = normalizeExtractedDocumentText(dedupedOcr);
  if (!normalizedOcr) {
    return normalizedPrimary;
  }
  if (!normalizedPrimary) {
    return normalizedOcr;
  }

  const primaryScore = scoreExtractedTextQuality(normalizedPrimary);
  const ocrScore = scoreExtractedTextQuality(normalizedOcr);
  return ocrScore >= primaryScore + 0.03 ? normalizedOcr : normalizedPrimary;
}

const BACKEND_INSTANCE_STARTED_AT = new Date().toISOString();

// No startup purge — analyses are preserved across deploys.
// Use "Alle neu analysieren" button or ?refresh=1 to re-analyze individual files.
(async () => {
})();

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
    "aufzeichnungen",
    "das dokument",
    "die dokument",
    "ein dokument",
    "das schreiben",
    "die verfuegung",
    "die verfügung",
    "der bericht",
    "das gutachten",
    "der entscheid",
    "das urteil",
    "die eingabe",
    "das protokoll",
    "die mitteilung",
    "der brief",
    "die antwort",
    "die beschwerde",
    "das verfahren",
    "der antrag",
    "die massnahme",
    "die maßnahme",
    "das ergebnis",
    "der beschluss",
    "die anordnung",
    "sehr geehrte",
    "freundlichen",
    "beilage",
    "betreff",
    "einschreiben",
    "mitteilung",
    "einleitung",
    "gegenstand",
    "stellungnahme",
    "fortschritte",
    "training",
    "sozialkompetenztraining",
    "ergotherapeutisches",
    "ergotherapie",
    "therapie",
    "behandlung",
    "gruppentraining",
    "information",
    "diagnose",
    "verordnung",
    "positiver",
    "deutlich",
    "allgemeine",
    "zusammenfassung",
    "einordnung",
    "bewertung",
    "beurteilung",
    "professioneller",
    "professionelle",
    "professionell",
    "sekretariat",
    "spital",
    "kinderspital",
    "klinik",
    "praxis",
    "kindergarten",
    "ukbb",
    "universitäts",
    "universität",
    "medizinisches",
    "rezept",
    "kinderspital",
    "kantonsgericht",
    "bezirksgericht",
    "familiengericht",
    "polizei",
    "staatsanwaltschaft",
    "sozialdienst",
    "jugendamt",
    "schulhaus",
    "tagesstruktur",
    "betreuung",
    "abklaerung",
    "abklärung",
    "gutachterlich",
    "kindesschutz",
    "sorgerecht",
    "besuchsrecht",
    "obhut",
    "erziehungsbeistandschaft",
    "verfuegung",
    "anordnung",
    "superprovisorisch",
    "massnahme",
    "vormundschaft",
    "pflegefamilie",
    "sozialbericht",
    "schulbericht",
    "arztbericht",
    "medizinisch",
    "psychiatrisch",
    "psychologisch",
    "neurologisch",
    "paediatrisch",
    "pädiatrisch",
    "ambulant",
    "stationaer",
    "stationär",
    "notfall",
    "rettung",
    "spitex",
    "sozialversicherung",
    "invalidenversicherung",
    "unfallversicherung",
    "beider basel",
    "kanton",
    "gemeinde",
    "regierungsrat",
    "stadtrat",
    "bundesgericht",
    "obergericht",
    "nachmittag",
    "vormittag",
    "morgen",
    "abend",
    "nacht",
    "mittagessen",
    "zwischenbericht",
    "schlussbericht",
    "empfehlung",
    "antragstellung",
    "verhandlung",
    "anhörung",
    "anhoerung",
    "protokollnotiz",
    "aktennotiz",
    "telefonnotiz",
    "gespraechsnotiz",
    "gesprächsnotiz"
  ];

  const lower = cleaned.toLowerCase();
  if (forbidden.some((item) => lower.includes(item))) {
    return false;
  }

  // Block institution patterns (parentheses, email domains)
  if (/[()@]/.test(cleaned) || /\.(ch|com|org|de|net)$/i.test(cleaned)) {
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

  // Each significant word must be at least 3 chars (blocks OCR garbage like "Lh", "Dov")
  // Exception: known name particles (von, de, di, van, le, du, el, al)
  const nameParticles = new Set(["von", "de", "di", "van", "le", "du", "el", "al", "da", "la", "lo"]);
  const significantParts = parts.filter((p) => !nameParticles.has(p.toLowerCase()));
  if (significantParts.some((p) => p.replace(/[.']/g, "").length < 3)) {
    return false;
  }

  // Block possessive phrases like "Timurs Fortschritte" — first word ends in 's'
  // and second word is a common noun (starts uppercase in German but isn't a surname)
  if (parts.length === 2 && /s$/i.test(parts[0]) && forbidden.some(f => parts[1].toLowerCase().includes(f))) {
    return false;
  }

  // Allow lowercase abbreviations like "med.", "von", "de" in names
  return parts.every((part) => /^(?:\p{Lu}[\p{Ll}\p{M}'-]+|\p{Lu}[\p{Ll}\p{M}'-]*\.|\p{Ll}{2,4}\.)$/u.test(part));
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

  // Family roles (check before generic "mutter" match)
  if (raw.includes("kindsmutter") || raw.includes("kindesmutter") || raw.includes("mutter des kindes")) {
    return "Kindsmutter";
  }
  if (raw.includes("kindsvater") || raw.includes("kindesvater") || raw.includes("vater des kindes")) {
    return "Kindsvater";
  }
  if (raw === "mutter" || raw.startsWith("mutter ") || raw.endsWith(" mutter")) {
    return "Mutter";
  }
  if (raw === "vater" || raw.startsWith("vater ") || raw.endsWith(" vater")) {
    return "Vater";
  }
  if (raw === "kind" || raw.startsWith("kind ") || raw === "sohn" || raw === "tochter") {
    return "Kind";
  }
  if (raw.includes("kinderanwalt") || raw.includes("kinderanwältin") || raw.includes("kindesanwalt") || raw.includes("kindesanwältin") || raw.includes("kinderanwaelt")) {
    return "Kinderanwalt";
  }
  if (raw.includes("ex-frau") || raw.includes("exfrau")) return "Ex-Frau";
  if (raw.includes("ex-mann") || raw.includes("exmann")) return "Ex-Mann";
  if (raw.includes("ex-partner") || raw.includes("expartner")) return "Ex-Partner/in";

  if (raw.includes("berufsbeistand") || raw.includes("beistandin") || raw.includes("beiständin") || raw.includes("beistand")) {
    return "Berufsbeistand";
  }

  if (raw.includes("anwalt") || raw.includes("anwältin") || raw.includes("anwaeltin") || raw.includes("advokat") || raw.includes("rechtsvertr")) {
    return "Anwalt";
  }

  if (raw.includes("gerichtspräsident") || raw.includes("gerichtsprasident") || raw.includes("richter") || raw.includes("richterin")) {
    return "Gerichtspräsident";
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

  // Professional / forensic roles – keep full label for compound roles
  if (raw.includes("leiter") || raw.includes("leiterin")) {
    // Keep the full label so "Leiter Jugendforensik" displays meaningfully
    return normalizeWhitespace(value);
  }
  if (raw.includes("forensik") || raw.includes("forensisch")) {
    return normalizeWhitespace(value) || "Gutachter/in";
  }
  if (raw.includes("gutacht")) {
    return "Gutachter/in";
  }
  if (raw.includes("psychiater") || raw.includes("psychiatrin") || raw.includes("psychiatrie")) {
    return "Psychiater/in";
  }
  if (raw.includes("psycholog")) {
    return "Psychologe/in";
  }
  if (raw.includes("arzt") || raw.includes("ärztin") || raw.includes("aerzt")) {
    return "Arzt / Ärztin";
  }
  if (raw.includes("therapeut")) {
    return "Therapeut/in";
  }
  if (raw.includes("mediator") || raw.includes("mediation")) {
    return "Mediator/in";
  }
  if (raw.includes("sozialarb") || raw.includes("sozialpad") || raw.includes("sozialpäd")) {
    return "Sozialarbeiter/in";
  }

  if (raw.includes("privat")) {
    return "Privatperson";
  }

  // If the raw value is a non-empty, meaningful string (not a single generic word),
  // pass it through so the UI can display it instead of "–"
  const cleaned = normalizeWhitespace(value);
  if (cleaned && cleaned.length > 2 && !/^privatperson$/i.test(cleaned)) {
    return cleaned;
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

    // Family roles
    if (/kindsmutter|kindesmutter|mutter\s+d[eo][sr]/.test(line)) {
      return "Kindsmutter";
    }
    if (/kindsvater|kindesvater|vater\s+d[eo][sr]/.test(line)) {
      return "Kindsvater";
    }
    if (/\bmutter\b/.test(line)) {
      return "Mutter";
    }
    if (/\bvater\b/.test(line)) {
      return "Vater";
    }
    // Children
    if (/\bkind\b|\bsohn\b|\btochter\b|\bminderjährig/.test(line)) {
      return "Kind";
    }
    // Professional forensic/psychiatric roles
    if (/leiter\s+jugendforensik|leiterin\s+jugendforensik|jugendforensik/.test(line)) {
      return "Leiter Jugendforensik";
    }
    if (/\bleiter\b|\bleiterin\b/.test(line)) {
      // Try to grab the full context, e.g. "Leiter Jugendforensik"
      const m = line.match(/\bleiter(?:in)?\s+([a-zäöüß\s]{3,30})/);
      if (m) return `Leiter ${m[1].trim().replace(/\s+/g, " ")}`;
      return "Leiter/in";
    }
    if (/gutachter|gutachterin|sachverst/.test(line)) {
      return "Gutachter/in";
    }
    if (/psychiater|psychiaterin|psychiatrie/.test(line)) {
      return "Psychiater/in";
    }
    if (/psycholog/.test(line)) {
      return "Psychologe/in";
    }
    if (/therapeut/.test(line)) {
      return "Therapeut/in";
    }
    // Legal/official roles
    if (/gericht|tribunal|court/.test(line)) {
      return "Gericht";
    }
    if (/berufsbeistand|beiständin|beistandin/.test(line)) {
      return "Berufsbeistand";
    }
    if (/\bbeistand\b/.test(line)) {
      return "Berufsbeistand";
    }
    if (/kinderanwalt|kinderanwältin|kinderanwaelt|kindesanwalt/.test(line)) {
      return "Kinderanwalt";
    }
    if (/für\s+sich\s+und\s+die\s+kinder|für\s+(?:sich\s+und\s+)?die\s+kinder/.test(line)) {
      return "Kinderanwalt";
    }
    if (/anwältin|anwalt|rechtsanwalt|advokat|rechtsvertr/i.test(line)) {
      return "Anwalt";
    }
    if (/gerichtspräsident|gerichtspr[äa]sident|\brichter\b|\brichterin\b/i.test(line)) {
      return "Gerichtspräsident";
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
  // Exclude author from person list — Verfasser shown in own UI field.
  const authorKey = normalizeWhitespace(authorName).toLowerCase();
  const strippedAuthorKey = authorKey.replace(/^(prof\.?\s*)?(dr\.?\s*(med\.?\s*)?)?/i, "").trim();

  for (const value of Array.isArray(values) ? values : []) {
    const inputName = typeof value === "string" ? value : value?.name;
    const inputAffiliation = typeof value === "object" && value ? value.affiliation : "";
    const allowSingleToken = typeof value === "object" && value ? value.allowSingleToken === true : false;

    let normalized = normalizeWhitespace(inputName).replace(/[;,]+$/g, "");
    normalized = normalized.replace(/^(Herrn?|Frau|Bruder|Schwester|Mutter|Vater)\s+/i, "");
    // Strip birth dates, gender markers, and trailing metadata from names
    normalized = normalized.replace(/,?\s*geb\.?\s*\d[\d.\-/\s]*/gi, "").replace(/,?\s*\b[mfw]\s*$/i, "").trim();
    // Strip academic/medical titles for cleaner name
    const strippedName = normalized.replace(/^(Prof\.?\s*)?(Dr\.?\s*(med\.?\s*)?)?/i, "").trim();
    // Use stripped name if it still has content, otherwise keep original
    const nameForValidation = strippedName.length >= 3 ? strippedName : normalized;

    if (!normalized || normalized.length < 3) {
      continue;
    }

    if (/[\-ÔÇô]\s*$/.test(normalized)) {
      continue;
    }

    // Accept if stripped name looks like person name, OR single capitalized surname
    const isValidName = looksLikePersonName(nameForValidation)
      || looksLikePersonName(normalized)
      || isAliasPerson(normalized)
      || /^\p{Lu}[\p{Ll}\p{M}'-]{2,}$/u.test(nameForValidation);

    if (!isValidName) {
      const singleTokenPattern = /^\p{Lu}[\p{Ll}\p{M}'-]{2,}$/u;
      if (!(allowSingleToken && singleTokenPattern.test(normalized))) {
        continue;
      }
    }

    const key = normalized.toLowerCase();
    const strippedKey = normalized.replace(/^(Prof\.?\s*)?(Dr\.?\s*(med\.?\s*)?)?/i, "").trim().toLowerCase();
    const isAuthor = authorKey && (key === authorKey || (strippedAuthorKey.length >= 3 && strippedKey === strippedAuthorKey));
    if (blocked.has(key) || isAuthor || seen.has(key)) {
      continue;
    }

    const inputSentiment = typeof value === "object" && value ? value.sentiment : "";
    const inputBemerkung = typeof value === "object" && value ? normalizeWhitespace(value.bemerkung || "") : "";
    seen.add(key);
    list.push({
      name: normalized,
      affiliation: normalizeAffiliation(inputAffiliation || inferAffiliationForPerson(rawText, normalized)),
      ...(inputSentiment && { sentiment: inputSentiment }),
      ...(inputBemerkung && { bemerkung: inputBemerkung })
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

  // Match "Surname Firstname, age[, DD.MM.YYYY]" or "Surname Firstname, geb. DD.MM.YYYY[, m/f/w]"
  const surnameFirstWithMeta = text.matchAll(/\b([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ’’-]{1,})\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ’’-]{1,})\s*,\s*(?:geb\.?\s*)?\d{2,}(?:[.\-/]\d{2,})*(?:\s*,\s*[mfw]\b)?/giu);
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

  // Formal: "Sehr geehrte(r) Herr/Frau [Title] Name"
  const formalRegex = /^Sehr\s+geehrte[rsn]?\s+(?:Frau|Herr)\s+((?:(?:Prof|Dr|med|lic|RA)\.?\s*)*\p{Lu}[\p{Ll}\p{M}'-]{2,}(?:\s+\p{Lu}[\p{Ll}\p{M}'-]{2,})*)/iu;
  // Informal: "Hallo/Liebe(r)/Grüezi/Hi/Hey Name[,]"
  const informalRegex = /^(?:Hallo|Liebe[rsn]?|Gr(?:ü|ue)(?:zi|ezi|ss|ße)|Hi|Hey|Guten\s+Tag)\s+(\p{Lu}[\p{Ll}\p{M}'-]{2,}(?:\s+\p{Lu}[\p{Ll}\p{M}'-]{2,})*)\s*[,!]?\s*$/iu;

  for (const line of lines) {
    const formalMatch = line.match(formalRegex);
    if (formalMatch && formalMatch[1]) {
      candidates.push({ name: normalizeWhitespace(formalMatch[1]), allowSingleToken: true });
      continue;
    }
    const informalMatch = line.match(informalRegex);
    if (informalMatch && informalMatch[1]) {
      candidates.push({ name: normalizeWhitespace(informalMatch[1]), allowSingleToken: true });
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

function buildEmptyEvidenceBundle() {
  return {
    protectedPerson: { positive: [], negative: [] },
    opposingParty: { positive: [], negative: [] }
  };
}

function truncateReportSnippet(value, maxLength = 220) {
  const normalized = normalizeWhitespace(String(value || "").replace(/^[\-•–]\s*/, ""));
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function pushUniqueReportSnippet(list, snippet, maxItems = 3) {
  if (!Array.isArray(list) || list.length >= maxItems) {
    return;
  }

  const normalized = truncateReportSnippet(snippet);
  if (!normalized) {
    return;
  }

  const key = normalizeForSearch(normalized);
  if (list.some((entry) => normalizeForSearch(entry) === key)) {
    return;
  }

  list.push(normalized);
}

function appendSnippetByPolarity(target, snippet, polarity, maxItems = 3) {
  if (!target || typeof target !== "object") {
    return;
  }

  if (polarity === "positive") {
    pushUniqueReportSnippet(target.positive, snippet, maxItems);
  } else if (polarity === "negative") {
    pushUniqueReportSnippet(target.negative, snippet, maxItems);
  }
}

function collectImpactEvidenceForParty(target, impactRanking = [], aliases = [], maxItems = 3) {
  const entries = Array.isArray(impactRanking) ? impactRanking : [];
  for (const entry of entries) {
    const name = normalizeWhitespace(entry?.name || "");
    if (!name || !hasAnyPartyNeedle(name, aliases)) {
      continue;
    }

    const items = Array.isArray(entry?.items) ? entry.items : [];
    for (const item of items) {
      const counts = countPolaritySignals(item);
      if (counts.positive > 0) {
        pushUniqueReportSnippet(target.positive, item, maxItems);
      }
      if (counts.negative > 0) {
        pushUniqueReportSnippet(target.negative, item, maxItems);
      }
      if (counts.positive === 0 && counts.negative === 0) {
        appendSnippetByPolarity(target, item, classifyMentionPolarity(item), maxItems);
      }
    }
  }
}

function buildPartyEvidence(rawText, protectedAliases = [], opposingAliases = [], impactRanking = [], maxItems = 3) {
  const evidence = buildEmptyEvidenceBundle();
  collectImpactEvidenceForParty(evidence.protectedPerson, impactRanking, protectedAliases, maxItems);
  collectImpactEvidenceForParty(evidence.opposingParty, impactRanking, opposingAliases, maxItems);

  const clauses = splitIntoClaimClauses(rawText);
  for (const clause of clauses) {
    const mentionsProtected = hasAnyPartyNeedle(clause, protectedAliases);
    const mentionsOpposing = hasAnyPartyNeedle(clause, opposingAliases);
    if (!mentionsProtected && !mentionsOpposing) {
      continue;
    }

    if (mentionsProtected && mentionsOpposing) {
      continue;
    }

    const target = mentionsProtected ? evidence.protectedPerson : evidence.opposingParty;
    const counts = countDistinctClaimSignals(clause);
    if (counts.positive > 0) {
      pushUniqueReportSnippet(target.positive, clause, maxItems);
    }
    if (counts.negative > 0) {
      pushUniqueReportSnippet(target.negative, clause, maxItems);
    }
    if (counts.positive === 0 && counts.negative === 0) {
      appendSnippetByPolarity(target, clause, classifyMentionPolarity(clause), maxItems);
    }
  }

  return evidence;
}

function deriveQualityLabel(score) {
  if (!Number.isFinite(score)) {
    return "Nicht verfügbar";
  }
  if (score >= 0.94) {
    return "Hoch";
  }
  if (score >= 0.86) {
    return "Gut";
  }
  if (score >= 0.74) {
    return "Mittel";
  }
  return "Niedrig";
}

function deriveConfidenceLabel(score, ocrUsed = false) {
  if (!Number.isFinite(score)) {
    return "Manuell prüfen";
  }
  if (score >= 0.9 && !ocrUsed) {
    return "Hoch";
  }
  if (score >= 0.8) {
    return "Gut";
  }
  if (score >= 0.68) {
    return "Mittel";
  }
  return "Niedrig";
}

function buildTextQualityMeta(rawText, { sourceType = "Text", extractionMethod = "Unbekannt", ocrUsed = false } = {}) {
  const normalized = normalizeWhitespace(rawText);
  if (!normalized) {
    return {
      score: null,
      label: "Nicht verfügbar",
      confidence: "Manuell prüfen",
      extractionMethod: normalizeWhitespace(extractionMethod) || "Unbekannt",
      sourceType: normalizeWhitespace(sourceType) || "Text",
      ocrUsed: Boolean(ocrUsed)
    };
  }

  const score = Number(scoreExtractedTextQuality(normalized).toFixed(2));
  return {
    score,
    label: deriveQualityLabel(score),
    confidence: deriveConfidenceLabel(score, ocrUsed),
    extractionMethod: normalizeWhitespace(extractionMethod) || "Unbekannt",
    sourceType: normalizeWhitespace(sourceType) || "Text",
    ocrUsed: Boolean(ocrUsed)
  };
}

function normalizeTextQualityMeta(value) {
  if (!value || typeof value !== "object") {
    return buildTextQualityMeta("", {});
  }

  const score = Number.isFinite(Number(value.score)) ? Number(Number(value.score).toFixed(2)) : null;
  const ocrUsed = Boolean(value.ocrUsed);
  return {
    score,
    label: normalizeWhitespace(value.label) || deriveQualityLabel(score),
    confidence: normalizeWhitespace(value.confidence) || deriveConfidenceLabel(score, ocrUsed),
    extractionMethod: normalizeWhitespace(value.extractionMethod) || "Unbekannt",
    sourceType: normalizeWhitespace(value.sourceType) || "Text",
    ocrUsed
  };
}

function normalizeEvidenceBundle(value) {
  const safe = buildEmptyEvidenceBundle();
  const src = value && typeof value === "object" ? value : {};
  for (const section of ["protectedPerson", "opposingParty"]) {
    const sectionSource = src[section] && typeof src[section] === "object" ? src[section] : {};
    for (const tone of ["positive", "negative"]) {
      const target = safe[section][tone];
      const sourceList = Array.isArray(sectionSource[tone]) ? sectionSource[tone] : [];
      for (const item of sourceList) {
        pushUniqueReportSnippet(target, item, 3);
      }
    }
  }
  return safe;
}

function enrichAnalysisForReport(analysis, { rawText = "", protectedAliases = [], opposingAliases = [], textQuality = null, methodology = "" } = {}) {
  const safe = analysis && typeof analysis === "object" ? analysis : {};
  const reportMethodology = normalizeWhitespace(methodology)
    || "Quantitative Parteiauswertung mit Positiv-/Negativzählung und Belegstellenprüfung.";

  return {
    ...safe,
    textQuality: normalizeTextQualityMeta(safe.textQuality || textQuality),
    evidence: normalizeEvidenceBundle(
      safe.evidence || buildPartyEvidence(rawText, protectedAliases, opposingAliases, safe.impactRanking, 3)
    ),
    methodology: normalizeWhitespace(safe.methodology || reportMethodology)
  };
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

function buildFallbackAnalysis({ title = "", author = "", authoredDate = "", documentType = "", people = [], disadvantagedPerson = "", senderInstitution = "", impactAssessment = "", impactRanking = [], positiveMentions = 0, negativeMentions = 0, opposingPositiveMentions = 0, opposingNegativeMentions = 0, rawText = "", message = "", textQuality = null, evidence = null, methodology = "", manipulationsmuster = [] }) {
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
    manipulationsmuster: Array.isArray(manipulationsmuster) ? manipulationsmuster.filter(m => m && m.typ) : [],
    message: normalizeWhitespace(message),
    textQuality: normalizeTextQualityMeta(textQuality),
    evidence: normalizeEvidenceBundle(evidence),
    methodology: normalizeWhitespace(methodology),
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
        if (!name || !isHumanNameCases(name)) {
          return null;
        }
        const rolle = normalizeWhitespace(entry?.rolle || "");
        const sentiment = normalizeWhitespace(entry?.sentiment || "");
        const bemerkung = normalizeWhitespace(entry?.bemerkung || "");
        return {
          name,
          affiliation: rolle || "Privatperson",
          ...(sentiment && { sentiment }),
          ...(bemerkung && { bemerkung })
        };
      })
      .filter(Boolean)
    : (Array.isArray(src.people) ? src.people : []);

  // When AI returned persons, do NOT re-run heuristics (they add garbage).
  const effectiveRawText = mappedPeople.length > 0 ? "" : rawText;

  // Extract positive/negative from benachteiligte_person object (Vision prompt format)
  const bp = src.benachteiligte_person || {};
  const posFromBp = Number(bp.positiv || bp.positive || 0);
  const negFromBp = Number(bp.negativ || bp.negative || 0);

  // Normalize date to DD.MM.YYYY
  const rawDate = src.datum || src.datum_verfassung || src.authoredDate || fallback.authoredDate || "";
  const normalizedDate = normalizeDateFieldCases(rawDate);

  return buildFallbackAnalysis({
    title: src.titel || src.dokument_titel || src.title || fallback.title,
    author: src.verfasser || src.author || fallback.author,
    documentType: src.documentType || src.dokument_typ || fallback.documentType || "",
    authoredDate: normalizedDate !== "-" ? normalizedDate : fallback.authoredDate,
    people: mappedPeople.length > 0 ? mappedPeople : fallback.people,
    disadvantagedPerson: src.disadvantagedPerson || fallback.disadvantagedPerson,
    senderInstitution: src.absender || src.herkunft || src.senderInstitution || fallback.senderInstitution,
    impactAssessment: src.zusammenfassung || src.bewertung_kurz || src.impactAssessment || fallback.impactAssessment,
    impactRanking: Array.isArray(src.impactRanking) && src.impactRanking.length > 0 ? src.impactRanking : fallback.impactRanking,
    positiveMentions: src.positiveMentions ?? (posFromBp || fallback.positiveMentions) ?? 0,
    negativeMentions: src.negativeMentions ?? (negFromBp || fallback.negativeMentions) ?? 0,
    opposingPositiveMentions: src.opposingPositiveMentions ?? fallback.opposingPositiveMentions ?? 0,
    opposingNegativeMentions: src.opposingNegativeMentions ?? fallback.opposingNegativeMentions ?? 0,
    rawText: effectiveRawText,
    manipulationsmuster: Array.isArray(src.manipulationsmuster) ? src.manipulationsmuster : [],
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

  // People list (support both string[] and {name, rolle}[] formats)
  const peopleSource = Array.isArray(src.personen) ? src.personen : [];
  const mappedPeople = peopleSource
    .map((entry) => {
      const name = normalizeWhitespace(typeof entry === "string" ? entry : entry?.name || "");
      if (!name) return null;
      const rolle = typeof entry === "object" && entry ? normalizeWhitespace(entry.rolle || "") : "";
      const bemerkung = typeof entry === "object" && entry ? normalizeWhitespace(entry.bemerkung || "") : "";
      return {
        name,
        affiliation: normalizeAffiliation(rolle) || "Privatperson",
        ...(bemerkung && { bemerkung })
      };
    })
    .filter(Boolean);

  const impactRanking = [];
  if (finalNegA > 0 || finalPosA > 0) {
    impactRanking.push({
      name: fallback.disadvantagedPerson || "Fokus-Partei",
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
    documentType: normalizeWhitespace(src.documentType || src.dokument_typ || "") || fallback.documentType || "",
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
    "Du bist ein neutraler forensischer Profiler.",
    "Deine Aufgabe ist die mathematisch praezise Erfassung von positiven und negativen Zuschreibungen fuer BEIDE Parteien im Dokument.",
    "",
    "### 1. ROLLEN-IDENTIFIKATION:",
    "- Identifiziere die Fokus-Partei und die Gegenpartei aus dem Kontext und den Alias-Listen.",
    `- FOKUS_PARTEI_KEYWORDS = [${focusKeywords}]`,
    `- GEGENPARTEI_KEYWORDS = [${referenceKeywords}]`,
    "- Extrahiere alle Namen (inkl. Kinder) und den Absender (Behoerde/Amt).",
    "- WICHTIG: Fuehre auch den VERFASSER/AUTOR des Dokuments in der personen-Liste auf (z.B. Berufsbeistand, Gerichtspräsident, Anwalt, Gutachter, Psychologe, Leiter Jugendforensik), mit seiner Funktion als 'rolle'.",
    "- WICHTIG: Die Person UEBER DIE das Dokument handelt (Patient, Kind, Betroffener) MUSS in der personen-Liste stehen!",
    "- STRIKTE NAMENREGEL: Im 'name'-Feld NUR den echten Personennamen (Vorname Nachname).",
    "  KEINE Funktion, KEINEN Titel, KEINE Institution, KEIN Geburtsdatum im Namen.",
    "  Falsch: {name: 'Jugendforensik Max Muster Leiter'} | Richtig: {name: 'Max Muster', rolle: 'Leiter Jugendforensik'}",
    "  Falsch: {name: 'Muster Hans, geb. 01.01.2010, m'} | Richtig: {name: 'Muster Hans', rolle: 'Kind'}",
    "- NUR echte Menschennamen! KEINE Institutionen (UKBB, KESB, Gericht, Universitaets-Kinderspital, Polizei, Kantonsgericht), KEINE Themen, KEINE Dokumenttitel, KEINE Fachbegriffe (Medizinisches Rezept, Ergotherapie, Sozialkompetenztraining).",
    "- ALIAS-ERKENNUNG: Schweizer Kurzformen zusammenfuehren: Ruedi=Rudolf, Roli=Roland, Susi=Susanne, Urs=Ursus, Res=Andreas, Sepp=Josef, Toni=Anton, Köbi=Jakob, Vreni=Verena, Röbi=Robert, Kari=Karl, Fredi=Alfred, Ueli=Ulrich, Werni=Werner, Heiri=Heinrich.",
    "  Wenn nur ein Vorname erscheint (z.B. 'Timur'), trotzdem als Person auffuehren.",
    "  Gleiche Person mit verschiedenen Namensvarianten nur EINMAL auffuehren (laengste/vollstaendigste Form waehlen).",
    "- BEMERKUNG (Pflichtfeld): Fasse in 1 Satz zusammen, was diese Person im Dokument KONKRET tut oder was ueber sie gesagt wird.",
    "  Fokus auf Handlungen GEGEN oder FUER die Fokus-Partei. Beispiele:",
    "  'Verfasst negativen Bericht', 'Ordnet Kontaktsperre an', 'Wird als kooperativ beschrieben'.",
    "- Bestimme die Rolle aus dem Kontext: Vater, Mutter, Kind, Arzt, Therapeut, Anwalt, Beistand, Richter, etc.",
    `- Wenn eine Person zur FOKUS-PARTEI [${focusKeywords}] gehoert: Rolle aus dem Kontext (z.B. Vater, Mutter).`,
    `- Wenn eine Person zur GEGENPARTEI [${referenceKeywords}] gehoert: Rolle aus dem Kontext (z.B. Mutter, Vater).`,
    "",
    "### 1b. MITTEILUNG AN / VERTEILER – ROLLENBESTIMMUNG AUS KONTEXT:",
    "Wenn im Dokument 'Mitteilung an:', 'Verteiler:', 'An:', 'Zustellung:' vorkommt:",
    "- 'Vorname Nachname, Advokat ... (fuer sich und die Kinder)' → rolle: 'Kinderanwalt'",
    "- 'Vorname Nachname, Advokatur ... (fuer sich und [Person])' → rolle: 'Anwalt von [Person]'",
    "- 'Vorname Nachname, Beistaendin' → rolle: 'Beiständin'",
    "- Person mit 'klin. Heilpaedagogin, Behoerdenmitglied' → rolle: 'Behördenmitglied'",
    "WICHTIG: Diese Rollenzuordnung hat hoechste Prioritaet.",
    "",
    "### 2. SYMMETRISCHES ZAEHLVERFAHREN (KEYWORD-TRAINING):",
    "- Untersuche jede Zeile bzw. jede klare Sinn-Einheit.",
    "- Erhoehe die Zaehler nur bei expliziten positiven oder negativen Zuschreibungen.",
    "- Alle Aliase einer Liste gehoeren zu genau einer Partei und duerfen nicht als separate Personen behandelt werden.",
    "",
    "A) FUER DIE FOKUS-PARTEI:",
    "- ROT (+1 Negativ): Kritik, Vorwuerfe, Unterstellung von Defiziten, fehlende Kooperation, Unpuenktlichkeit, Durchsetzen eigener Interessen.",
    "- GRUEN (+1 Positiv): Lob, Bestaetigung von Kompetenz, Wohlwollen, Bemuehen, Kooperation, liebevoller Umgang.",
    "",
    "WICHTIG: Zaehle NUR fuer die Fokus-Partei. KEINE Zaehlung fuer die Gegenpartei (spart Tokens, irrelevant).",
    "",
    "### 2b. E-MAIL-ERKENNUNG:",
    "Wenn das Dokument E-Mail-Header enthaelt (z.B. 'Von:', 'From:', 'Gesendet:', 'Sent:', 'An:', 'To:', 'Betreff:', 'Subject:', 'CC:', 'BCC:'):",
    "- documentType MUSS 'E-Mail' sein (NICHT 'Chat', NICHT 'Brief').",
    "- verfasser = Absender aus dem 'Von:'/'From:' Feld (nur Name, keine E-Mail-Adresse).",
    "- datum = Datum aus 'Gesendet:'/'Sent:'/'Date:' Feld. Format: TT.MM.JJJJ oder wie angegeben.",
    "- absender = Organisation/Institution des Absenders (z.B. 'Polizei Basel-Landschaft', 'KESB Leimental').",
    "- Empfaenger aus 'An:'/'To:' als Person mit rolle 'Empfaenger' auffuehren.",
    "- E-Mails sind KEINE Chats. Chats haben Sprechblasen und Messenger-UI-Elemente.",
    "",
    "### 2c. DOKUMENTTYP-KLASSIFIKATION:",
    "Bestimme den documentType anhand des Inhalts:",
    "- 'Verfuegung' = amtliche Anordnung einer Behoerde",
    "- 'Superprovisorische Massnahme' = dringliche Massnahme ohne Anhoerung",
    "- 'Brief' = formelles Schreiben (Briefkopf, Anrede, Grussformel)",
    "- 'E-Mail' = elektronische Korrespondenz (Von/An/Betreff Header)",
    "- 'Gutachten' = fachliche Beurteilung durch Experte",
    "- 'Bericht' = Stellungnahme oder Bericht einer Fachstelle",
    "- 'Protokoll' = Sitzungsprotokoll oder Aktennotiz",
    "- 'Eingabe' = anwaltliche Eingabe ans Gericht",
    "- 'Urteil' = Gerichtsentscheid",
    "- 'Chat' = NUR bei Messenger-Dialogen (WhatsApp, SMS, Signal etc.)",
    "",
    "### 2d. MUSTER SYSTEMATISCHER ZERSTOERUNG (HOHE GEWICHTUNG):",
    "Die Gegenpartei kann die Fokus-Partei durch wiederholte institutionelle Attacken zerstoeren.",
    "Diese Muster sind STARK NEGATIV fuer die Gegenpartei und STARK NEGATIV fuer die Fokus-Partei (als Opfer):",
    "",
    "POLIZEI-MUSTER (Negativ fuer Fokus-Partei):",
    "- Wiederholte Polizeianzeigen, Polizeibesuche, Polizeieinsaetze gegen die Fokus-Partei",
    "- Anrufe bei der Polizei wegen angeblicher Bedrohung, Gewalt, Belästigung",
    "- Bedrohungsmanagement-Meldungen, Gefaehrdungsmeldungen an KESB",
    "- AUCH wenn die Polizei keine Fallerroeffnung, keine strafbaren Handlungen feststellt",
    "- Die BLOSSE EXISTENZ solcher Korrespondenz/Akten schadet der Person bei Gericht und Behoerden",
    "- Ergebnis 'keine Fallerroeffnung / keine strafbaren Handlungen' = ENTLASTUNG der Fokus-Partei (+2 Positiv)",
    "",
    "INSTITUTIONELLE ATTACKEN (Negativ fuer Fokus-Partei):",
    "- Meldungen an KESB, Jugendamt, Schule mit unbelegten Vorwuerfen",
    "- Superprovisorische Massnahmen ohne ausreichende Beweislage",
    "- Anwaeltliche Eingaben mit sachfremden Persoenlichkeitsangriffen",
    "- Wiederholte Antraege auf Kontaktbeschraenkungen oder Entzug von Sorgerechten",
    "",
    "WARUM HOHE GEWICHTUNG:",
    "- Jeder Polizeieinsatz hinterlaesst Spuren in Datenbanken (Bedrohungsmanagement, RIPOL, HOOGAN etc.)",
    "- Behoearden und Gerichte sehen diese Eintraege und bilden sich ein (falsches) Bild",
    "- Selbst wenn NICHTS bestaetigt wird, schadet die Haeufung enorm",
    "- Dies ist ein bekanntes Muster der systematischen Zerstoerung einer Person im Familienrecht",
    "- Die KI muss dieses Muster erkennen und in der Gesamtanalyse gewichten",
    "",
    "### 3. FORENSISCHE REGELN:",
    "- PERSONEN-REGEL: Liste in 'personen' NUR Namen auf, die EXPLIZIT im Dokumenttext vorkommen. Fuege NIEMALS die Keywords aus FOKUS_PARTEI_KEYWORDS oder GEGENPARTEI_KEYWORDS als Personen hinzu, es sei denn diese Namen tauchen tatsaechlich im Dokumenttext auf.",
    "- Sei extrem kritisch: Wenn der Autor eine Partei nur lobt und die andere nur kritisiert, zaehle jeden einzelnen klaren Bewertungsunterschied.",
    "- Ignoriere neutrale Fakten, Adressen, reine Chronologie und Verfahrensgeschichte ohne Wertung.",
    "- Empfehlungen oder Rechtfertigungen zugunsten einer Partei zaehlen als positiv fuer diese Partei.",
    "- Zaehle Kinder als Personen im Dokument auf (Name, Vorname, Geburtsdatum wie im Text angegeben), aber nicht als Fokus- oder Gegenpartei, ausser der Text bewertet sie ausdruecklich als Partei.",
    "- WICHTIG: Kinder MUESSEN die rolle 'Kind' erhalten. Auch wenn ein Kind den Nachnamen der Gegenpartei traegt, ist es KEIN Gegner.",
    "- SENTIMENT PRO PERSON (Pflichtfeld): Bestimme fuer JEDE Person in 'personen' ein 'sentiment'-Feld:",
    "  'positiv' = Person unterstuetzt oder schreibt wohlwollend ueber die Fokus-Partei",
    "  'negativ' = Person schreibt kritisch, belastend oder feindlich gegen die Fokus-Partei",
    "  'neutral' = Person ist weder fuer noch gegen die Fokus-Partei (z.B. Richter, neutrale Fachperson)",
    "  Kinder der Fokus-Partei oder gemeinsame Kinder erhalten immer 'neutral' (sie sind keine Partei).",
    "  Der Verfasser/Autor: Bewerte anhand des Tons gegenueber der Fokus-Partei im Dokument.",
    "- POLIZEI/BEHOERDEN-KORRESPONDENZ: Wenn ein Dokument eine Polizeiantwort, Bedrohungsmanagement-Mitteilung oder KESB-Meldung ist, werte dies IMMER als Belastungsmuster – auch wenn 'keine strafbaren Handlungen' oder 'kein Einsatz' steht. Die Existenz solcher Dokumente im Dossier ist selbst der Beweis fuer systematische Attacken.",
    "  → Mindestens benachteiligte_person.negativ: 1 (Existenz schadet der Fokus-Partei in Datenbanken)",
    "  → Wenn Entlastung ('keine Straftat' etc.): zusaetzlich benachteiligte_person.positiv: 1",
    "",
    "### 3b. MANIPULATIONS- UND NARZISSMUS-ERKENNUNG (DMSKI-Checkliste):",
    "Scanne den Text auf folgende 10 Indikatoren. Fuer JEDEN erkannten Indikator: gib den Typ und ein konkretes Zitat/Beleg aus dem Text an.",
    "NUR melden wenn TATSAECHLICH im Text erkennbar – keine Vermutungen!",
    "",
    "1. GASLIGHTING: Verdrehen von Fakten, um die Gegenseite als 'verwirrt' oder 'psychisch labil' darzustellen.",
    "2. PROJEKTION: Beschuldigungen, die eigentlich auf den Absender zutreffen (Taeter-Opfer-Umkehr / DARVO).",
    "3. ISOLATIONSTAKTIK: Versuche, die Fokus-Partei von Familie (Bruder, Eltern) oder Helfern zu trennen.",
    "4. MACHTMISSBRAUCH_GELD: Verstecken von Vermoegen oder manipulative Unterhaltsforderungen.",
    "5. TRIANGULATION: Einbeziehung Dritter (fliegende Affen), um Druck aufzubauen.",
    "6. AD_HOMINEM: Charakterangriffe und Abwertungen statt sachlicher Argumente.",
    "7. EMPATHIELOSIGKEIT: Kuehle, objektifizierende Sprache ueber Kinder oder nahe Angehoerige.",
    "8. SABOTAGE: Gezieltes Blockieren von gerichtlichen oder medizinischen Massnahmen.",
    "9. ABSOLUTE_SPRACHE: Exzessive Nutzung von 'immer', 'nie', 'voellig', um Grauzonen zu eliminieren.",
    "10. WORTSALAT: Komplizierte, kreisende Formulierungen, die vom eigentlichen Kern ablenken.",
    "",
    "### 3c. VERFASSER-BIAS-ELIMINIERUNG (KRITISCH):",
    "- Fokus-Partei ist Verfasser: Selbstlob NICHT als positiv zaehlen. Eigene Briefe verzerren sonst das Ergebnis.",
    "- Gegenpartei ist Verfasser: Was sie NEGATIV ueber Fokus-Partei schreibt, zaehlt als Negativ fuer Fokus-Partei.",
    "- Neutrale Dritte (Behoerden, Gerichte, Gutachter) zaehlen normal.",
    "",
    "### 4. OUTPUT-STRUKTUR:",
    "- TITEL, VERFASSER, DATUM, ABSENDER, PERSONEN, DOKUMENTTYP extrahieren.",
    "- ZUSAMMENFASSUNG: Beschreibe die psychologische Schieflage oder Ausgewogenheit in maximal 2 Saetzen.",
    "- DARSTELLUNG: Am Ende nur die nackten Summen fuer die Fokus-Person.",
    "- Wenn ein Wert 0 ist, bleibt er 0.",
    "- Gib fuer die API trotzdem NUR valides JSON gemaess Schema zurueck.",
    "",
    "### JSON-SCHEMA (exakt einhalten):",
    "{",
    '  "titel": "",',
    '  "verfasser": "",',
    '  "datum": "TT.MM.JJJJ oder wie im Dokument angegeben",',
    '  "absender": "",',
    '  "documentType": "Verfuegung|Brief|E-Mail|Gutachten|Bericht|Protokoll|Eingabe|Urteil|Superprovisorische Massnahme|Chat",',
    '  "personen": [{"name": "Vorname Nachname", "rolle": "Funktion z.B. Berufsbeistand/Anwältin/Gerichtspräsident/Kind", "sentiment": "positiv|negativ|neutral", "bemerkung": "Was tut diese Person im Dokument? 1 Satz."}],',
    '  "benachteiligte_person": {',
    '    "positiv": 0,',
    '    "negativ": 0',
    '  },',
    '  "zusammenfassung": "Max 2 Saetze",',
    '  "manipulationsmuster": [{"typ": "GASLIGHTING|PROJEKTION|ISOLATIONSTAKTIK|MACHTMISSBRAUCH_GELD|TRIANGULATION|AD_HOMINEM|EMPATHIELOSIGKEIT|SABOTAGE|ABSOLUTE_SPRACHE|WORTSALAT", "beleg": "Zitat oder Paraphrase aus dem Text"}]',
    "}",
    "",
    "WICHTIG: 'manipulationsmuster' ist ein Array. Nur erkannte Muster auffuehren. Leeres Array [] wenn keine erkannt.",
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
  if (!getAnthropicClient()) {
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

  const userContent = [
    aiCandidateNames.length > 0
      ? `Potenzielle Namen aus Voranalyse: ${aiCandidateNames.join(", ")}`
      : "Potenzielle Namen aus Voranalyse: (keine)",
    "",
    "TEXT ZUM ANALYSIEREN:",
    textSnippet
  ].join("\n");

  try {
    const responseText = await callClaudeText(
      buildQuantitativeForensicPrompt(protectedPersonName, opposingPartyName),
      userContent,
      2000
    );

    let parsed = extractJsonObject(responseText || "");
    let mapped = null;

    if (parsed && typeof parsed === "object") {
      if (parsed?.benachteiligte_person || parsed?.gegenpartei || "benachteiligte_person_positiv" in parsed || parsed?.target_a || parsed?.target_b || parsed?.personen_auswertung || parsed?.auswertung || parsed?.statistik || parsed?.metadaten || parsed?.analyse_score) {
        mapped = mapBiasForensicJsonToAnalysis(parsed, fallback, textSnippet);
      } else {
        mapped = mapSwissForensicJsonToAnalysis(parsed, fallback, textSnippet);
      }
    }

    if (mapped && hasUsableForensicResult(mapped)) {
      return mapped;
    }

    // Retry with correction hint
    const retryText = await callClaudeText(
      [
        buildQuantitativeForensicPrompt(protectedPersonName, opposingPartyName),
        "",
        "KORREKTURHINWEIS: Erzeuge NUR valides JSON gemass Schema. Keine Erklaerung."
      ].join("\n"),
      userContent,
      2000
    );

    const retryParsed = extractJsonObject(retryText || "");
    if (retryParsed && typeof retryParsed === "object") {
      const retryMapped = mapBiasForensicJsonToAnalysis(retryParsed, fallback, textSnippet);
      if (hasUsableForensicResult(retryMapped)) {
        return retryMapped;
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
  if (!getAnthropicClient()) {
    return {
      status: "needs-ocr",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      disadvantagedPerson: "",
      message: "ANTHROPIC_API_KEY nicht gesetzt."
    };
  }

  const base64 = fileBuffer.toString("base64");
  const isChatHint = /whats?app|chat|nachricht|dialog|sms|signal|telegram/i.test(String(originalName || "").toLowerCase());

  const focusAliases = parsePartyAliases(protectedPersonName);
  const referenceAliases = parsePartyAliases(opposingPartyName);
  const focusKeywords = focusAliases.aliases.length > 0 ? focusAliases.aliases.join(", ") : "(keine)";
  const referenceKeywords = referenceAliases.aliases.length > 0 ? referenceAliases.aliases.join(", ") : "(keine)";

  const systemPrompt = isChatHint
    ? [
      "Du bist ein forensischer Analyst fuer Kommunikationspruefung.",
      "Analysiere den Chat-Dialog und quantifiziere die Dynamik.",
      "OUTPUT: Strenges JSON:",
      "{",
      '  "beteiligte": {',
      '    "links": { "name": "Name", "rolle": "Partei A" },',
      '    "rechts": { "name": "Name", "rolle": "Partei B" }',
      "  },",
      '  "forensik_score": {',
      '    "links": { "positiv_count": 0, "negativ_count": 0, "belege_negativ": [] },',
      '    "rechts": { "positiv_count": 0, "negativ_count": 0, "belege_negativ": [] }',
      "  },",
      '  "analyse_fazit": "Zusammenfassung",',
      '  "benachteiligung_score": "1-10"',
      "}",
      "NUR JSON."
    ].join("\n")
    : [
      "Du bist ein forensischer Dokumenten-Analyst fuer Familienrecht.",
      "Deine Aufgabe: Lies das Bild VOLLSTAENDIG, auch wenn es schraeg fotografiert ist.",
      "Lies JEDEN sichtbaren Text Zeile fuer Zeile. Erfinde NICHTS.",
      "",
      "### SCHRITT 1 – DOKUMENT SEGMENTIEREN:",
      "Teile das Dokument in diese Zonen ein:",
      "A) BRIEFKOPF/LOGO: Institution, Adresse → absender",
      "B) EMPFAENGERBLOCK: 'An:', Anschrift, Titel → Empfaenger als Person",
      "C) BETREFFZEILE: Ueberschrift, Titel des Dokuments → titel",
      "D) ANREDE: 'Sehr geehrter Herr Dr. med. X' → Person + Rolle",
      "E) TEXTKÖRPER: Namentlich genannte Personen mit Kontext → Personen",
      "F) UNTERZEICHNER: Unterschrift, Ersteller → verfasser",
      "",
      "### DATUMSFORMAT (PFLICHT):",
      "- Alle Datumsangaben MUESSEN im Format TT.MM.JJJJ zurueckgegeben werden.",
      "- 2-stellige Jahreszahl konvertieren: 24.06.23 → 24.06.2023",
      "- Kein Datum erkennbar → '-'",
      "",
      "### SCHRITT 2 – PERSONEN-EXTRAKTION (STRIKTE REGELN):",
      "",
      "Das Array 'personen' ist AUSSCHLIESSLICH fuer echte menschliche Individuen reserviert.",
      "Nutze dein semantisches Verstaendnis:",
      "",
      "WAS IST EIN EIGENNAME? → Vorname und/oder Nachname eines Menschen.",
      "  Richtig: 'Alexandra Schifferli', 'Ayhan Ergen', 'Dr. med. Brotzmann', 'Timur'",
      "  Falsch:  'Triangulation', 'Coercive Control', 'UKBB Ergotherapie', 'Das Dokument'",
      "  Falsch:  'Universitaets-Kinderspital beider Basel (UKBB)', 'Medizinisches Rezept'",
      "",
      "WO FINDEST DU NAMEN?",
      "  - Anrede: 'Hallo Ayhan,' → Ayhan ist eine Person",
      "  - Adressblock: 'An: ergen@bluewin.ch, Alexandra Schifferli'",
      "  - Betreffzeile mit Name: 'Schifferli Timur, geb. 27.03.2013'",
      "  - Unterschrift: 'Alexandra' am Ende = Verfasser",
      "  - Im Text namentlich erwaehnt: 'Timur nahm an allen Sitzungen teil'",
      "",
      "WAS GEHOERT NICHT IN PERSONEN? → ALLES was kein Mensch ist:",
      "  - Organisationen/Institutionen: UKBB, KESB, Gericht, Spital, Kinderspital,",
      "    Universitaets-Kinderspital, Kantonsgericht, Polizei, Sozialamt → gehoeren in 'absender'",
      "  - Dokumenttypen: Medizinisches Rezept, Gutachten, Verfuegung, Bericht → NICHT in personen",
      "  - Fachbegriffe: Ergotherapie, Sozialkompetenztraining, Diagnose → NICHT in personen",
      "  - Psychologische Begriffe: Triangulation, Gaslighting, DARVO → gehoeren in 'manipulationsmuster'",
      "  - Generische Rollen ohne Namen (die Mutter, der Vater) → NUR wenn der Name bekannt ist",
      "",
      "WENN KEINE echten Personennamen gefunden werden → personen-Array LEER lassen: []",
      "",
      "ALIAS-ERKENNUNG: Schweizer Kurzformen zusammenfuehren:",
      "  Ruedi=Rudolf, Roli=Roland, Susi=Susanne, Res=Andreas, Sepp=Josef, Toni=Anton,",
      "  Köbi=Jakob, Vreni=Verena, Röbi=Robert, Kari=Karl, Fredi=Alfred, Ueli=Ulrich.",
      "  Gleiche Person mit verschiedenen Namensvarianten nur EINMAL auffuehren (vollstaendigste Form).",
      "",
      "NAMENSFORMAT: {name: 'Vorname Nachname', rolle: 'Funktion aus dem Kontext', bemerkung: 'Was tut die Person?'}",
      "  - Kein Geburtsdatum im Namen, kein Geschlecht, keine Institution",
      "  - rolle = was die Person IST: Vater, Mutter, Kind, Arzt, Anwalt, Empfaenger, etc.",
      "  - bemerkung = 1 Satz: was die Person im Dokument tut/was ueber sie gesagt wird (Fokus auf Handlungen gegen/fuer Fokus-Partei)",
      `  - Wenn Person zur FOKUS-PARTEI [${focusKeywords}] gehoert: Rolle aus Kontext (z.B. Vater)`,
      `  - Wenn Person zur GEGENPARTEI [${referenceKeywords}] gehoert: Rolle aus Kontext (z.B. Mutter)`,
      "",
      "PFLICHT: Extrahiere ALLE namentlich genannten Personen im Dokument.",
      "Auch die Person UEBER DIE geschrieben wird (Patient/Kind/Betroffener).",
      "Auch Personen aus informellen Anreden ('Hallo Ayhan' → Ayhan).",
      "",
      "### SCHRITT 3 – SENTIMENT PRO PERSON:",
      "- 'positiv' = unterstuetzend gegenueber der Fokus-Partei",
      "- 'negativ' = kritisch/belastend gegen die Fokus-Partei",
      "- 'neutral' = Kinder, neutrale Fachpersonen, Empfaenger ohne Wertung",
      "",
      "### SCHRITT 4 – FORENSISCHE ZAEHLUNG:",
      `- FOKUS-PARTEI = [${focusKeywords}]`,
      `- GEGENPARTEI = [${referenceKeywords}]`,
      "- Zaehle positive Aussagen ueber die Fokus-Partei → benachteiligte_person.positiv",
      "- Zaehle negative Aussagen → benachteiligte_person.negativ",
      "",
      "### SCHRITT 5 – PSYCHOLOGISCHE MANIPULATION (FBI-Profiling + Narzissmus-Analyse):",
      "Analysiere das Dokument mit FBI Behavioral Analysis und klinischer Narzissmus-Diagnostik.",
      "Pruefe auf diese Manipulationsmuster:",
      "",
      "DARVO (Deny-Attack-Reverse Victim/Offender):",
      "- Verfasser leugnet eigenes Fehlverhalten, greift die andere Partei an,",
      "  stellt sich selbst als Opfer dar. Klassisches Taeter-Opfer-Umkehr-Muster.",
      "",
      "GASLIGHTING:",
      "- Verdrehung von Tatsachen, Leugnung dokumentierter Ereignisse,",
      "  Unterstellung von Wahrnehmungsstoerungen beim Gegenueber.",
      "",
      "TRIANGULATION:",
      "- Instrumentalisierung von Behoerden, Kindern oder Dritten als Waffe",
      "  gegen die andere Partei. Einschaltung von Institutionen als Druckmittel.",
      "",
      "PROJEKTION:",
      "- Eigenes Fehlverhalten wird dem anderen vorgeworfen.",
      "  'Du zahlst nicht' (obwohl man selbst blockiert). 'Du eskalierst' (waehrend man droht).",
      "",
      "SCHULDZUWEISUNG / Blame-Shifting:",
      "- Alles ist die Schuld der anderen Person. Null Selbstreflexion.",
      "  'Deswegen sind die Behoerden jetzt zustaendig' = Drohung + Schuldzuweisung.",
      "",
      "DROHUNG / Coercive Control:",
      "- Rechtliche Schritte, Behoerdeneinschaltung, finanzielle Drohungen als Machtmittel.",
      "",
      "Wenn Muster erkannt: Beschreibe sie konkret mit ZITAT aus dem Text.",
      "Benenne das Muster beim Namen und erklaere die psychologische Dynamik.",
      "",
      "### SCHRITT 6 – ZUSAMMENFASSUNG (Forensisches Fazit):",
      "3-5 Saetze mit klinischer Praezision:",
      "1. Was ist der Kerninhalt des Dokuments?",
      "2. Welche Manipulationsmuster wurden erkannt? Benenne sie EXPLIZIT.",
      "3. Wie wirkt sich das Dokument auf die Fokus-Partei aus?",
      "Wenn Manipulation erkannt: Beschreibe die psychologische Dynamik konkret.",
      "Beispiel: '[Verfasser] zeigt klassisches DARVO-Muster: Sie/Er wirft [Fokus-Partei] vor...",
      "waehrend sie/er selbst blockiert. Dies ist typisch fuer narzisstische Projektion.'",
      "",
      "### JSON-SCHEMA (exakt einhalten):",
      "{",
      '  "titel": "Dokumenttitel oder Betreff",',
      '  "verfasser": "Unterzeichner/Ersteller (NICHT der Empfaenger!)",',
      '  "datum": "TT.MM.JJJJ",',
      '  "absender": "Institution/Organisation aus dem Briefkopf",',
      '  "documentType": "Bericht|Brief|E-Mail|Verfuegung|Gutachten|Protokoll|Eingabe|Urteil|Chat",',
      '  "personen": [{"name": "Vorname Nachname", "rolle": "Funktion", "sentiment": "positiv|negativ|neutral", "bemerkung": "Was tut diese Person im Dokument? 1 Satz."}],',
      '  "benachteiligte_person": {"positiv": 0, "negativ": 0},',
      '  "manipulationsmuster": [{"muster": "DARVO|Gaslighting|Triangulation|Isolation|Schuldzuweisung|Drohung", "beleg": "Zitat oder Beschreibung aus dem Text"}],',
      '  "zusammenfassung": "2-3 Saetze Fazit mit forensischer Einordnung inkl. Manipulationsmuster"',
      "}",
      "",
      "WICHTIG: verfasser = wer das Dokument GESCHRIEBEN/UNTERSCHRIEBEN hat.",
      "Der Empfaenger (z.B. 'Sehr geehrter Herr X') ist NICHT der Verfasser!",
      "",
      "VERFASSER-REGEL BEI BEHOERDEN/INSTITUTIONEN:",
      "Wenn das Dokument von einer Behoerde stammt (KESB, Gericht, Amt, Spital, Schule):",
      "  - verfasser = die INSTITUTION (z.B. 'KESB Leimental'), NICHT das Behördenmitglied",
      "  - Das Behördenmitglied (z.B. 'Susanne Angst, Behördenmitglied') → in personen-Liste",
      "  - absender = die Institution (gleich wie verfasser bei Behoerden)",
      "Nur bei privaten Briefen/E-Mails: verfasser = die schreibende Person.",
      "NUR JSON. Kein Markdown. Kein zusaetzlicher Text."
    ].join("\n");

  const userText = [
    `Analysiere dieses Dokument-Bild gruendlich. Dateiname: "${originalName}".`,
    "Lies den GESAMTEN sichtbaren Text, auch wenn das Bild schraeg oder perspektivisch verzerrt ist.",
    "Extrahiere Titel, Verfasser, Datum, Institution, alle Personen mit Rollen.",
    "Zaehle positive und negative Aussagen ueber die Fokus-Partei.",
    "Schreibe ein aussagekraeftiges Fazit (zusammenfassung)."
  ].join("\n");

  try {
    const responseText = await callClaudeVision(systemPrompt, userText, base64, mimeType || "image/png", 2500);
    console.log(`[vision-raw] Response for ${originalName}:`, (responseText || "").substring(0, 500));
    const parsed = extractJsonObject(responseText || "");
    console.log(`[vision-parsed] Personen:`, JSON.stringify(parsed?.personen || []));

    if (!parsed || typeof parsed !== "object") {
      return {
        status: "empty",
        title: "", author: "", authoredDate: "", people: [], disadvantagedPerson: "",
        message: "Kein klarer Inhalt im Bild erkannt."
      };
    }

    const normalized = parsed?.beteiligte
      ? mapChatForensicJsonToAnalysis(parsed, {})
      : (parsed?.auswertung || parsed?.statistik || parsed?.metadaten || parsed?.analyse_score)
        ? mapBiasForensicJsonToAnalysis(parsed, {}, "")
        : mapSwissForensicJsonToAnalysis(parsed, {}, "");

    const hasAnyContent = normalized.title || normalized.author || normalized.authoredDate
      || normalized.senderInstitution || normalized.impactAssessment
      || Number(normalized.positiveMentions || 0) > 0
      || Number(normalized.negativeMentions || 0) > 0
      || (normalized.people && normalized.people.length > 0);

    if (!hasAnyContent) {
      return {
        status: "empty",
        title: "", author: "", authoredDate: "", people: [], disadvantagedPerson: "",
        message: normalized.message || "Kein klarer Inhalt im Bild erkannt."
      };
    }

    // ── Clean LLM output: strip metadata from names, dedup ──
    if (Array.isArray(normalized.people)) {
      normalized.people = normalized.people
        .map(p => {
          let name = normalizeWhitespace(p.name || "");
          // Strip birth dates/gender that LLM may have left in the name
          name = name.replace(/,?\s*geb\.?\s*\d[\d.\-/\s]*/gi, "").replace(/,?\s*\b[mfw]\s*$/i, "").trim();
          if (!name) return null;
          return { ...p, name };
        })
        .filter(Boolean);
      // Simple dedup by lowercase name
      const seen = new Set();
      normalized.people = normalized.people.filter(p => {
        const key = normalizeWhitespace(p.name).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return normalized;
  } catch (error) {
    const statusCode = Number(error?.status || 0);
    if (statusCode === 429) {
      return {
        status: "needs-config",
        title: "", author: "", authoredDate: "", people: [], disadvantagedPerson: "",
        message: "API-Limit erreicht. Bitte spaeter erneut versuchen."
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

async function renderPdfPagesToImageBuffers(fileBuffer, maxPages = 6) {
  try {
    const pdfjs = await getPdfJsLib();
    if (!pdfjs?.getDocument) {
      return [];
    }

    const { createCanvas } = require("@napi-rs/canvas");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fileBuffer),
      disableWorker: true,
      useSystemFonts: true,
      isEvalSupported: false
    });

    const pdfDocument = await loadingTask.promise;
    const pageCount = Math.min(Number(pdfDocument?.numPages || 0), maxPages);
    const renderedPages = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
      renderedPages.push(canvas.toBuffer("image/png"));
      page.cleanup?.();
    }

    await loadingTask.destroy?.();
    return renderedPages;
  } catch (error) {
    console.warn("PDF render warning:", error.message);
    return [];
  }
}

/**
 * Vision fallback for PDFs with handwritten or poorly-OCR'd content.
 * Renders PDF pages to images and sends them to Claude Vision for full analysis.
 * Returns the same structure as analyzeLegalDocument so it can be used as a drop-in.
 */
async function analyzePdfWithVision(fileBuffer, documentTitle = "", protectedPersonName = "", opposingPartyName = "") {
  if (!getAnthropicClient()) return null;

  const renderedPages = await renderPdfPagesToImageBuffers(fileBuffer, 4);
  if (renderedPages.length === 0) return null;

  const focusAliases = parsePartyAliases(protectedPersonName);
  const referenceAliases = parsePartyAliases(opposingPartyName);
  const focusKeywords = focusAliases.aliases.length > 0 ? focusAliases.aliases.join(", ") : "(keine)";
  const referenceKeywords = referenceAliases.aliases.length > 0 ? referenceAliases.aliases.join(", ") : "(keine)";

  const systemPrompt = [
    "Du bist ein forensischer Dokumenten-Analyst fuer Familienrecht.",
    "Deine Aufgabe: Lies die PDF-Seiten VOLLSTAENDIG, auch handschriftlichen Text.",
    "Lies JEDEN sichtbaren Text Zeile fuer Zeile. Erfinde NICHTS.",
    "",
    "### DATUMSFORMAT (PFLICHT):",
    "- Alle Datumsangaben im Format TT.MM.JJJJ zurueckgeben.",
    "- 2-stellige Jahreszahl konvertieren: 24.06.23 → 24.06.2023",
    "- Kein Datum erkennbar → '-'",
    "",
    "### PERSONEN-EXTRAKTION (PFLICHT – STRIKTE REGELN):",
    "Das Array 'personen' ist AUSSCHLIESSLICH fuer echte menschliche Individuen.",
    "Lies das GESAMTE Dokument und extrahiere ALLE Personennamen.",
    "AUCH handschriftlich geschriebene Namen muessen extrahiert werden!",
    "",
    "REGELN:",
    "- NUR echte Menschennamen (Vorname und/oder Nachname).",
    "- KEINE Institutionen (UKBB, KESB, Gericht, Spital, Kinderspital) → gehoeren in 'absender'.",
    "- KEINE Dokumenttypen (Medizinisches Rezept, Gutachten) → NICHT in personen.",
    "- KEINE Fachbegriffe (Ergotherapie, Diagnose) → NICHT in personen.",
    "- Handschriftliche Namen besonders sorgfaeltig lesen.",
    "- Bei medizinischen Dokumenten: Patient/Patientin ist eine Person – NAME extrahieren!",
    "- Bestimme die Rolle aus dem Kontext: Patient, Vater, Mutter, Kind, Arzt, etc.",
    "- BEMERKUNG (Pflichtfeld): Was tut/betrifft diese Person im Dokument? 1 Satz.",
    "- Wenn KEINE echten Personennamen gefunden → personen-Array LEER lassen: []",
    "",
    `FOKUS-PARTEI = [${focusKeywords}]`,
    `GEGENPARTEI = [${referenceKeywords}]`,
    "",
    "### JSON-SCHEMA (exakt einhalten):",
    "{",
    '  "score": <number 0-100>,',
    '  "risikoStufe": "<niedrig|mittel|hoch|kritisch>",',
    '  "personen": [',
    '    {"name": "Vorname Nachname", "rolle": "Funktion", "sentiment": "positiv|negativ|neutral", "bemerkung": "1 Satz"}',
    "  ],",
    '  "findings": [',
    '    {"typ": "<widerspruch|manipulation|fehlende_evidenz|suggestive_sprache|framing|benachteiligung>",',
    '     "stelle": "<Zitat>", "analyse": "<Erklaerung>", "schweregrad": "<niedrig|mittel|hoch|kritisch>"}',
    "  ],",
    '  "statistik": {"widersprueche": 0, "manipulationen": 0, "fehlende_belege": 0, "suggestive_formulierungen": 0},',
    '  "fazit": "<Zusammenfassung, max 4 Saetze>"',
    "}",
    "",
    "NUR JSON. Kein Markdown. Kein zusaetzlicher Text. Keine Codeblocks."
  ].join("\n");

  const imageContent = renderedPages.map(buf => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: buf.toString("base64")
    }
  }));

  const userText = [
    `Analysiere dieses PDF-Dokument gruendlich. Dateiname: "${documentTitle}".`,
    `Das Dokument hat ${renderedPages.length} Seite(n).`,
    "Lies den GESAMTEN sichtbaren Text, AUCH handschriftliche Eintraege.",
    "Extrahiere ALLE Personennamen inkl. handschriftlich geschriebener Namen.",
    "Bei medizinischen Dokumenten: Der Patient ist eine Person – Namen extrahieren!"
  ].join("\n");

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: userText },
          ...imageContent
        ]
      }]
    });

    const raw = response?.content?.[0]?.text || "";
    console.log(`[pdf-vision] Response for ${documentTitle}:`, raw.substring(0, 500));
    const parsed = extractJsonObject(raw);

    if (!parsed || typeof parsed !== "object") return null;

    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      risikoStufe: parsed.risikoStufe || "niedrig",
      personen: Array.isArray(parsed.personen)
        ? parsed.personen
            .filter(p => p && typeof p === "object" && (p.name || "").trim())
            .map(p => ({
              name: (p.name || "").trim(),
              rolle: (p.rolle || "").trim(),
              sentiment: (p.sentiment || "neutral").trim(),
              bemerkung: (p.bemerkung || "").trim()
            }))
        : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      statistik: {
        widersprueche: Math.max(0, Number(parsed.statistik?.widersprueche) || 0),
        manipulationen: Math.max(0, Number(parsed.statistik?.manipulationen) || 0),
        fehlende_belege: Math.max(0, Number(parsed.statistik?.fehlende_belege) || 0),
        suggestive_formulierungen: Math.max(0, Number(parsed.statistik?.suggestive_formulierungen) || 0)
      },
      fazit: String(parsed.fazit || "Vision-Analyse abgeschlossen."),
      status: "ok",
      _visionAnalyzed: true
    };
  } catch (err) {
    console.warn(`[pdf-vision] Vision analysis failed for ${documentTitle}:`, err.message);
    return null;
  }
}

async function extractTextFromPdfWithOcr(fileBuffer) {
  const renderedPages = await renderPdfPagesToImageBuffers(fileBuffer);
  if (renderedPages.length === 0) {
    return "";
  }

  const pageTexts = [];
  for (const pageBuffer of renderedPages) {
    const pageText = await extractTextFromImageWithOcr(pageBuffer);
    if (pageText) {
      pageTexts.push(pageText);
    }
  }

  return normalizeExtractedDocumentText(pageTexts.join("\n\n"));
}

async function analyzeImageWithFallback(fileBuffer, mimeType, originalName = "", protectedPersonName = "", opposingPartyName = "") {
  const fileNameTitle = deriveTitleFromFileName(originalName);
  const isChatImage = /whats?app|chat|nachricht|dialog|sms|signal|telegram/i.test(String(originalName || "").toLowerCase());

  // Strategy: Vision-First with Claude (handles skewed photos, handwriting,
  // perspective distortion much better than Tesseract OCR).
  // OCR is only used as fallback when vision model is unavailable.

  if (!isChatImage && getAnthropicClient()) {
    console.log(`[image-analysis] Using vision model for ${originalName}`);
    try {
      const imageResult = await extractTitleFromImageWithAi(fileBuffer, mimeType, originalName, protectedPersonName, opposingPartyName);
      if (imageResult.status !== "needs-ocr" && imageResult.status !== "needs-config") {
        return imageResult;
      }
    } catch (visionErr) {
      console.warn(`[image-analysis] Vision failed for ${originalName}:`, visionErr.message);
    }

    // Vision failed — try OCR as fallback
    console.log(`[image-analysis] Vision insufficient, trying OCR for ${originalName}`);
    try {
      const ocrText = await extractTextFromImageWithOcr(fileBuffer);
      if (ocrText && ocrText.trim().length > 30) {
        console.log(`[image-analysis] OCR extracted ${ocrText.length} chars from ${originalName}`);
        const fallback = buildHeuristicAnalysisFromText(ocrText, {});
        const aiFromText = await analyzeTextWithAi(ocrText, fallback, protectedPersonName, opposingPartyName);
        if (aiFromText.status === "ok") return aiFromText;
        return buildFallbackAnalysis({ ...fallback, title: fallback.title || fileNameTitle, message: "Bildtext via OCR analysiert." });
      }
    } catch (ocrErr) {
      console.warn(`[image-analysis] OCR fallback failed for ${originalName}:`, ocrErr.message);
    }
  } else if (!isChatImage) {
    // No Anthropic client — OCR only
    try {
      const ocrText = await extractTextFromImageWithOcr(fileBuffer);
      if (ocrText && ocrText.trim().length > 30) {
        const fallback = buildHeuristicAnalysisFromText(ocrText, {});
        return buildFallbackAnalysis({ ...fallback, title: fallback.title || fileNameTitle, message: "Bildtext via OCR analysiert." });
      }
    } catch (ocrErr) {
      console.warn(`[image-analysis] OCR failed for ${originalName}:`, ocrErr.message);
    }
  }

  // Vision model path (chat images, or OCR-failed non-chat)
  try {
    const imageResult = await extractTitleFromImageWithAi(fileBuffer, mimeType, originalName, protectedPersonName, opposingPartyName);
    if (imageResult.status !== "needs-ocr" && imageResult.status !== "needs-config") {
      return imageResult;
    }

    // Vision failed, try OCR as last resort
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
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS owner_id integer");
        await pool.query("ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_by UUID");
        // Backfill: assign unowned cases to admin
        const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
        if (adminEmail) {
          await pool.query(
            `UPDATE cases SET created_by = (SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1) WHERE created_by IS NULL`,
            [adminEmail]
          );
        }
        // Ensure customer_users exists for access-control queries
        await pool.query(`
          CREATE TABLE IF NOT EXISTS customer_users (
            id SERIAL PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            collaborator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            function_label TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE(customer_id, collaborator_id)
          )
        `);
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

async function createCaseCompat(caseId, caseDate, caseName, protectedPerson, opposingParty, country, locality, region, city, createdBy) {
  await ensureCaseOptionalColumns();
  try {
    const result = await pool.query(
      "INSERT INTO cases (id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city, created_at",
      [caseId, caseDate, caseName, protectedPerson, opposingParty, country, locality, region, city, createdBy]
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

// Resolve single-token names (e.g. "Ayhan") to full names (e.g. "Ayhan Ergen")
// by matching against the case's known party aliases.
function resolvePartialNames(people, protectedAliases = [], opposingAliases = []) {
  if (!Array.isArray(people) || people.length === 0) return people;

  // Build a lookup: first-name-token → full multi-word alias
  const tokenToFull = new Map();
  for (const alias of [...protectedAliases, ...opposingAliases]) {
    const parts = normalizeWhitespace(alias).split(/\s+/);
    if (parts.length >= 2) {
      // Map each part to the full name: "Ayhan" → "Ayhan Ergen", "Ergen" → "Ayhan Ergen"
      for (const part of parts) {
        const key = part.toLowerCase();
        // Only map if the part is a real name token (>= 3 chars, not a role keyword)
        if (key.length >= 3 && !/^(vater|mutter|kind|kindsvater|kindsmutter|kindesvater|kindesmutter)$/.test(key)) {
          // Prefer longer full name if multiple matches
          const existing = tokenToFull.get(key);
          if (!existing || alias.length > existing.length) {
            tokenToFull.set(key, alias);
          }
        }
      }
    }
  }

  if (tokenToFull.size === 0) return people;

  const resolvedKeys = new Set();
  return people.map(p => {
    const name = normalizeWhitespace(typeof p === "string" ? p : p?.name || "");
    const parts = name.split(/\s+/);
    // Only resolve single-token names
    if (parts.length !== 1) return p;
    const key = parts[0].toLowerCase();
    const fullName = tokenToFull.get(key);
    if (fullName && !resolvedKeys.has(fullName.toLowerCase())) {
      resolvedKeys.add(fullName.toLowerCase());
      console.log(`[name-resolve] "${name}" → "${fullName}"`);
      if (typeof p === "string") return fullName;
      return { ...p, name: fullName };
    }
    return p;
  });
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
    people: resolvePartialNames(
      Array.isArray(analysis.people) ? [...analysis.people] : [],
      protectedIdentity.aliases,
      opposingIdentity.aliases
    ),
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
    // Only set generic assessment if KI didn't provide a real Fazit
    if (!output.impactAssessment || output.impactAssessment.length < 10) {
      output.impactAssessment = "Person benachteiligt";
    }
  }

  // Only re-normalize if we have rawText (PDF/text analysis).
  // For image analysis (rawText empty), people are already normalized by the Vision pipeline.
  const authorForFilter = normalizeWhitespace(output.author || "");
  const normalizedPeople = rawText
    ? normalizePeopleDetailed(output.people, rawText, new Set(), authorForFilter)
    : output.people.filter(p => {
        if (!p) return false;
        const name = normalizeWhitespace(typeof p === "string" ? p : p.name || "");
        if (!name) return false;
        // Exclude author from people list
        const nameKey = name.toLowerCase();
        const authorKey = authorForFilter.toLowerCase();
        const strippedAuthor = authorKey.replace(/^(prof\.?\s*)?(dr\.?\s*(med\.?\s*)?)?/i, "").trim();
        return nameKey !== authorKey && nameKey !== strippedAuthor;
      });
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
    output.positiveMentions = Math.max(
      Number(output.positiveMentions || 0),
      Math.max(0, strictCounts.groupA.positive)
    );
    output.negativeMentions = Math.max(
      Number(output.negativeMentions || 0),
      Math.max(0, strictCounts.groupA.negative)
    );
    output.opposingPositiveMentions = Math.max(
      Number(output.opposingPositiveMentions || 0),
      Math.max(0, strictCounts.groupB.positive)
    );
    output.opposingNegativeMentions = Math.max(
      Number(output.opposingNegativeMentions || 0),
      Math.max(0, strictCounts.groupB.negative)
    );
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

  // ════════════════════════════════════════════════════════════════════
  // DETERMINISTIC POST-PROCESSING RULES (override AI when needed)
  // These rules run AFTER the AI and fix known blind spots reliably.
  // ════════════════════════════════════════════════════════════════════

  const docText = String(rawText || "").toLowerCase();
  const institutionLower = normalizeWhitespace(output.senderInstitution || "").toLowerCase();
  const authorNorm = normalizeWhitespace(output.author || "").toLowerCase();

  // ── RULE 1: Filter out hallucinated persons ──
  // Remove party keyword names from persons list if they don't appear in the document text.
  if (output.people && output.people.length > 0) {
    const allPartyAliases = [...protectedIdentity.aliases, ...opposingIdentity.aliases]
      .map(a => a.toLowerCase());

    output.people = output.people.filter(person => {
      const personName = normalizeWhitespace(typeof person === "string" ? person : person?.name).toLowerCase();
      if (!personName) return true;

      // Check if this person's name matches any party alias
      const isPartyAlias = allPartyAliases.some(alias => {
        const aliasLower = alias.toLowerCase();
        return personName.includes(aliasLower) || aliasLower.includes(personName);
      });

      // If it's a party alias, it must appear in the raw document text
      if (isPartyAlias) {
        return allPartyAliases.some(alias => docText.includes(alias.toLowerCase()));
      }

      return true; // Non-party persons keep
    });
  }

  // ── RULE 2: Police / Bedrohungsmanagement / KESB documents ──
  // Only applies when the SENDER/AUTHOR is the institution, NOT when the
  // institution is merely mentioned in the text (e.g. a lawyer writing TO KESB).
  const senderAndAuthor = (institutionLower + " " + authorNorm).toLowerCase();
  const isPoliceDoc = /polizei|bedrohungsmanagement|polizeilich|strafanzeige/i.test(senderAndAuthor);
  const isKESBDoc = /\bkesb\b|kindes.*schutz/i.test(senderAndAuthor);
  const isInstitutionalThreat = isPoliceDoc || isKESBDoc;

  if (isInstitutionalThreat) {
    // Single file: Negativ 1 for focus party (this document exists in the dossier)
    // The police is neutral – they are NOT the opposing party, so Gegenpartei stays 0.
    // "Keine Falleröffnung" is not positive – it's just neutral. No positiv count.
    // The SYSTEM pattern (multiple police files = systematic destruction) is detected
    // by the MASTER SCAN, not here.
    output.negativeMentions = Math.max(Number(output.negativeMentions || 0), 1);

    // Do NOT count anything for Gegenpartei – police is a neutral third party.
    // Do NOT count "keine Falleröffnung" as positive – neutral is not positive.
    // Reset any AI-hallucinated positive counts for this type of document.
    output.positiveMentions = 0;
  }

  // ── RULE 3: Author-bias elimination ──
  // If the document author IS the focus party, discount self-praise.
  const authorIsProtected = protectedIdentity.aliases.some(a => authorNorm.includes(a.toLowerCase()));

  if (authorIsProtected) {
    const pos = Number(output.positiveMentions || 0);
    const neg = Number(output.negativeMentions || 0);
    if (pos > 0 && neg === 0) {
      output.positiveMentions = 0;
    }
  }

  // ── RULE 3b: Focus party's own lawyer cannot be negative ──
  // If the document author is the focus party's lawyer/legal representative,
  // they write ON BEHALF of the focus party. Any "negative" the AI detects
  // is likely the lawyer citing opposing claims or describing the situation,
  // not actual criticism of their own client.
  // Detect: author is a lawyer/Anwalt AND sender institution contains "Anwalt/Advokat/Kanzlei"
  // OR the document is addressed to a court/KESB on behalf of the focus party.
  const isLawyerDoc = /anw[aä]lt|advokat|kanzlei|rechtsanw|rechtsvertre/i.test(senderAndAuthor);
  const authorIsOpposingParty = opposingIdentity.aliases.some(a => authorNorm.includes(a.toLowerCase()));

  if (isLawyerDoc && !authorIsOpposingParty) {
    // Lawyer of focus party: no scoring at all.
    // Positives are the lawyer arguing FOR the client (biased by definition).
    // Negatives are the lawyer citing opposing claims (not actual criticism).
    // Both distort the result → zero out everything.
    output.positiveMentions = 0;
    output.negativeMentions = 0;
  }

  // ── RULE 4: No opposing party scoring ──
  // Only focus party scoring matters. Saves tokens, reduces noise, cleaner results.
  output.opposingPositiveMentions = 0;
  output.opposingNegativeMentions = 0;

  return output;
}

router.post("/", requireAuth, async (req, res) => {
  if (req.user.role === "collaborator") {
    return res.status(403).json({ error: "Nur Fall-Inhaber oder Admin können Fälle erstellen." });
  }
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
    const created = await createCaseCompat(normalizedCaseId, caseDate, normalizedCaseName, protectedPerson, opposingParty, country, locality, region, city, req.user.sub);
    return res.status(201).json(created);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Fall-ID existiert bereits." });
    }
    console.error("Create case error:", err.message);
    return res.status(500).json({ error: "Fall konnte nicht erstellt werden." });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const userRole = req.user.role;

    // Team members (collaborators) only see their assigned case
    if (userRole === "collaborator") {
      const userRes = await pool.query("SELECT case_id FROM users WHERE id = $1", [req.user.sub]);
      const assignedCaseId = userRes.rows[0]?.case_id;
      if (!assignedCaseId) {
        return res.json({ cases: [] });
      }
      await ensureCaseOptionalColumns();
      const caseRes = await pool.query(
        "SELECT id, case_date, case_name, protected_person_name, opposing_party, country, locality, region, city, created_at FROM cases WHERE id = $1",
        [assignedCaseId]
      );
      return res.json({ cases: caseRes.rows });
    }

    // Admin sees all cases
    if (userRole === "admin") {
      const cases = await listCasesCompat();
      return res.json({ cases });
    }

    // Customer sees only their own cases (created_by or assigned via case_id)
    await ensureCaseOptionalColumns();
    const userId = req.user.sub;
    const ownedCases = await pool.query(
      `SELECT DISTINCT c.id, c.case_date, c.case_name, c.protected_person_name, c.country, c.locality, c.region, c.city, c.created_at
       FROM cases c
       WHERE c.created_by = $1
          OR c.id IN (SELECT u.case_id FROM users u WHERE u.id = $1 AND u.case_id IS NOT NULL)
       ORDER BY c.created_at DESC LIMIT 200`,
      [userId]
    );
    return res.json({ cases: ownedCases.rows });
  } catch (err) {
    console.error("List cases error:", err.message);
    return res.status(500).json({ error: "Fallliste konnte nicht geladen werden." });
  }
});

router.patch("/:caseId", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }

  const allowedFields = ["case_name", "protected_person_name", "opposing_party", "country", "region", "city", "locality"];
  const updates = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = String(req.body[field] || "").trim() || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Aktualisieren angegeben." });
  }

  try {
    await ensureCaseOptionalColumns();
    const setClauses = Object.keys(updates).map((field, i) => `${field} = $${i + 2}`).join(", ");
    const values = [caseId, ...Object.values(updates)];
    await pool.query(`UPDATE cases SET ${setClauses} WHERE id = $1`, values);

    const partiesChanged = ["protected_person_name", "opposing_party", "country", "region", "city", "locality"]
      .some((f) => f in updates);
    if (partiesChanged) {
      const current = await getCaseParties(caseId);
      await upsertCasePartiesFallback(
        caseId,
        updates.protected_person_name !== undefined ? updates.protected_person_name : current.protectedPersonName,
        updates.opposing_party !== undefined ? updates.opposing_party : current.opposingPartyName,
        updates.country !== undefined ? updates.country : current.country,
        updates.locality !== undefined ? updates.locality : current.locality,
        updates.region !== undefined ? updates.region : current.region,
        updates.city !== undefined ? updates.city : current.city
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Patch case error:", err.message);
    return res.status(500).json({ error: "Fall konnte nicht aktualisiert werden." });
  }
});

router.delete("/:caseId", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }

  // Only admin or customer (case owner) can delete a case
  const userRole = req.user?.role || "customer";
  if (userRole !== "admin" && userRole !== "customer") {
    return res.status(403).json({ error: "Nur Administratoren und Fallinhaber können Fälle löschen." });
  }

  try {
    // 1. Get all files for this case to clean up storage
    const filesResult = await pool.query(
      "SELECT stored_name FROM case_documents WHERE case_id = $1",
      [caseId]
    );

    // 2. Delete files from Supabase Storage
    const bucket = getStorageBucket();
    if (bucket && filesResult.rows.length > 0) {
      const storagePaths = filesResult.rows.map(r => r.stored_name).filter(Boolean);
      if (storagePaths.length > 0) {
        const { error: storageError } = await bucket.remove(storagePaths);
        if (storageError) {
          console.warn(`[case-delete] Storage cleanup warning for ${caseId}:`, storageError.message);
          // Continue with DB delete even if storage fails
        } else {
          console.log(`[case-delete] Removed ${storagePaths.length} files from storage for case ${caseId}`);
        }
      }
    }

    // 3. Delete case (CASCADE removes case_documents + case_document_analysis)
    const result = await pool.query("DELETE FROM cases WHERE id = $1 RETURNING id", [caseId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Fall nicht gefunden." });
    }
    console.log(`[case-delete] Case ${caseId} deleted by user ${req.user?.id} (${filesResult.rows.length} files)`);
    return res.json({ ok: true, caseId, deletedFiles: filesResult.rows.length });
  } catch (err) {
    console.error("Delete case error:", err.message);
    return res.status(500).json({ error: "Fall konnte nicht gelöscht werden." });
  }
});

router.post("/:caseId/files", requireAuth, requireCaseAccess("write"), (req, res) => {
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

        // Fire-and-forget: auto-trigger forensic analysis for PDFs
        if (String(file.mimetype || "").includes("pdf")) {
          const docId = result.rows[0].id;
          const objPath = objectPath;
          setImmediate(async () => {
            try {
              const buf = await downloadStorageFile(caseId, objPath);
              const pdfParse = getPdfParse();
              const parsed = pdfParse ? await pdfParse(buf) : { text: "" };
              const txt = String(parsed?.text || "");
              const ocrTxt = shouldUsePdfOcrFallback(txt) ? await extractTextFromPdfWithOcr(buf) : "";
              const finalText = pickBetterPdfText(txt, ocrTxt);

              let forensic;
              if (!finalText || !finalText.trim() || scoreExtractedTextQuality(finalText) < 0.5) {
                // Text extraction failed or very poor → use Vision to read handwritten/scanned content
                console.log(`[forensic] Text quality too low for ${decodedOriginalName}, trying Vision…`);
                let protectedName = "";
                let opposingName = "";
                try {
                  const caseRow = await pool.query("SELECT protected_person, opposing_party FROM cases WHERE id = $1 LIMIT 1", [caseId]);
                  if (caseRow.rows.length > 0) {
                    protectedName = caseRow.rows[0].protected_person || "";
                    opposingName = caseRow.rows[0].opposing_party || "";
                  }
                } catch (_) { /* ignore */ }
                forensic = await analyzePdfWithVision(buf, decodedOriginalName, protectedName, opposingName);
                if (!forensic) {
                  // Vision also failed — try text analysis with whatever we have
                  if (finalText && finalText.trim()) {
                    forensic = await analyzeLegalDocument(finalText, {
                      documentTitle: decodedOriginalName,
                      documentType: "PDF"
                    });
                  }
                }
              } else {
                forensic = await analyzeLegalDocument(finalText, {
                  documentTitle: decodedOriginalName,
                  documentType: "PDF"
                });
              }

              if (forensic) {
                // Merge AI-extracted personen into forensic result
                if (Array.isArray(forensic.personen) && forensic.personen.length > 0) {
                  forensic.people = forensic.personen.map((p) => ({
                    name: p.name,
                    affiliation: p.rolle || "Privatperson",
                    ...(p.sentiment && { sentiment: p.sentiment }),
                    ...(p.bemerkung && { bemerkung: p.bemerkung })
                  }));
                }
                forensic.documentId = docId;
                forensic.fileName = decodedOriginalName;
                await saveForensicAnalysis(docId, forensic);
                console.log(`[forensic] Auto-analyzed: ${decodedOriginalName} → score ${forensic.score}${forensic._visionAnalyzed ? " (vision)" : ""}`);
              }
            } catch (e) {
              console.warn(`[forensic] Auto-analysis failed for ${decodedOriginalName}:`, e.message);
            }
          });
        }
      }

      return res.status(201).json({ uploaded: inserted });
    } catch (err) {
      console.error("File upload error:", err.message);
      return res.status(500).json({ error: "Datei-Upload fehlgeschlagen." });
    }
  });
});

router.get("/:caseId/files", requireAuth, requireCaseAccess("read"), async (req, res) => {
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

router.get("/:caseId/files/:fileId/preview", requireAuth, requireCaseAccess("read"), async (req, res) => {
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

router.get("/:caseId/files/:fileId/download", requireAuth, requireCaseAccess("read"), async (req, res) => {
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

router.get("/:caseId/files/:fileId/analysis", requireAuth, requireCaseAccess("read"), async (req, res) => {
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
        // For onlyStored requests (report view), always return cached data
        if (onlyStored) {
          return res.json(withAnalysisRuntimeMeta(stored));
        }
        // Auto-refresh if the analysis was created by an older engine version
        const storedVersion = stored.analysisEngineVersion || "";
        const currentVersion = getAnalysisEngineVersion();
        if (storedVersion && currentVersion !== "local" && storedVersion === currentVersion) {
          return res.json(withAnalysisRuntimeMeta(stored));
        }
        // Version mismatch → re-analyze with current engine
        console.log(`[auto-refresh] File ${file.id}: engine ${storedVersion} → ${currentVersion}`);
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
        const parsed = pdfParse ? await pdfParse(fileBuffer) : { text: "", info: {} };
        const parsedText = String(parsed?.text || "");
        const ocrText = shouldUsePdfOcrFallback(parsedText)
          ? await extractTextFromPdfWithOcr(fileBuffer)
          : "";
        const normalizedParsedText = normalizeExtractedDocumentText(parsedText);
        const normalizedOcrText = normalizeExtractedDocumentText(ocrText);
        const extractedText = pickBetterPdfText(parsedText, ocrText);
        const usedOcr = Boolean(normalizedOcrText)
          && extractedText === normalizedOcrText
          && extractedText !== normalizedParsedText;

        // Vision fallback: if text is empty or garbage, use Claude Vision on rendered pages
        if (!extractedText || isGarbageText(extractedText)) {
          console.log(`[analysis] Text empty or garbage for ${file.original_name}, trying Vision…`);
          const visionResult = await analyzePdfWithVision(fileBuffer, file.original_name, parties.protectedPersonName, parties.opposingPartyName);
          if (visionResult && visionResult.status === "ok") {
            // Map vision forensic result to analysis format
            const visionPeople = Array.isArray(visionResult.personen)
              ? visionResult.personen
                  .filter(p => isHumanNameCases(p.name))
                  .map(p => ({
                    name: p.name,
                    affiliation: p.rolle || "Privatperson",
                    ...(p.sentiment && { sentiment: p.sentiment }),
                    ...(p.bemerkung && { bemerkung: p.bemerkung })
                  }))
              : [];
            const visionAnalysis = buildFallbackAnalysis({
              title: file.original_name.replace(/\.[^.]+$/, ""),
              author: "",
              authoredDate: "",
              people: visionPeople,
              senderInstitution: "",
              impactAssessment: visionResult.fazit || "",
              rawText: ""
            });
            visionAnalysis.score = visionResult.score || 0;
            visionAnalysis._visionAnalyzed = true;
            const enriched = enrichAnalysisForReport(visionAnalysis, {
              rawText: "",
              protectedAliases: parsePartyAliases(parties.protectedPersonName).aliases,
              opposingAliases: parsePartyAliases(parties.opposingPartyName).aliases,
              textQuality: buildTextQualityMeta("", {
                sourceType: "PDF",
                extractionMethod: "Claude Vision (Text nicht lesbar)",
                ocrUsed: true
              }),
              methodology: "Vision-basierte Analyse (Textextraktion fehlgeschlagen)."
            });
            await saveDocumentAnalysis(file.id, enriched);
            return res.json(withAnalysisRuntimeMeta(enriched));
          }

          // Vision also failed — return empty
          if (!extractedText) {
            const emptyResult = {
              status: "empty",
              title: "",
              author: "",
              authoredDate: "",
              people: [],
              disadvantagedPerson: "",
              message: pdfParse
                ? "PDF-Inhalt konnte nicht gelesen werden (möglicherweise Scan oder defekter Textlayer)."
                : "PDF-Parser ist aktuell nicht verfuegbar und OCR lieferte keinen klaren Text."
            };
            await saveDocumentAnalysis(file.id, emptyResult);
            return res.json(withAnalysisRuntimeMeta(emptyResult));
          }
          // Fall through to text analysis with whatever we have
        }

        const fallback = buildHeuristicAnalysisFromText(extractedText, parsed?.info || {});
        const aiResult = await analyzeTextWithAi(extractedText, fallback, parties.protectedPersonName, parties.opposingPartyName);
        const focused = applyProtectedPersonFocus(aiResult, extractedText, parties.protectedPersonName, parties.opposingPartyName);
        const enriched = enrichAnalysisForReport(focused, {
          rawText: extractedText,
          protectedAliases: parsePartyAliases(parties.protectedPersonName).aliases,
          opposingAliases: parsePartyAliases(parties.opposingPartyName).aliases,
          textQuality: buildTextQualityMeta(extractedText, {
            sourceType: "PDF",
            extractionMethod: usedOcr ? "OCR-Fallback" : (normalizedParsedText ? "Direkter Textlayer" : "OCR"),
            ocrUsed: Boolean(normalizedOcrText)
          }),
          methodology: "Quantitative Parteiauswertung mit Positiv-/Negativzählung, Rollenabgleich und Belegstellenprüfung."
        });
        await saveDocumentAnalysis(file.id, enriched);
        return res.json(withAnalysisRuntimeMeta(enriched));
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
      console.log(`[image-analysis] People from Vision:`, JSON.stringify((imageResult?.people || []).map(p => p.name || p)));
      const focused = applyProtectedPersonFocus(imageResult, "", parties.protectedPersonName, parties.opposingPartyName);
      console.log(`[image-analysis] People after focus:`, JSON.stringify((focused?.people || []).map(p => p.name || p)));
      const enriched = enrichAnalysisForReport(focused, {
        rawText: "",
        protectedAliases: parsePartyAliases(parties.protectedPersonName).aliases,
        opposingAliases: parsePartyAliases(parties.opposingPartyName).aliases,
        textQuality: {
          score: null,
          label: "Nicht verfügbar",
          confidence: "Manuell prüfen",
          extractionMethod: /ocr/i.test(String(focused.message || "")) ? "OCR" : "Bildanalyse",
          sourceType: "Bild",
          ocrUsed: /ocr/i.test(String(focused.message || ""))
        },
        methodology: "Bild- oder OCR-basierte Dokumentanalyse mit parteibezogener Positiv-/Negativzählung."
      });
      await saveDocumentAnalysis(file.id, enriched);
      return res.json(withAnalysisRuntimeMeta(enriched));
    }

    // ── E-Mail files (.eml / .msg) — extract text and analyze ──
    const mimeType = String(file.mime_type || "").toLowerCase();
    const ext = String(file.original_name || "").toLowerCase().split(".").pop() || "";
    if (ext === "eml" || ext === "msg" || mimeType === "message/rfc822" || mimeType === "application/vnd.ms-outlook") {
      try {
        const parties = await getCaseParties(caseId);
        let emailText = "";
        let emailMeta = {};

        if (ext === "eml" || mimeType === "message/rfc822") {
          // Parse EML (RFC 822) — plain text extraction
          const raw = fileBuffer.toString("utf-8");
          // Extract headers
          const headerEnd = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
          const headers = headerEnd > 0 ? raw.substring(0, headerEnd) : "";
          const body = headerEnd > 0 ? raw.substring(headerEnd + (raw[headerEnd + 1] === "\n" ? 2 : 4)) : raw;

          const getHeader = (name) => {
            const re = new RegExp(`^${name}:\\s*(.+?)$`, "mi");
            const m = headers.match(re);
            return m ? m[1].trim() : "";
          };

          emailMeta = {
            from: getHeader("From"),
            to: getHeader("To"),
            subject: getHeader("Subject"),
            date: getHeader("Date")
          };

          // Strip HTML tags if body is HTML, keep plain text
          let textBody = body;
          // Check for multipart — extract text/plain part
          const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/i);
          if (boundaryMatch) {
            const boundary = boundaryMatch[1];
            const parts = body.split("--" + boundary);
            for (const part of parts) {
              if (/content-type:\s*text\/plain/i.test(part)) {
                const partBody = part.substring(part.indexOf("\n\n") + 2);
                textBody = partBody;
                break;
              }
            }
          }
          // Strip remaining HTML
          textBody = textBody.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          // Decode quoted-printable
          textBody = textBody.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          // Decode UTF-8 encoded words in headers
          for (const key of Object.keys(emailMeta)) {
            emailMeta[key] = emailMeta[key].replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, text) => {
              if (encoding.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf-8");
              return text.replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/_/g, " ");
            });
          }

          emailText = [
            emailMeta.from ? `Von: ${emailMeta.from}` : "",
            emailMeta.to ? `An: ${emailMeta.to}` : "",
            emailMeta.date ? `Datum: ${emailMeta.date}` : "",
            emailMeta.subject ? `Betreff: ${emailMeta.subject}` : "",
            "",
            normalizeWhitespace(textBody)
          ].filter(Boolean).join("\n");
        } else {
          // .msg files — treat as binary, extract what we can
          const raw = fileBuffer.toString("utf-8");
          emailText = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
          emailText = normalizeWhitespace(emailText);
        }

        if (emailText.length < 20) {
          const empty = {
            status: "empty",
            title: emailMeta.subject || "",
            author: emailMeta.from || "",
            authoredDate: "",
            people: [],
            disadvantagedPerson: "",
            message: "E-Mail-Inhalt konnte nicht gelesen werden."
          };
          await saveDocumentAnalysis(file.id, empty);
          return res.json(withAnalysisRuntimeMeta(empty));
        }

        console.log(`[email-analysis] Extracted ${emailText.length} chars from ${file.original_name}`);
        const fallback = buildHeuristicAnalysisFromText(emailText, {});
        const aiResult = await analyzeTextWithAi(emailText, fallback, parties.protectedPersonName, parties.opposingPartyName);
        const focused = applyProtectedPersonFocus(aiResult, emailText, parties.protectedPersonName, parties.opposingPartyName);
        const enriched = enrichAnalysisForReport(focused, {
          rawText: emailText,
          protectedAliases: parsePartyAliases(parties.protectedPersonName).aliases,
          opposingAliases: parsePartyAliases(parties.opposingPartyName).aliases,
          textQuality: buildTextQualityMeta(emailText, {
            sourceType: "E-Mail",
            extractionMethod: ext === "eml" ? "EML-Parser" : "MSG-Extraktion",
            ocrUsed: false
          }),
          methodology: "E-Mail-Textanalyse mit parteibezogener Positiv-/Negativzählung."
        });
        await saveDocumentAnalysis(file.id, enriched);
        return res.json(withAnalysisRuntimeMeta(enriched));
      } catch (emailErr) {
        console.error("Email parse error:", emailErr.message);
        const fallbackResult = {
          status: "error",
          title: "",
          author: "",
          authoredDate: "",
          people: [],
          disadvantagedPerson: "",
          message: "E-Mail konnte nicht analysiert werden: " + emailErr.message
        };
        await saveDocumentAnalysis(file.id, fallbackResult);
        return res.json(withAnalysisRuntimeMeta(fallbackResult));
      }
    }

    // Preserve existing metadata (especially video date) on refresh
    const existingAnalysis = await loadStoredDocumentAnalysis(file.id);
    const unsupported = {
      status: "empty",
      title: existingAnalysis?.title || "",
      author: existingAnalysis?.author || "",
      authoredDate: existingAnalysis?.authoredDate || "",
      people: existingAnalysis?.people || [],
      disadvantagedPerson: existingAnalysis?.disadvantagedPerson || "",
      message: "Analyse f\u00fcr diesen Dateityp nicht verf\u00fcgbar."
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

/* ================================================================
   FORENSIC ANALYSIS – Claude-powered deep document forensics
   GET /:caseId/files/:fileId/forensic
   GET /:caseId/forensic  (dossier-level: all files)
   ================================================================ */

let forensicStorageInitPromise = null;
async function ensureForensicStorageTable() {
  if (!forensicStorageInitPromise) {
    forensicStorageInitPromise = pool.query(
      `CREATE TABLE IF NOT EXISTS case_document_forensic (
        document_id UUID PRIMARY KEY REFERENCES case_documents(id) ON DELETE CASCADE,
        forensic_json JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ).catch((err) => {
      console.warn("Could not create forensic storage table:", err.message);
      forensicStorageInitPromise = null;
    });
  }
  await forensicStorageInitPromise;
}

async function loadStoredForensic(documentId) {
  try {
    await ensureForensicStorageTable();
    const result = await pool.query(
      "SELECT forensic_json FROM case_document_forensic WHERE document_id = $1 LIMIT 1",
      [documentId]
    );
    return result.rows[0]?.forensic_json || null;
  } catch (err) {
    console.warn("Load forensic warning:", err.message);
    return null;
  }
}

async function saveForensicAnalysis(documentId, forensic) {
  try {
    await ensureForensicStorageTable();
    await pool.query(
      `INSERT INTO case_document_forensic (document_id, forensic_json, updated_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (document_id)
       DO UPDATE SET forensic_json = EXCLUDED.forensic_json, updated_at = CURRENT_TIMESTAMP`,
      [documentId, JSON.stringify(forensic)]
    );
  } catch (err) {
    console.warn("Save forensic warning:", err.message);
  }
}

// Single file forensic analysis
router.get("/:caseId/files/:fileId/forensic", requireAuth, requireCaseAccess("read"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const fileId = String(req.params.fileId || "").trim();
  const forceRefresh = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());

  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
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

    // Check cache
    if (!forceRefresh) {
      const stored = await loadStoredForensic(file.id);
      if (stored && typeof stored === "object" && stored.status === "ok") {
        return res.json(stored);
      }
    }

    // Only PDFs and images supported
    const mimeType = String(file.mime_type || "");
    if (!mimeType.includes("pdf") && !mimeType.startsWith("image/")) {
      return res.json({
        status: "unsupported",
        score: 0,
        findings: [],
        fazit: "Forensische Analyse ist nur fuer PDF- und Bild-Dateien verfuegbar."
      });
    }

    const fileBuffer = await downloadStorageFile(caseId, file.stored_name);
    let extractedText = "";

    if (mimeType.includes("pdf")) {
      const pdfParse = getPdfParse();
      const parsed = pdfParse ? await pdfParse(fileBuffer) : { text: "" };
      const parsedText = String(parsed?.text || "");
      const ocrText = shouldUsePdfOcrFallback(parsedText)
        ? await extractTextFromPdfWithOcr(fileBuffer)
        : "";
      extractedText = pickBetterPdfText(parsedText, ocrText);
    } else if (mimeType.startsWith("image/")) {
      try {
        const { createWorker } = require("tesseract.js");
        const worker = await createWorker("deu");
        const { data } = await worker.recognize(fileBuffer);
        extractedText = data?.text || "";
        await worker.terminate();
      } catch (ocrErr) {
        console.warn("OCR for forensic failed:", ocrErr.message);
      }
    }

    // Vision fallback for PDFs with poor/no text (handwritten, scanned)
    if (mimeType.includes("pdf") && (!extractedText || !extractedText.trim() || scoreExtractedTextQuality(extractedText) < 0.5)) {
      console.log(`[forensic] Text quality too low for ${file.original_name}, trying Vision…`);
      let protectedName = "";
      let opposingName = "";
      try {
        const caseRow = await pool.query("SELECT protected_person, opposing_party FROM cases WHERE id = $1 LIMIT 1", [caseId]);
        if (caseRow.rows.length > 0) {
          protectedName = caseRow.rows[0].protected_person || "";
          opposingName = caseRow.rows[0].opposing_party || "";
        }
      } catch (_) { /* ignore */ }
      const visionResult = await analyzePdfWithVision(fileBuffer, file.original_name, protectedName, opposingName);
      if (visionResult) {
        if (Array.isArray(visionResult.personen) && visionResult.personen.length > 0) {
          visionResult.people = visionResult.personen.map((p) => ({
            name: p.name,
            affiliation: p.rolle || "Privatperson",
            ...(p.sentiment && { sentiment: p.sentiment }),
            ...(p.bemerkung && { bemerkung: p.bemerkung })
          }));
        }
        visionResult.documentId = file.id;
        visionResult.fileName = file.original_name;
        await saveForensicAnalysis(file.id, visionResult);
        return res.json(visionResult);
      }
    }

    if (!extractedText || !extractedText.trim()) {
      const empty = {
        status: "empty",
        score: 0,
        findings: [],
        fazit: "Kein lesbarer Text im Dokument gefunden."
      };
      await saveForensicAnalysis(file.id, empty);
      return res.json(empty);
    }

    const forensicResult = await analyzeLegalDocument(extractedText, {
      documentTitle: file.original_name,
      documentType: mimeType.includes("pdf") ? "PDF" : "Bild/OCR"
    });

    // Merge AI-extracted personen into forensic result for downstream use
    if (Array.isArray(forensicResult.personen) && forensicResult.personen.length > 0) {
      forensicResult.people = forensicResult.personen.map((p) => ({
        name: p.name,
        affiliation: p.rolle || "Privatperson",
        ...(p.sentiment && { sentiment: p.sentiment }),
        ...(p.bemerkung && { bemerkung: p.bemerkung })
      }));
    }

    forensicResult.documentId = file.id;
    forensicResult.fileName = file.original_name;
    await saveForensicAnalysis(file.id, forensicResult);
    return res.json(forensicResult);

  } catch (err) {
    if (Number(err?.statusCode || 0) === 404 || Number(err?.statusCode || 0) === 503) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Forensic analysis error:", err.message);
    return res.status(500).json({ error: "Forensische Analyse konnte nicht durchgefuehrt werden." });
  }
});

// Dossier-level forensic analysis (all files in a case)
/* ── Forensic scan: in-memory job tracker + DB persistence ── */
const forensicJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, job] of forensicJobs) {
    if (job.startedAt < cutoff) forensicJobs.delete(key);
  }
}, 5 * 60 * 1000);

/* DB table for persistent forensic results */
let forensicTableReady = null;
async function ensureForensicResultsTable() {
  if (!forensicTableReady) {
    forensicTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS case_forensic_results (
        case_id TEXT PRIMARY KEY,
        step1_json JSONB,
        step2_json JSONB,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(e => { forensicTableReady = null; throw e; });
  }
  await forensicTableReady;
}

async function saveForensicStep(caseId, step, data) {
  await ensureForensicResultsTable();
  const col = step === 1 ? "step1_json" : "step2_json";
  await pool.query(
    `INSERT INTO case_forensic_results (case_id, ${col}, updated_at) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (case_id) DO UPDATE SET ${col} = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
    [caseId, JSON.stringify(data)]
  );
}

async function loadForensicResult(caseId) {
  try {
    await ensureForensicResultsTable();
    const r = await pool.query("SELECT step1_json, step2_json, updated_at FROM case_forensic_results WHERE case_id = $1", [caseId]);
    return r.rows[0] || null;
  } catch { return null; }
}

/* GET /:caseId/forensic/status – poll for scan progress */
router.get("/:caseId/forensic/status", requireAuth, requireCaseAccess("read"), (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const job = forensicJobs.get(caseId);
  if (!job) return res.json({ status: "none" });
  return res.json({
    status: job.status,
    progress: job.progress,
    progressText: job.progressText,
    result: job.status === "step1_done" ? job.result : (job.status === "done" ? job.result : null),
    error: job.status === "error" ? job.error : null
  });
});

/* GET /:caseId/forensic/stored – load persisted results from DB */
router.get("/:caseId/forensic/stored", requireAuth, requireCaseAccess("read"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  const stored = await loadForensicResult(caseId);
  if (!stored) return res.json({ status: "none" });
  const step1 = stored.step1_json || null;
  const step2 = stored.step2_json || null;
  const merged = step2 ? { ...step1, ...step2 } : step1;
  return res.json({ status: "ok", result: merged, updatedAt: stored.updated_at });
});

/* POST /:caseId/forensic/start – Schritt 1: Einzeldokument-Analyse */
router.post("/:caseId/forensic/start", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }
  const existing = forensicJobs.get(caseId);
  if (existing && existing.status === "running") {
    return res.json({ status: "running", message: "Scan laeuft bereits." });
  }
  forensicJobs.set(caseId, { status: "running", progress: 0, progressText: "Starte Schritt 1…", startedAt: Date.now(), result: null, error: null });
  res.json({ status: "started" });
  runForensicStep1(caseId).catch(err => {
    console.error(`[forensic-step1] Case ${caseId} error:`, err.message);
    const job = forensicJobs.get(caseId);
    if (job) { job.status = "error"; job.error = err.message; }
  });
});

/* POST /:caseId/forensic/crossdoc – Schritt 2: Kreuzanalyse */
router.post("/:caseId/forensic/crossdoc", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }
  const existing = forensicJobs.get(caseId);
  if (existing && existing.status === "running") {
    return res.json({ status: "running" });
  }
  forensicJobs.set(caseId, { status: "running", progress: 85, progressText: "Kreuzanalyse startet…", startedAt: Date.now(), result: null, error: null });
  res.json({ status: "started" });
  runForensicStep2(caseId).catch(err => {
    console.error(`[forensic-step2] Case ${caseId} error:`, err.message);
    const job = forensicJobs.get(caseId);
    if (job) { job.status = "error"; job.error = err.message; }
  });
});

async function runForensicStep1(caseId) {
  const job = forensicJobs.get(caseId);
  if (!job) return;

  const filesResult = await pool.query(
    "SELECT id, original_name, stored_name, mime_type FROM case_documents WHERE case_id = $1 ORDER BY uploaded_at ASC",
    [caseId]
  );
  const files = filesResult.rows;
  if (files.length === 0) {
    job.status = "done";
    job.result = { caseId, status: "empty", totalScore: 0, fileCount: 0, files: [], gesamtFazit: "Keine Dateien im Dossier." };
    return;
  }

  const fileResults = [];
  let totalScore = 0;
  let analyzedCount = 0;
  const allFindings = [];

  try {
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      job.progress = Math.round(((fi) / files.length) * 80);
      job.progressText = `File ${fi + 1}/${files.length}: ${file.original_name}`;

      // Try cached first
      let forensic = await loadStoredForensic(file.id);
      if (forensic && forensic.status === "ok") {
        fileResults.push({
          fileId: file.id,
          fileName: file.original_name,
          score: forensic.score,
          risikoStufe: forensic.risikoStufe,
          findingsCount: (forensic.findings || []).length,
          fazit: forensic.fazit
        });
        totalScore += forensic.score || 0;
        analyzedCount++;
        for (const f of (forensic.findings || [])) {
          allFindings.push({ ...f, fileName: file.original_name });
        }
        continue;
      }

      // Not cached — analyze only PDFs
      const mimeType = String(file.mime_type || "");
      if (!mimeType.includes("pdf")) {
        fileResults.push({
          fileId: file.id,
          fileName: file.original_name,
          score: 0,
          risikoStufe: "niedrig",
          findingsCount: 0,
          fazit: "Nur PDF-Analyse verfuegbar."
        });
        continue;
      }

      try {
        const fileBuffer = await downloadStorageFile(caseId, file.stored_name);
        const pdfParse = getPdfParse();
        const parsed = pdfParse ? await pdfParse(fileBuffer) : { text: "" };
        const parsedText = String(parsed?.text || "");
        const ocrText = shouldUsePdfOcrFallback(parsedText)
          ? await extractTextFromPdfWithOcr(fileBuffer)
          : "";
        const extractedText = pickBetterPdfText(parsedText, ocrText);

        let result;
        if (!extractedText || !extractedText.trim() || scoreExtractedTextQuality(extractedText) < 0.5) {
          // Vision fallback for handwritten/scanned PDFs
          console.log(`[forensic-all] Text quality too low for ${file.original_name}, trying Vision…`);
          let protectedName = "";
          let opposingName = "";
          try {
            const caseRow = await pool.query("SELECT protected_person, opposing_party FROM cases WHERE id = $1 LIMIT 1", [caseId]);
            if (caseRow.rows.length > 0) {
              protectedName = caseRow.rows[0].protected_person || "";
              opposingName = caseRow.rows[0].opposing_party || "";
            }
          } catch (_) { /* ignore */ }
          result = await analyzePdfWithVision(fileBuffer, file.original_name, protectedName, opposingName);
          if (!result && extractedText && extractedText.trim()) {
            result = await analyzeLegalDocument(extractedText, {
              documentTitle: file.original_name,
              documentType: "PDF"
            });
          }
          if (!result) {
            fileResults.push({
              fileId: file.id,
              fileName: file.original_name,
              score: 0,
              risikoStufe: "niedrig",
              findingsCount: 0,
              fazit: "Kein lesbarer Text."
            });
            continue;
          }
        } else {
          result = await analyzeLegalDocument(extractedText, {
            documentTitle: file.original_name,
            documentType: "PDF"
          });
        }

        // Merge personen into people
        if (Array.isArray(result.personen) && result.personen.length > 0 && !result.people) {
          result.people = result.personen.map((p) => ({
            name: p.name,
            affiliation: p.rolle || "Privatperson",
            ...(p.sentiment && { sentiment: p.sentiment }),
            ...(p.bemerkung && { bemerkung: p.bemerkung })
          }));
        }

        result.documentId = file.id;
        result.fileName = file.original_name;
        await saveForensicAnalysis(file.id, result);

        fileResults.push({
          fileId: file.id,
          fileName: file.original_name,
          score: result.score || 0,
          risikoStufe: result.risikoStufe || "niedrig",
          findingsCount: (result.findings || []).length,
          fazit: result.fazit
        });
        totalScore += result.score || 0;
        analyzedCount++;
        for (const f of (result.findings || [])) {
          allFindings.push({ ...f, fileName: file.original_name });
        }
      } catch (fileErr) {
        console.warn(`Forensic skip ${file.original_name}:`, fileErr.message);
        fileResults.push({
          fileId: file.id,
          fileName: file.original_name,
          score: 0,
          risikoStufe: "niedrig",
          findingsCount: 0,
          fazit: `Fehler: ${fileErr.message}`
        });
      }
    }

    // Sort findings by severity
    const severityOrder = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };
    allFindings.sort((a, b) => (severityOrder[a.schweregrad] || 3) - (severityOrder[b.schweregrad] || 3));

    const avgScore = analyzedCount > 0 ? Math.round(totalScore / analyzedCount) : 0;
    const kritischCount = allFindings.filter(f => f.schweregrad === "kritisch").length;
    const hochCount = allFindings.filter(f => f.schweregrad === "hoch").length;

    // ── Step 1 done: save intermediate result to DB ──
    let gesamtRisiko = "niedrig";
    if (avgScore >= 70 || kritischCount > 0) gesamtRisiko = "kritisch";
    else if (avgScore >= 50 || hochCount >= 3) gesamtRisiko = "hoch";
    else if (avgScore >= 25 || hochCount >= 1) gesamtRisiko = "mittel";

    const step1Result = {
      caseId,
      status: "step1_done",
      totalScore: avgScore,
      gesamtRisiko,
      fileCount: files.length,
      analyzedCount,
      findingsTotal: allFindings.length,
      topFindings: allFindings.slice(0, 15),
      files: fileResults,
      gesamtFazit: `Schritt 1 abgeschlossen: ${analyzedCount} von ${files.length} Files analysiert. Score: ${avgScore}/100. ${allFindings.length} Auffälligkeiten, davon ${kritischCount} kritisch und ${hochCount} schwerwiegend.`
    };

    await saveForensicStep(caseId, 1, step1Result);
    job.progress = 100;
    job.progressText = `Schritt 1 abgeschlossen – ${analyzedCount} Files analysiert`;
    job.status = "step1_done";
    job.result = step1Result;

  } catch (err) {
    console.error("Forensic step1 error:", err.message);
    const job = forensicJobs.get(caseId);
    if (job) { job.status = "error"; job.error = err.message; }
  }
}

/* ── Step 2: Cross-document analysis ── */
async function runForensicStep2(caseId) {
  const job = forensicJobs.get(caseId);
  if (!job) return;

  try {
    const filesResult = await pool.query(
      "SELECT id, original_name, stored_name, mime_type FROM case_documents WHERE case_id = $1 ORDER BY uploaded_at ASC",
      [caseId]
    );
    const files = filesResult.rows;

    job.progress = 88;
    job.progressText = "Kreuzanalyse über alle Files…";

    const crossDocs = [];
    for (const file of files) {
      const mimeType = String(file.mime_type || "");
      if (!mimeType.includes("pdf")) continue;
      try {
        const buf = await downloadStorageFile(caseId, file.stored_name);
        const pdfParse = getPdfParse();
        const parsed = pdfParse ? await pdfParse(buf) : { text: "" };
        const txt = pickBetterPdfText(
          String(parsed?.text || ""),
          shouldUsePdfOcrFallback(String(parsed?.text || ""))
            ? await extractTextFromPdfWithOcr(buf)
            : ""
        );
        if (txt && txt.trim()) {
          const storedForensic = await loadStoredForensic(file.id);
          crossDocs.push({
            fileName: file.original_name,
            text: txt,
            date: storedForensic?.authoredDate || "",
            forensic: storedForensic
          });
        }
      } catch (e) {
        console.warn(`Cross-doc skip ${file.original_name}:`, e.message);
      }
    }

    let crossDocResult = null;
    if (crossDocs.length >= 2) {
      job.progressText = `Kreuzanalyse: ${crossDocs.length} Files werden verglichen…`;
      crossDocResult = await analyzeDossierCrossDocument(crossDocs);
    }

    // Load step1 result from DB and merge
    const stored = await loadForensicResult(caseId);
    const step1 = stored?.step1_json || {};

    const avgScore = step1.totalScore || 0;
    const crossScore = crossDocResult?.crossDocScore || 0;
    const combinedScore = Math.round((avgScore + crossScore) / 2);
    const kritischCount = (step1.topFindings || []).filter(f => f.schweregrad === "kritisch").length;
    const hochCount = (step1.topFindings || []).filter(f => f.schweregrad === "hoch").length;

    let gesamtRisiko = "niedrig";
    if (combinedScore >= 70 || kritischCount > 0) gesamtRisiko = "kritisch";
    else if (combinedScore >= 50 || hochCount >= 3) gesamtRisiko = "hoch";
    else if (combinedScore >= 25 || hochCount >= 1) gesamtRisiko = "mittel";

    const finalResult = {
      ...step1,
      status: "ok",
      crossDocScore: crossScore,
      combinedScore,
      gesamtRisiko,
      crossDoc: crossDocResult || null,
      gesamtFazit: `${step1.analyzedCount || 0} von ${step1.fileCount || 0} Files forensisch analysiert. Score: ${avgScore}/100. Kreuzanalyse-Score: ${crossScore}/100 mit ${(crossDocResult?.widersprueche || []).length} Widersprüchen. ${step1.findingsTotal || 0} Auffälligkeiten, davon ${kritischCount} kritisch und ${hochCount} schwerwiegend.`
    };

    await saveForensicStep(caseId, 2, { crossDocScore: crossScore, combinedScore, gesamtRisiko, crossDoc: crossDocResult, gesamtFazit: finalResult.gesamtFazit });
    job.progress = 100;
    job.progressText = "Fall-Analyse abgeschlossen";
    job.status = "done";
    job.result = finalResult;

  } catch (err) {
    console.error("Forensic step2 error:", err.message);
    const job = forensicJobs.get(caseId);
    if (job) { job.status = "error"; job.error = err.message; }
  }
}

router.delete("/:caseId/files/:fileId", requireAuth, requireCaseAccess("write"), async (req, res) => {
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

// Invalidate all stored analyses for a case (triggers re-analysis on next load)
router.post("/:caseId/reanalyze", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM case_document_analysis
       WHERE document_id IN (SELECT id FROM case_documents WHERE case_id = $1)`,
      [caseId]
    );
    const deleted = result.rowCount || 0;
    console.log(`[reanalyze] Invalidated ${deleted} analyses for case ${caseId}`);
    return res.json({ ok: true, invalidated: deleted });
  } catch (err) {
    console.error("Reanalyze error:", err.message);
    return res.status(500).json({ error: "Analysen konnten nicht zurückgesetzt werden." });
  }
});

/* ================================================================
   CONSOLIDATE PERSONS – KI review all files, merge & deduplicate
   ================================================================ */
/* ═══ CONSOLIDATED PERSONS PERSISTENCE ═══ */
let consolidatedPersonsTableReady = null;
async function ensureConsolidatedPersonsTable() {
  if (!consolidatedPersonsTableReady) {
    consolidatedPersonsTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS case_consolidated_persons (
        case_id TEXT PRIMARY KEY,
        persons_json JSONB NOT NULL,
        raw_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(e => { consolidatedPersonsTableReady = null; throw e; });
  }
  await consolidatedPersonsTableReady;
}

async function saveConsolidatedPersons(caseId, persons, rawCount) {
  await ensureConsolidatedPersonsTable();
  await pool.query(
    `INSERT INTO case_consolidated_persons (case_id, persons_json, raw_count, updated_at)
     VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (case_id)
     DO UPDATE SET persons_json = EXCLUDED.persons_json, raw_count = EXCLUDED.raw_count, updated_at = CURRENT_TIMESTAMP`,
    [caseId, JSON.stringify(persons), rawCount]
  );
}

async function loadConsolidatedPersons(caseId) {
  try {
    await ensureConsolidatedPersonsTable();
    const r = await pool.query(
      "SELECT persons_json, raw_count, updated_at FROM case_consolidated_persons WHERE case_id = $1",
      [caseId]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

/* GET /:caseId/consolidated-persons – load persisted consolidated persons */
router.get("/:caseId/consolidated-persons", requireAuth, requireCaseAccess("read"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }
  try {
    const stored = await loadConsolidatedPersons(caseId);
    if (!stored) {
      return res.json({ ok: true, persons: null });
    }
    return res.json({
      ok: true,
      persons: stored.persons_json,
      rawCount: stored.raw_count,
      consolidatedCount: Array.isArray(stored.persons_json) ? stored.persons_json.length : 0,
      updatedAt: stored.updated_at
    });
  } catch (err) {
    console.error("[consolidated-persons GET] Error:", err.message);
    return res.status(500).json({ error: "Konsolidierte Personen konnten nicht geladen werden." });
  }
});

router.post("/:caseId/consolidate-persons", requireAuth, requireCaseAccess("write"), async (req, res) => {
  const caseId = String(req.params.caseId || "").trim();
  if (!/^\d{6}$/.test(caseId)) {
    return res.status(400).json({ error: "Ungueltige Fall-ID." });
  }

  try {
    // 1. Load all stored analyses for this case
    const docsResult = await pool.query(
      "SELECT id, original_name FROM case_documents WHERE case_id = $1 ORDER BY uploaded_at ASC",
      [caseId]
    );
    const docs = docsResult.rows;
    if (docs.length === 0) {
      return res.status(400).json({ error: "Keine Dokumente im Fall." });
    }

    // 2. Collect all persons from all analyses
    const allPersons = [];
    for (let i = 0; i < docs.length; i++) {
      const stored = await loadStoredDocumentAnalysis(docs[i].id);
      if (!stored || !Array.isArray(stored.people)) continue;
      for (const p of stored.people) {
        allPersons.push({
          name: typeof p === "string" ? p : (p.name || ""),
          affiliation: p.affiliation || "",
          bemerkung: p.bemerkung || "",
          sourceFileIndex: i + 1
        });
      }
    }

    if (allPersons.length === 0) {
      return res.status(400).json({ error: "Keine Personendaten in den Analysen gefunden." });
    }

    // 3. Get case party names for context (try main table, then fallback)
    let caseData = {};
    try {
      const r1 = await pool.query("SELECT protected_person_name, opposing_party FROM cases WHERE id = $1 LIMIT 1", [caseId]);
      if (r1.rows[0]) {
        caseData = { protected_person: r1.rows[0].protected_person_name, opposing_party: r1.rows[0].opposing_party };
      }
    } catch { /* column may not exist */ }
    if (!caseData.protected_person) {
      try {
        const r2 = await pool.query("SELECT protected_person_name, opposing_party FROM case_party_fallback WHERE case_id = $1 LIMIT 1", [caseId]);
        if (r2.rows[0]) {
          caseData = { protected_person: r2.rows[0].protected_person_name, opposing_party: r2.rows[0].opposing_party };
        }
      } catch { /* table may not exist */ }
    }

    // 4. Call Claude to consolidate
    console.log(`[consolidate-persons] Case ${caseId}: ${allPersons.length} raw persons from ${docs.length} docs`);
    const result = await consolidatePersons(
      allPersons,
      caseData.protected_person || "unbekannt",
      caseData.opposing_party || "unbekannt"
    );

    if (result.status !== "ok") {
      return res.status(500).json({ error: result.error || "Konsolidierung fehlgeschlagen." });
    }

    console.log(`[consolidate-persons] Case ${caseId}: ${allPersons.length} → ${result.persons.length} consolidated`);

    // 5. Persist consolidated persons to DB
    await saveConsolidatedPersons(caseId, result.persons, allPersons.length);
    console.log(`[consolidate-persons] Case ${caseId}: saved to DB`);

    return res.json({
      ok: true,
      persons: result.persons,
      rawCount: allPersons.length,
      consolidatedCount: result.persons.length
    });
  } catch (err) {
    console.error("[consolidate-persons] Error:", err.message);
    return res.status(500).json({ error: "Personen-Konsolidierung fehlgeschlagen." });
  }
});

module.exports = router;
