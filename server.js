import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import Airtable from "airtable";
import twilio from "twilio";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import { google } from "googleapis";  

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 4000;

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function getDriveClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function normalizeRecord(record) {
  return { id: record.id, ...record.fields };
}

function table(name) {
  return airtable(name);
}

async function createAirtableRecord(tableName, fields) {
  const records = await table(tableName).create([{ fields }]);
  return normalizeRecord(records[0]);
}

async function listAirtableRecords(tableName, filterByFormula = "") {
  const records = await table(tableName)
    .select({ filterByFormula, maxRecords: 100 })
    .all();

  return records.map(normalizeRecord);
}

function statusFromDueDate(dueDate) {
  if (!dueDate) return "Sin fecha";
  const today = new Date();
  const due = new Date(dueDate);
  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return "Vencido";
  if (diffDays <= 7) return "Urgente";
  if (diffDays <= 15) return "Próximo";
  return "Vigente";
}

function buildWhatsAppMessage({ station, title, due, status, owner }) {
  const emoji = status === "Vencido" ? "❌" : status === "Urgente" ? "⚠️" : "🔔";
  return `${emoji} SASISOPA — ${station}\n\n${title}\nEstatus: ${status}\nVence: ${due}\nResponsable: ${owner}\n\nFavor de cargar evidencia o actualizar seguimiento.`;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "SASISOPA IA Backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/stations", async (req, res) => {
  try {
    const records = await listAirtableRecords(process.env.AIRTABLE_TABLE_ESTACIONES);
    res.json({ ok: true, data: records });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/stations", async (req, res) => {
  try {
    const station = await createAirtableRecord(process.env.AIRTABLE_TABLE_ESTACIONES, req.body);
    res.json({ ok: true, data: station });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/obligations", async (req, res) => {
  try {
    const { station } = req.query;
    const formula = station ? `{EstacionCodigo} = '${station}'` : "";
    const records = await listAirtableRecords(process.env.AIRTABLE_TABLE_OBLIGACIONES, formula);
    const enriched = records.map((r) => ({
      ...r,
      EstadoCalculado: statusFromDueDate(r.FechaProxima || r["Fecha próxima"] || r["Fecha proxima"]),
    }));
    res.json({ ok: true, data: enriched });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/obligations", async (req, res) => {
  try {
    const obligation = await createAirtableRecord(process.env.AIRTABLE_TABLE_OBLIGACIONES, req.body);
    res.json({ ok: true, data: obligation });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/obligations/check-due", async (req, res) => {
  try {
    const records = await listAirtableRecords(process.env.AIRTABLE_TABLE_OBLIGACIONES);
    const dueItems = records
      .map((r) => {
        const due = r.FechaProxima || r["Fecha próxima"] || r["Fecha proxima"];
        const status = statusFromDueDate(due);
        return { ...r, due, status };
      })
      .filter((r) => ["Vencido", "Urgente", "Próximo"].includes(r.status));

    if (process.env.N8N_WEBHOOK_VENCIMIENTOS) {
      await axios.post(process.env.N8N_WEBHOOK_VENCIMIENTOS, { dueItems });
    }

    res.json({ ok: true, count: dueItems.length, data: dueItems });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/whatsapp/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ ok: false, error: "Falta to o message" });

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });

    res.json({ ok: true, sid: result.sid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/whatsapp/send-due-alert", async (req, res) => {
  try {
    const { to, station, title, due, status, owner } = req.body;
    const message = buildWhatsAppMessage({ station, title, due, status, owner });

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });

    res.json({ ok: true, sid: result.sid, message });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/upload-evidence", upload.single("file"), async (req, res) => {
  try {
    const fileMetadata = {
      name: req.file.originalname,
      parents: [process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID],
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id",
    });

    const fileId = driveResponse.data.id;

    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;

    await airtableBase(process.env.AIRTABLE_TABLE_EVIDENCIAS).create([
      {
        fields: {
          Nombre: req.file.originalname,
          URL: fileUrl,
          Estacion: req.body.estacion,
          Obligacion: req.body.obligacion,
          Comentarios: req.body.comentarios || "",
          Fecha: new Date().toISOString(),
        },
      },
    ]);

    fs.unlinkSync(req.file.path);

    res.json({
      ok: true,
      url: fileUrl,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/upload-evidence", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No se recibió archivo",
      });
    }

    const { estacion, obligacion, comentarios } = req.body;

    const fileName = `${estacion || "SIN_ESTACION"}-${Date.now()}-${req.file.originalname}`;

    const driveResponse = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: Readable.from(req.file.buffer),
      },
      fields: "id, webViewLink",
    });

    const fileId = driveResponse.data.id;
    const fileUrl = driveResponse.data.webViewLink;

    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    await table(process.env.AIRTABLE_TABLE_EVIDENCIAS).create([
      {
        fields: {
          EstacionCodigo: estacion || "",
          Modulo: "EVIDENCIA",
          ObligacionId: obligacion || "",
          Tipo: req.file.mimetype,
          UsuarioCarga: "Usuario plataforma",
          FechaCarga: new Date().toISOString().slice(0, 10),
          DriveFileId: fileId,
          DriveUrl: fileUrl,
          NombreArchivo: fileName,
          Validado: false,
        },
      },
    ]);

    res.json({
      ok: true,
      url: fileUrl,
    });
  } catch (error) {
    console.error("ERROR UPLOAD:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/ai/classify-evidence", async (req, res) => {
  try {
    const { text, fileName } = req.body;

    const prompt = `
Eres un asistente experto en SASISOPA para estaciones de servicio.
Clasifica el siguiente documento/evidencia.

Devuelve únicamente JSON válido con esta estructura:
{
  "tipo_documento": "",
  "modulo_sasisopa": "",
  "estacion_probable": "",
  "fecha_documento": "",
  "vigencia_detectada": "",
  "obligacion_relacionada": "",
  "riesgo": "Bajo|Medio|Alto",
  "observaciones": ""
}

Nombre archivo: ${fileName || "No disponible"}
Texto extraído:
${text || "No disponible"}
`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    res.json({ ok: true, data: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/ai/generate-ied", async (req, res) => {
  try {
    const { stationCode, period, kpis, findings, incidents, obligations, evidenceSummary } = req.body;

    const prompt = `
Genera un borrador profesional del Informe de Evaluación del Desempeño SASISOPA para una estación de servicio.
Debe estar redactado en español formal, con estructura ejecutiva y enfoque regulatorio.

Datos:
Estación: ${stationCode}
Periodo: ${period}
KPIs: ${JSON.stringify(kpis || [], null, 2)}
Hallazgos: ${JSON.stringify(findings || [], null, 2)}
Incidentes: ${JSON.stringify(incidents || [], null, 2)}
Obligaciones: ${JSON.stringify(obligations || [], null, 2)}
Evidencias: ${JSON.stringify(evidenceSummary || [], null, 2)}

Estructura requerida:
1. Portada
2. Resumen ejecutivo
3. Alcance
4. Cumplimiento documental
5. Cumplimiento operativo
6. Capacitación
7. Mantenimiento e integridad mecánica
8. Auditorías y hallazgos
9. Incidentes y acciones correctivas
10. KPIs
11. Conclusiones
12. Plan de acción
`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    res.json({ ok: true, data: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/audits/create", async (req, res) => {
  try {
    const audit = await createAirtableRecord(process.env.AIRTABLE_TABLE_AUDITORIAS, req.body);

    if (process.env.N8N_WEBHOOK_AUDITORIAS) {
      await axios.post(process.env.N8N_WEBHOOK_AUDITORIAS, { audit });
    }

    res.json({ ok: true, data: audit });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/findings/create", async (req, res) => {
  try {
    const finding = await createAirtableRecord(process.env.AIRTABLE_TABLE_HALLAZGOS, req.body);
    res.json({ ok: true, data: finding });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/findings", async (req, res) => {
  try {
    const records = await listAirtableRecords(process.env.AIRTABLE_TABLE_HALLAZGOS);
    res.json({ ok: true, data: records });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/kpis/summary", async (req, res) => {
  try {
    const obligations = await listAirtableRecords(process.env.AIRTABLE_TABLE_OBLIGACIONES);
    const findings = await listAirtableRecords(process.env.AIRTABLE_TABLE_HALLAZGOS);
    const evidence = await listAirtableRecords(process.env.AIRTABLE_TABLE_EVIDENCIAS);

    const totalObligations = obligations.length;
    const overdue = obligations.filter((o) => {
      const due = o.FechaProxima || o["Fecha próxima"] || o["Fecha proxima"];
      return statusFromDueDate(due) === "Vencido";
    }).length;

    const openFindings = findings.filter((f) => ["Abierto", "En corrección"].includes(f.Estatus)).length;
    const validatedEvidence = evidence.filter((e) => e.Validado === true).length;

    res.json({
      ok: true,
      data: {
        totalObligations,
        overdue,
        complianceRate: totalObligations ? Math.round(((totalObligations - overdue) / totalObligations) * 100) : 0,
        totalFindings: findings.length,
        openFindings,
        totalEvidence: evidence.length,
        validatedEvidence,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SASISOPA IA Backend activo en http://localhost:${PORT}`);
});
