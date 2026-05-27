import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import Airtable from "airtable";
import twilio from "twilio";
import OpenAI from "openai";
import multer from "multer";
import { google } from "googleapis";
import { Readable } from "stream";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 4000;

const upload = multer({
  storage: multer.memoryStorage(),
});

// =========================
// CLIENTES EXTERNOS
// =========================

const airtableBase = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY,
}).base(process.env.AIRTABLE_BASE_ID);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "temporal",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID || "AC00000000000000000000000000000000",
  process.env.TWILIO_AUTH_TOKEN || "00000000000000000000000000000000"
);

function getDriveClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({
    version: "v3",
    auth,
  });
}

// =========================
// HELPERS
// =========================

function normalizeRecord(record) {
  return {
    id: record.id,
    ...record.fields,
  };
}

function table(name) {
  return airtableBase(name);
}

async function createAirtableRecord(tableName, fields) {
  const records = await table(tableName).create([
    {
      fields,
    },
  ]);

  return normalizeRecord(records[0]);
}

async function listAirtableRecords(tableName, filterByFormula = "") {
  const records = await table(tableName)
    .select({
      filterByFormula,
      maxRecords: 100,
    })
    .all();

  return records.map(normalizeRecord);
}

function statusFromDueDate(dueDate) {
  if (!dueDate) return "Sin fecha";

  const today = new Date();
  const due = new Date(dueDate);

  const diffDays = Math.ceil(
    (due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays < 0) return "Vencido";
  if (diffDays <= 7) return "Urgente";
  if (diffDays <= 15) return "Próximo";

  return "Vigente";
}

function buildWhatsAppMessage({ station, title, due, status, owner }) {
  const emoji =
    status === "Vencido" ? "❌" : status === "Urgente" ? "⚠️" : "🔔";

  return `${emoji} SASISOPA — ${station}

${title}
Estatus: ${status}
Vence: ${due}
Responsable: ${owner}

Favor de cargar evidencia o actualizar seguimiento.`;
}

// =========================
// HEALTH CHECK
// =========================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "SASISOPA IA Backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// =========================
// ESTACIONES
// =========================

app.get("/api/stations", async (req, res) => {
  try {
    const records = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_ESTACIONES
    );

    res.json({
      ok: true,
      data: records,
    });
  } catch (error) {
    console.error("ERROR STATIONS:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/stations", async (req, res) => {
  try {
    const station = await createAirtableRecord(
      process.env.AIRTABLE_TABLE_ESTACIONES,
      req.body
    );

    res.json({
      ok: true,
      data: station,
    });
  } catch (error) {
    console.error("ERROR CREATE STATION:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// OBLIGACIONES
// =========================

app.get("/api/obligations", async (req, res) => {
  try {
    const obligaciones = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_OBLIGACIONES
    );

    const evidencias = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_EVIDENCIAS
    );

    const evidenciasMap = {};

    evidencias.forEach((ev) => {
      const key = `${ev.EstacionCodigo}-${ev.ObligacionId}`;

      evidenciasMap[key] = {
        tiene: true,
        url: ev.URL || ev.ArchivoURL || "",
      };
    });

    const data = obligaciones.map((o) => {
      const due =
        o.FechaProxima || o["Fecha próxima"] || o["Fecha proxima"] || "";

      const key = `${o.EstacionCodigo}-${o.Nombre}`;
      const evidencia = evidenciasMap[key];

      return {
        ...o,
        EstadoCalculado: statusFromDueDate(due),
        TieneEvidencia: evidencia?.tiene || false,
        EvidenciaURL: evidencia?.url || "",
      };
    });

    res.json({
      ok: true,
      data,
    });
  } catch (error) {
    console.error("ERROR OBLIGATIONS:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/obligations", async (req, res) => {
  try {
    const obligation = await createAirtableRecord(
      process.env.AIRTABLE_TABLE_OBLIGACIONES,
      req.body
    );

    res.json({
      ok: true,
      data: obligation,
    });
  } catch (error) {
    console.error("ERROR CREATE OBLIGATION:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/obligations/check-due", async (req, res) => {
  try {
    const records = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_OBLIGACIONES
    );

    const dueItems = records
      .map((r) => {
        const due =
          r.FechaProxima || r["Fecha próxima"] || r["Fecha proxima"] || "";

        const status = statusFromDueDate(due);

        return {
          ...r,
          due,
          status,
        };
      })
      .filter((r) => ["Vencido", "Urgente", "Próximo"].includes(r.status));

    if (process.env.N8N_WEBHOOK_VENCIMIENTOS) {
      await axios.post(process.env.N8N_WEBHOOK_VENCIMIENTOS, {
        dueItems,
      });
    }

    res.json({
      ok: true,
      count: dueItems.length,
      data: dueItems,
    });
  } catch (error) {
    console.error("ERROR CHECK DUE:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// WHATSAPP
// =========================

app.post("/api/whatsapp/send", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        ok: false,
        error: "Falta to o message",
      });
    }

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });

    res.json({
      ok: true,
      sid: result.sid,
    });
  } catch (error) {
    console.error("ERROR WHATSAPP:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/whatsapp/send-due-alert", async (req, res) => {
  try {
    const { to, station, title, due, status, owner } = req.body;

    const message = buildWhatsAppMessage({
      station,
      title,
      due,
      status,
      owner,
    });

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });

    res.json({
      ok: true,
      sid: result.sid,
      message,
    });
  } catch (error) {
    console.error("ERROR WHATSAPP ALERT:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// EVIDENCIAS - UPLOAD A DRIVE + AIRTABLE
// =========================

app.post("/api/upload-evidence", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No se recibió archivo",
      });
    }

    const { estacion, obligacion, comentarios } = req.body;

    if (!estacion) {
      return res.status(400).json({
        ok: false,
        error: "Falta seleccionar estación",
      });
    }

    if (!obligacion) {
      return res.status(400).json({
        ok: false,
        error: "Falta seleccionar obligación",
      });
    }

    const date = new Date().toISOString().slice(0, 10);

    const cleanOriginalName = req.file.originalname
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/_+/g, "_");

    const fileName = `${estacion}-EVID-${date}-${Date.now()}-${cleanOriginalName}`;

    const safeStation = estacion
    .replace(/[^a-zA-Z0-9-_]/g, "_");

    const filePath = `${safeStation}/${Date.now()}-${cleanOriginalName}`;

    console.log({
      bucket: process.env.SUPABASE_BUCKET,
      filePath,
    });

    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data: publicData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(filePath);

    const fileUrl = publicData.publicUrl;

    const evidenceRecord = await createAirtableRecord(
      process.env.AIRTABLE_TABLE_EVIDENCIAS,
      {
        EstacionCodigo: estacion,
        Modulo: "EVIDENCIA",
        ObligacionId: obligacion,
        Tipo: req.file.mimetype,
        UsuarioCarga: "Usuario plataforma",
        FechaCarga: date,
        URL: fileUrl,
        Nombre: fileName,
        NombreArchivo: fileName,
        Validado: false,
      }
    );

    res.json({
      ok: true,
      message: "Evidencia subida correctamente",
      url: fileUrl,
      evidence: evidenceRecord,
      comentarios: comentarios || "",
    });
  } catch (error) {
    console.error("ERROR UPLOAD:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// EVIDENCIAS - LISTAR
// =========================

app.get("/api/evidence", async (req, res) => {
  try {
    const records = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_EVIDENCIAS
    );

    res.json({
      ok: true,
      data: records,
    });
  } catch (error) {
    console.error("ERROR EVIDENCE:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// IA
// =========================

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
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
    });

    res.json({
      ok: true,
      data: completion.choices[0].message.content,
    });
  } catch (error) {
    console.error("ERROR AI CLASSIFY:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/ai/generate-ied", async (req, res) => {
  try {
    const {
      stationCode,
      period,
      kpis,
      findings,
      incidents,
      obligations,
      evidenceSummary,
    } = req.body;

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
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
    });

    res.json({
      ok: true,
      data: completion.choices[0].message.content,
    });
  } catch (error) {
    console.error("ERROR AI IED:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// AUDITORÍAS
// =========================

app.post("/api/audits/create", async (req, res) => {
  try {
    const audit = await createAirtableRecord(
      process.env.AIRTABLE_TABLE_AUDITORIAS,
      req.body
    );

    if (process.env.N8N_WEBHOOK_AUDITORIAS) {
      await axios.post(process.env.N8N_WEBHOOK_AUDITORIAS, {
        audit,
      });
    }

    res.json({
      ok: true,
      data: audit,
    });
  } catch (error) {
    console.error("ERROR CREATE AUDIT:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// HALLAZGOS
// =========================

app.post("/api/findings/create", async (req, res) => {
  try {
    const finding = await createAirtableRecord(
      process.env.AIRTABLE_TABLE_HALLAZGOS,
      req.body
    );

    res.json({
      ok: true,
      data: finding,
    });
  } catch (error) {
    console.error("ERROR CREATE FINDING:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/findings", async (req, res) => {
  try {
    const records = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_HALLAZGOS
    );

    res.json({
      ok: true,
      data: records,
    });
  } catch (error) {
    console.error("ERROR FINDINGS:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// KPIs
// =========================

app.get("/api/kpis/summary", async (req, res) => {
  try {
    const obligations = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_OBLIGACIONES
    );

    const findings = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_HALLAZGOS
    );

    const evidence = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_EVIDENCIAS
    );

    const totalObligations = obligations.length;

    const overdue = obligations.filter((o) => {
      const due =
        o.FechaProxima || o["Fecha próxima"] || o["Fecha proxima"] || "";

      return statusFromDueDate(due) === "Vencido";
    }).length;

    const openFindings = findings.filter((f) =>
      ["Abierto", "En corrección"].includes(f.Estatus)
    ).length;

    const validatedEvidence = evidence.filter(
      (e) => e.Validado === true
    ).length;

    res.json({
      ok: true,
      data: {
        totalObligations,
        overdue,
        complianceRate: totalObligations
          ? Math.round(((totalObligations - overdue) / totalObligations) * 100)
          : 0,
        totalFindings: findings.length,
        openFindings,
        totalEvidence: evidence.length,
        validatedEvidence,
      },
    });
  } catch (error) {
    console.error("ERROR KPIS:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function addFrequency(date, frecuencia) {
  const d = new Date(date);

  if (frecuencia === "Diario") d.setDate(d.getDate() + 1);
  if (frecuencia === "Semanal") d.setDate(d.getDate() + 7);
  if (frecuencia === "Mensual") d.setMonth(d.getMonth() + 1);
  if (frecuencia === "Bimestral") d.setMonth(d.getMonth() + 2);
  if (frecuencia === "Trimestral") d.setMonth(d.getMonth() + 3);
  if (frecuencia === "Semestral") d.setMonth(d.getMonth() + 6);
  if (frecuencia === "Anual") d.setFullYear(d.getFullYear() + 1);

  return d.toISOString().slice(0, 10);
}

app.post("/api/programaciones/generar", async (req, res) => {
  try {
    const { estacionCodigo, fechaInicio } = req.body;

    if (!estacionCodigo) {
      return res.status(400).json({
        ok: false,
        error: "Falta estacionCodigo",
      });
    }

    const inicio = fechaInicio || new Date().toISOString().slice(0, 10);

    const maestras = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_OBLIGACIONES_MAESTRO
    );

    const activas = maestras.filter((m) => m.Activa === true);

    const creadas = [];

    for (const m of activas) {
      const fechaVencimiento = addFrequency(inicio, m.Frecuencia);

      const record = await createAirtableRecord(
        process.env.AIRTABLE_TABLE_PROGRAMACIONES,
        {
          EstacionCodigo: estacionCodigo,
          Obligacion: m.Nombre,
          Categoria: m.Categoria,
          Frecuencia: m.Frecuencia,
          Responsable: m.Responsable,
          FechaVencimiento: fechaVencimiento,
          Estado: "Pendiente",
          Critica: m.Critica === true,
        }
      );

      creadas.push(record);
    }

    res.json({
      ok: true,
      count: creadas.length,
      data: creadas,
    });
  } catch (error) {
    console.error("ERROR GENERAR PROGRAMACIONES:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/programaciones", async (req, res) => {
  try {
    const records = await listAirtableRecords(
      process.env.AIRTABLE_TABLE_PROGRAMACIONES
    );

    res.json({
      ok: true,
      data: records,
    });
  } catch (error) {
    console.error("ERROR PROGRAMACIONES:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =========================
// ARRANQUE
// =========================

app.listen(PORT, () => {
  console.log(`SASISOPA IA Backend activo en http://localhost:${PORT}`);
});

