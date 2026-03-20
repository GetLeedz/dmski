const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
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
      const buffer = await fs.promises.readFile(absolutePath);
      const parsed = await pdfParse(buffer);
      const metaTitle = String(parsed?.info?.Title || "").trim();
      const fromText = extractTitleFromText(parsed?.text || "");
      const title = metaTitle && !/^untitled$/i.test(metaTitle) ? metaTitle : fromText;

      if (title) {
        return res.json({ status: "ok", title });
      }

      return res.json({
        status: "empty",
        title: "",
        message: "Kein klarer Titel im PDF erkannt."
      });
    }

    return res.json({
      status: "needs-ocr",
      title: "",
      message: "Bildtitel benötigt OCR oder KI-Analyse."
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
