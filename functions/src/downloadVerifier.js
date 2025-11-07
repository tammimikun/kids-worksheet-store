import express from "express";
import cors from "cors";
import midtransClient from "midtrans-client";

const app = express();

app.use(cors({
  origin: [
    "https://kidsworksheet.store",
    "https://www.kidsworksheet.store",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept","X-Requested-With"]
}));
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With");
  res.header("Access-Control-Allow-Credentials", "true");
  res.status(200).end();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ====== ENV Patch ======
(() => {
  const ENV = process.env;
  if (!ENV.MIDTRANS_SERVER_KEY) {
    ENV.MIDTRANS_SERVER_KEY =
      ENV.midtrans_server_key ||
      ENV.MIDTRANS_SERVER_KEYS ||
      ENV.midtransServerKey ||
      ENV["midtrans-server-key"] || "";
  }
  if (!ENV.MIDTRANS_CLIENT_KEY) {
    ENV.MIDTRANS_CLIENT_KEY =
      ENV.midtrans_client_key ||
      ENV.MIDTRANS_CLIENT_KEYS ||
      ENV.midtransClientKey ||
      ENV["midtrans-client-key"] || "";
  }
  if (typeof ENV.MIDTRANS_IS_PRODUCTION === "undefined") {
    ENV.MIDTRANS_IS_PRODUCTION = "true";
  }
})();

const serverKey = process.env.MIDTRANS_SERVER_KEY;
const isProductionFlag = String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase() === "true";
const snap = new midtransClient.Snap({ isProduction: isProductionFlag, serverKey });

const MIDTRANS_STATUS_BASE = isProductionFlag
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

// ===== Generator order_id =====
let __counterDate = ""; 
let __seq = 0;
function generateOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const today = `${mm}${dd}${yyyy}`;
  if (today !== __counterDate) { __counterDate = today; __seq = 0; }
  __seq += 1;
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `KWS-${today}-${String(__seq).padStart(4, "0")}-${ms}`;
}

// ===== Health check =====
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Midtrans Handler API is running",
    timestamp: new Date().toISOString(),
    environment: "production"
  });
});

// ===== Create Transaction =====
app.post("/create-transaction", async (req, res) => {
  try {
    const { transaction_details, customer_details, item_details } = req.body || {};
    const gross_amount = transaction_details?.gross_amount || req.body?.gross_amount;
    const order_id_client = transaction_details?.order_id || req.body?.order_id;

    if (!gross_amount || !customer_details || !item_details || !Array.isArray(item_details) || item_details.length === 0) {
      console.error("❌ [MIDTRANS] Missing required fields");
      return res.status(400).json({
        error: "Missing required fields",
        required: ["gross_amount", "customer_details", "item_details"]
      });
    }

    const nama =
      customer_details?.first_name ||
      customer_details?.name ||
      req.body?.nama || "";
    const email =
      customer_details?.email ||
      req.body?.email || "";

    let items = item_details;
    if (!items || !Array.isArray(items) || items.length === 0) {
      const modul = req.body?.modul || "Kids Worksheet";
      items = [{
        id: modul,
        price: Number(gross_amount),
        quantity: 1,
        name: modul
      }];
    }

    let serverOrderId = generateOrderId();
    const baseParam = {
      transaction_details: { order_id: serverOrderId, gross_amount },
      customer_details: {
        ...customer_details,
        first_name: nama || customer_details?.first_name || customer_details?.name,
        email: email || customer_details?.email
      },
      item_details: items
    };

    baseParam.credit_card = { secure: true };
    baseParam.custom_field1 = JSON.stringify({
      nama,
      email,
      modul: items?.[0]?.name || "Kids Worksheet"
    });

    // ======= [SYNC PATCH] custom_field2 aman (<=255 char). Tidak hapus skrip lama. =======
    try {
      const frontendModules = Array.isArray(req.body?.modulDipilih) ? req.body.modulDipilih : null;
      const namesFromFrontend = frontendModules?.map(m =>
        typeof m === "string" ? m : (m?.nama || m?.name || m?.id || "Modul")
      );

      const namesFromItems = items.map(it => it?.name || it?.id || "Modul");

      // Prioritas: gunakan dari frontend jika ada; jika tidak, jatuhkan ke item_details
      const fullList = (namesFromFrontend && namesFromFrontend.length) ? namesFromFrontend : namesFromItems;

      // ❌ Skrip lama (MENYEBABKAN error payload terlalu panjang di Midtrans) — DIPERTAHANKAN sebagai komentar:
      // baseParam.custom_field2 = JSON.stringify({ modulDipilih: fullList });

      // ✅ Skrip baru: simpan ringkasan pendek agar tidak melebihi batas 255 karakter Midtrans
      const shortList = fullList.slice(0, 3);
      const summary = `${shortList.join(", ")}${fullList.length > 3 ? ` +${fullList.length - 3} modul lainnya` : ""}`;
      baseParam.custom_field2 = JSON.stringify({ modulSummary: summary });

      // (Opsional, tidak menambah payload besar ke Midtrans)
      // baseParam.modul_count = fullList.length;
    } catch (e) {
      console.warn("⚠️ [MIDTRANS] Gagal set custom_field2:", e?.message || e);
    }
    // ======================================================================================================

    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    // [NEW - SYNC PASS-THROUGH] TERUSKAN ARRAY LENGKAP modulDipilih DARI FRONTEND (BUKAN KE CUSTOM FIELD)
    // (Tidak mengubah logika lama; hanya menambah properti agar webhook/email punya sumber data lengkap)
    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    try {
      baseParam.modulDipilih = Array.isArray(req.body?.modulDipilih) ? req.body.modulDipilih : [];
    } catch (_) {
      baseParam.modulDipilih = [];
    }
    // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

    // ======= FIXED: Expiry format sesuai Midtrans =======
    // Format waktu harus "YYYY-MM-DD HH:mm:ss Z"
    const start = new Date();
    const tzOffsetMin = start.getTimezoneOffset(); // dalam menit, biasanya -420 untuk GMT+7
    const offsetSign = tzOffsetMin > 0 ? "-" : "+";
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    const offsetH = pad(Math.abs(tzOffsetMin / 60));
    const offsetM = pad(Math.abs(tzOffsetMin % 60));
    const localTime = new Date(start.getTime() - tzOffsetMin * 60000);
    const formatted = `${localTime.getFullYear()}-${pad(localTime.getMonth() + 1)}-${pad(localTime.getDate())} ${pad(localTime.getHours())}:${pad(localTime.getMinutes())}:${pad(localTime.getSeconds())} ${offsetSign}${offsetH}${offsetM}`;
    baseParam.expiry = { start_time: formatted, unit: "minute", duration: 15 }; // durasi diperpanjang agar pasti > current time
    // =====================================================

    console.log("📦 [MIDTRANS] Payload diterima:", {
      gross_amount,
      customer: baseParam.customer_details?.first_name || "(tidak ada)",
      total_items: baseParam.item_details?.length,
      order_id_client,
      isProduction: isProductionFlag,
      expiry: baseParam.expiry
    });

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`📤 [MIDTRANS] Attempt ${attempt} createTransaction with order_id=${baseParam.transaction_details.order_id}`);
        const tx = await snap.createTransaction(baseParam);
        console.log("✅ [MIDTRANS] Token generated:", Boolean(tx?.token));
        return res.status(200).json({
          success: true,
          token: tx.token,
          order_id: baseParam.transaction_details.order_id,
          client_key: process.env.MIDTRANS_CLIENT_KEY || undefined
        });
      } catch (e) {
        const msg = String(e?.message || e);
        lastErr = e;
        if (msg.includes("order_id has already been taken")) {
          const newId = generateOrderId();
          console.warn(`🔁 [MIDTRANS] order_id taken. Regenerating -> ${newId}`);
          baseParam.transaction_details.order_id = newId;
          continue;
        }
        throw e;
      }
    }

    console.error("❌ [MIDTRANS] Failed after retries:", lastErr?.message || lastErr);
    return res.status(500).json({ error: "Gagal membuat transaksi", details: String(lastErr?.message || lastErr) });
  } catch (err) {
    console.error("❌ [MIDTRANS] Error creating transaction:", err);
    return res.status(500).json({ error: "Gagal membuat transaksi", details: err.message });
  }
});

// ===== Check Status =====
app.get("/check-status", async (req, res) => {
  try {
    const { order_id } = req.query || {};
    if (!order_id) {
      return res.status(400).json({ error: "order_id required" });
    }

    const resp = await fetch(`${MIDTRANS_STATUS_BASE}/${encodeURIComponent(order_id)}/status`, {
      method: "GET",
      headers: {
        "Authorization": "Basic " + Buffer.from(serverKey + ":").toString("base64"),
        "Content-Type": "application/json"
      }
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("❌ [CHECK-STATUS] Midtrans error:", resp.status, resp.statusText, data);
      return res.status(resp.status).json({ error: "Midtrans error", details: data });
    }

    return res.status(200).json({
      order_id: data.order_id,
      transaction_status: data.transaction_status,
      fraud_status: data.fraud_status,
      payment_type: data.payment_type,
      gross_amount: data.gross_amount
    });
  } catch (err) {
    console.error("❌ [CHECK-STATUS] Error:", err);
    return res.status(500).json({ error: "Failed to check status", details: err.message });
  }
});

export const midtransHandler = app;
