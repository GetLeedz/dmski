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

  return parts.every((part) => /^(?:\p{Lu}[\p{Ll}\p{M}'-]+|\p{Lu}[\p{Ll}\p{M}'-]*\.)$/u.test(part));
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

    if (!looksLikePersonName(normalized)) {
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

  return list.slice(0, 12);
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

  return normalizePeopleWithBlacklist(people, blockedNames);
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

  if (domain) {
    if (domain.includes("kesb")) {
      return "KESB";
    }

    const stem = domain.split(".")[0] || "";
    if (stem) {
      return stem.toUpperCase();
    }
  }

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const authorKey = normalizeWhitespace(author).toLowerCase();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if (
      /\b(kesb|gericht|amt|behörde|behoerde|schule|sozialdienst|gmbh|\bag\b|versicherung|bank|verwaltung)\b/i.test(line)
      && !looksLikePersonName(line)
      && !/\d/.test(line)
      && lower !== authorKey
    ) {
      return line;
    }
  }

  return "";
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
    ...extractPeopleFromText(rawText, blockedPeople)
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

function buildFallbackAnalysis({ title = "", author = "", authoredDate = "", people = [], disadvantagedPerson = "", senderInstitution = "", impactAssessment = "", impactRanking = [], rawText = "", message = "" }) {
  const normalizedAuthor = normalizeWhitespace(author);
  const normalizedTitle = normalizeWhitespace(title);

  const correctedAuthor = (!normalizedAuthor && looksLikePersonName(normalizedTitle))
    ? normalizedTitle
    : normalizedAuthor;

  const correctedTitle = (looksLikePersonName(normalizedTitle) && correctedAuthor)
    ? ""
    : normalizedTitle;

  const normalizedPeople = normalizePeopleDetailed(Array.isArray(people) ? people : [], rawText, new Set(), correctedAuthor);
  const explicitDisadvantaged = normalizeWhitespace(disadvantagedPerson);
  const computedDisadvantaged = explicitDisadvantaged || extractDisadvantagedPerson(rawText, normalizedPeople, correctedAuthor);
  const normalizedDisadvantaged = computedDisadvantaged.toLowerCase() === correctedAuthor.toLowerCase()
    ? ""
    : computedDisadvantaged;
  const normalizedSenderInstitution = normalizeWhitespace(senderInstitution) || extractSenderInstitution(rawText, correctedAuthor);
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
    authoredDate: normalizeDateSwiss(authoredDate),
    people: normalizedPeople,
    disadvantagedPerson: normalizedDisadvantaged,
    senderInstitution: normalizedSenderInstitution,
    impactAssessment: normalizedImpactAssessment,
    impactRanking: normalizedImpactRanking,
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
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: [
            "Du bist ein forensischer Dokumentanalyst. Untersuche den Text auf sprachliche Benachteiligung, Diskriminierung und ungleiche Behandlung von Personen.",
            "Antworte ausschliesslich als JSON-Objekt mit genau diesen Feldern:",
            '{"title":"","author":"","authoredDate":"","people":[{"name":"","affiliation":""}],"disadvantagedPerson":"","senderInstitution":"","impactAssessment":"","impactRanking":[{"name":"","impact":"","count":0,"items":[""]}],"message":""}',
            "Regeln:",
            "- title = kurzer Dokumenttitel aus dem Inhalt, nicht der Dateiname und nicht nur ein Personenname.",
            "- author = Verfasser/Absender, bevorzugt aus Unterschrift am Ende oder Briefkopf am Anfang.",
            "- authoredDate = Datum der Verfassung im Schweizer Format DD.MM.YYYY.",
            "- people = alle relevanten Personennamen OHNE Verfasser, als Array von Objekten {name, affiliation}.",
            "- people MUSS Empfänger aus 'An:' und Namen aus der Anrede enthalten (z. B. Sehr geehrte Frau X / Herr Y).",
            "- affiliation erlaubt nur: Gericht, Firma, Behörde, Privatperson, Schule.",
            "- people darf KEINE Strassen, Orte, Satzfragmente oder Floskeln enthalten.",
            "- disadvantagedPerson = Name der am stärksten benachteiligten Person, falls erkennbar.",
            "- senderInstitution = aus welchem Haus/Institution das Schreiben stammt (z. B. KESB Leimental).",
            "- impactAssessment = entweder 'Neutral' oder 'Person benachteiligt'.",
            "- impactRanking = sortierte Liste aller Personen {name, impact, count, items}; benachteiligte Personen zuerst.",
            "- count = Anzahl konkreter Textstellen, die diese Person benachteiligen oder diskriminieren; 0 wenn neutral.",
            "- items = Array kurzer Textzitate (max. 75 Zeichen je Eintrag) als direkte Belege für die Benachteiligung; [] wenn neutral.",
            "- Achte auch auf subtile Diskriminierung: unterschiedliche Wertungen (z.B. 'unterschiedlich gute Zusammenarbeit'), abwertende Adjektive, ungleiche Behandlung oder selektive Formulierungen.",
            "- message = kurzer Hinweis, falls etwas unklar ist.",
            "- Wenn etwas fehlt, leeres Feld verwenden.",
            "Dokumenttext:",
            textSnippet
          ].join("\n")
        }
      ]
    });

    const responseText = response?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(responseText);
    if (!parsed || typeof parsed !== "object") {
      return buildFallbackAnalysis(fallback);
    }

    return buildFallbackAnalysis({
      title: parsed.title || fallback.title,
      author: parsed.author || fallback.author,
      authoredDate: parsed.authoredDate || fallback.authoredDate,
      people: Array.isArray(parsed.people) && parsed.people.length > 0 ? parsed.people : fallback.people,
      disadvantagedPerson: parsed.disadvantagedPerson || fallback.disadvantagedPerson,
      senderInstitution: parsed.senderInstitution || fallback.senderInstitution,
      impactAssessment: parsed.impactAssessment || fallback.impactAssessment,
      impactRanking: Array.isArray(parsed.impactRanking) && parsed.impactRanking.length > 0 ? parsed.impactRanking : fallback.impactRanking,
      rawText: textSnippet,
      message: parsed.message || fallback.message
    });
  } catch (error) {
    console.error("Analyze text error:", error.message);
    return buildFallbackAnalysis(fallback);
  }
}

async function extractTitleFromImageWithAi(fileBuffer, mimeType) {
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

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Du bist ein forensischer Dokumentanalyst. Untersuche das Dokumentbild auf sprachliche Benachteiligung, Diskriminierung und ungleiche Behandlung von Personen.",
                "Antworte ausschliesslich als JSON-Objekt mit genau diesen Feldern:",
                '{"title":"","author":"","authoredDate":"","people":[{"name":"","affiliation":""}],"disadvantagedPerson":"","senderInstitution":"","impactAssessment":"","impactRanking":[{"name":"","impact":"","count":0,"items":[""]}],"message":""}',
                "Regeln:",
                "- title = kurzer sichtbarer Dokumenttitel, kein reiner Personenname.",
                "- author = sichtbarer Verfasser/Absender aus Briefkopf oder Unterschrift.",
                "- authoredDate = sichtbares Verfassungsdatum im Schweizer Format DD.MM.YYYY.",
                "- people = alle erkennbaren Personennamen OHNE Verfasser als Objekte {name, affiliation}.",
                "- people MUSS Empfänger aus 'An:' und Namen aus der Anrede enthalten, wenn sichtbar.",
                "- affiliation erlaubt nur: Gericht, Firma, Behörde, Privatperson, Schule.",
                "- people darf KEINE Strassen, Orte oder Satzfragmente enthalten.",
                "- disadvantagedPerson = Name der am stärksten benachteiligten Person, falls erkennbar.",
                "- senderInstitution = aus welchem Haus/Institution das Schreiben stammt.",
                "- impactAssessment = entweder 'Neutral' oder 'Person benachteiligt'.",
                "- impactRanking = sortierte Liste aller Personen {name, impact, count, items}; benachteiligte Personen zuerst.",
                "- count = Anzahl konkreter Textstellen, die diese Person benachteiligen; 0 wenn neutral.",
                "- items = Array kurzer Textzitate (max. 75 Zeichen je Eintrag) als Belege für die Benachteiligung; [] wenn neutral.",
                "- Achte auch auf subtile Diskriminierung: unterschiedliche Wertungen, abwertende Adjektive, ungleiche Behandlung.",
                "- message = kurzer Hinweis, wenn etwas nicht sicher lesbar ist.",
                "- Wenn nichts erkennbar ist, Felder leer lassen."
              ].join("\n")
            },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType || "image/png"};base64,${base64}` }
            }
          ]
        }
      ]
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

    const normalized = buildFallbackAnalysis({
      title: parsed.title,
      author: parsed.author,
      authoredDate: parsed.authoredDate,
      people: parsed.people,
      disadvantagedPerson: parsed.disadvantagedPerson,
      senderInstitution: parsed.senderInstitution,
      impactAssessment: parsed.impactAssessment,
      impactRanking: parsed.impactRanking,
      rawText: "",
      message: parsed.message
    });

    if (!normalized.title && !normalized.author && !normalized.authoredDate && normalized.people.length === 0) {
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

async function analyzeImageWithFallback(fileBuffer, mimeType, originalName = "") {
  const fileNameTitle = deriveTitleFromFileName(originalName);

  try {
    const imageResult = await extractTitleFromImageWithAi(fileBuffer, mimeType);
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
      const aiFromText = await analyzeTextWithAi(ocrText, fallback);
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

    if (String(file.mime_type || "").includes("pdf")) {
      try {
        const pdfParse = getPdfParse();
        if (!pdfParse) {
          return res.json({
            status: "empty",
            title: "",
            author: "",
            authoredDate: "",
            people: [],
            disadvantagedPerson: "",
            message: "PDF-Parser ist aktuell nicht verfuegbar."
          });
        }
        const parsed = await pdfParse(fileBuffer);
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
          disadvantagedPerson: "",
          message: "PDF-Inhalt konnte nicht gelesen werden (m├Âglicherweise Scan oder defekter Textlayer)."
        });
      }
    }

    if (String(file.mime_type || "").startsWith("image/")) {
      const imageResult = await analyzeImageWithFallback(fileBuffer, file.mime_type, file.original_name);
      return res.json(imageResult);
    }

    return res.json({
      status: "empty",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      disadvantagedPerson: "",
      message: "Analyse f├╝r diesen Dateityp nicht verf├╝gbar."
    });
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
