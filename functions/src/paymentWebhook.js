import crypto from "crypto";
import fetch from "node-fetch";
import express from "express";

const app = express();

// ✅ Tambahkan dukungan untuk body parser JSON dan URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const SEND_INVOICE_URL =
  process.env.SEND_INVOICE_URL ||
  "https://sendinvoiceemail-smbjamnkmq-et.a.run.app";
const REQUEST_TIMEOUT = 30000; // 30 detik timeout

// ============================================================
// === [0] Fallback route untuk Midtrans yang memanggil root "/" ===
// ============================================================
app.post("/", (req, res) => {
  console.log("📬 [WEBHOOK] Root POST diterima, redirect ke /payment-webhook");
  req.url = "/payment-webhook";
  app.handle(req, res);
});

// ============================================================
// === [SYNC PATCH] ENV shim & var tambahan agar selaras Secret Manager & produksi/sandbox ===
// ============================================================
(() => {
  const ENV = process.env;
  if (!ENV.MIDTRANS_SERVER_KEY) {
    ENV.MIDTRANS_SERVER_KEY =
      ENV.midtrans_server_key ||
      ENV.MIDTRANS_SERVER_KEYS ||
      ENV.midtransServerKey ||
      ENV["midtrans-server-key"] ||
      "";
  }
  if (typeof ENV.MIDTRANS_IS_PRODUCTION === "undefined") {
    // default ke production untuk case kamu
    ENV.MIDTRANS_IS_PRODUCTION = "true";
  }
  if (!ENV.DOWNLOAD_SECRET) {
    // tidak wajib, hanya untuk pembuatan link unduh aman
    ENV.DOWNLOAD_SECRET = ENV.DOWNLOAD_SECRET || "";
  }
  if (!ENV.DOWNLOAD_VERIFIER_URL) {
    // opsional, gunakan pola langsung ke /Modul jika tidak tersedia
    ENV.DOWNLOAD_VERIFIER_URL = ENV.DOWNLOAD_VERIFIER_URL || "";
  }
})();

const IS_PRODUCTION = String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase() === "true";
const MIDTRANS_STATUS_BASE = IS_PRODUCTION
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

// 👉 Tambahan util minim-invasif (tidak menghapus apa pun):
//    - extractString: normalisasi string
//    - safeJsonParse: parse JSON aman
//    - getEmailRobust: fallback ekstra untuk menangkap email dari berbagai tempat/format
const extractString = (v) => (typeof v === "string" ? v.trim() : "");
const safeJsonParse = (s) => {
  try {
    if (typeof s === "string") return JSON.parse(s);
    if (s && typeof s === "object") return s;
  } catch {}
  return null;
};
const getEmailRobust = (notification) => {
  // 1) customer_details.email
  const cdEmail =
    notification?.customer_details?.email ||
    notification?.customer_details?.Email ||
    notification?.customer_email ||
    notification?.email;
  if (extractString(cdEmail)) return extractString(cdEmail);

  // 2) custom_field1 bisa string JSON atau objek
  const cf1raw = notification?.custom_field1;
  let cf1obj = null;
  if (typeof cf1raw === "string") cf1obj = safeJsonParse(cf1raw);
  else if (cf1raw && typeof cf1raw === "object") cf1obj = cf1raw;

  const cf1Email =
    cf1obj?.email ||
    cf1obj?.Email ||
    (typeof cf1obj?.contact === "object" ? cf1obj?.contact?.email : undefined);
  if (extractString(cf1Email)) return extractString(cf1Email);

  // 3) Regex darurat jika custom_field1 berupa string deskriptif yang mengandung email mentah
  if (typeof cf1raw === "string") {
    const m = cf1raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m && m[0]) return m[0];
  }

  // 4) Terakhir, coba custom_fields (beberapa integrasi meletakkan payload di sini)
  const cf =
    notification?.custom_fields ||
    notification?.customField ||
    notification?.customField1;
  const cfObj = safeJsonParse(cf);
  const cfAltEmail = cfObj?.email || cfObj?.Email;
  if (extractString(cfAltEmail)) return extractString(cfAltEmail);

  return "";
};

// ============================================================
// === [1] Endpoint utama: menerima webhook dari Midtrans ===
// ============================================================
app.post("/payment-webhook", async (req, res) => {
  const sendResponse = (status, data) => {
    console.log(`📤 [WEBHOOK] Sending response: ${status}`, data);
    return res.status(200).json(data);
  };

  try {
    console.log("📩 [WEBHOOK] Webhook diterima:", JSON.stringify(req.body, null, 2));

    const notification = req.body;
    if (!notification || typeof notification !== "object") {
      console.error("❌ [WEBHOOK] Invalid notification data:", notification);
      return sendResponse(200, { error: "Invalid notification data" });
    }

    if (!MIDTRANS_SERVER_KEY) {
      console.error("❌ [WEBHOOK] MIDTRANS_SERVER_KEY environment variable not set");
      return sendResponse(200, { error: "Server configuration error" });
    }

    let order_id = notification.order_id;
    const status_code = notification.status_code;
    const gross_amount = notification.gross_amount;

    if (!order_id || !status_code || !gross_amount || !notification.signature_key) {
      console.error("❌ [WEBHOOK] Missing required fields for signature validation");
      return sendResponse(200, { error: "Missing required fields for signature validation" });
    }

    // ============================================================
    // Normalisasi order_id agar cocok dengan format baru
    // ============================================================
    const normalizeOrderId = (oid) => oid.replace(/-\d{1,4}$/, "");
    const normalizedOrderId = normalizeOrderId(order_id);
    console.log(`🧩 [WEBHOOK] Normalized order_id: ${order_id} → ${normalizedOrderId}`);
    order_id = normalizedOrderId;

    // ============================================================
    // [SYNC PATCH] Signature MUST use ORIGINAL order_id (tanpa normalisasi)
    //              agar 100% match rumus Midtrans/Laravel: sha512(order_id + status_code + gross_amount + serverKey)
    // ============================================================
    const originalOrderIdForSignature = req.body.order_id; // simpan aslinya sebelum normalisasi
    const signatureKey = crypto
      .createHash("sha512")
      .update(originalOrderIdForSignature + status_code + gross_amount + MIDTRANS_SERVER_KEY)
      .digest("hex");

    if (signatureKey !== notification.signature_key) {
      console.error("❌ [WEBHOOK] Invalid signature key for order:", originalOrderIdForSignature);
      return sendResponse(200, { error: "Invalid signature key", order_id: originalOrderIdForSignature });
    }

    console.log("✅ [WEBHOOK] Signature validated for:", originalOrderIdForSignature);

    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;

    // 🔁 [ROLLBACK] Tidak mengambil metadata dari custom_field manapun

    // ============================================================
    // [PATCH] Helper normalisasi nama modul (stringify nested)
    // ============================================================
    const extractNamaModul = (v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        if (typeof v.nama === "string") return v.nama;
        if (v.nama && typeof v.nama === "object" && typeof v.nama.nama === "string") return v.nama.nama;
        if (typeof v.name === "string") return v.name;
      }
      return "Modul Tidak Dikenal";
    };

    // ============================================================
    // Hanya kirim email jika status = settlement
    // ============================================================
    if (transactionStatus === "settlement") {
      console.log(`✅ [WEBHOOK] Payment success for order_id: ${order_id}`);

      // Nama default dari customer_details; fallback ke custom_field1.name jika ada
      let nama = notification.customer_details?.first_name || notification.customer_details?.name || "Pelanggan";

      // ⬇️⬇️⬇️ [MINIMAL PATCH] Fallback ambil email & nama dari custom_field1 (JSON) bila customer_details.email kosong
const parseCustomField1 = () => {
  try {
    const cf1 = notification.custom_field1;
    if (!cf1) return {};
    if (typeof cf1 === "string") {
      const obj = JSON.parse(cf1);
      return obj && typeof obj === "object" ? obj : {};
    }
    if (typeof cf1 === "object") return cf1;
    return {};
  } catch (e) {
    console.warn("⚠️ [WEBHOOK] Gagal parse custom_field1:", e.message);
    return {};
  }
};

const cf1 = parseCustomField1();

// 🔧 Tambahan super-fallback agar tidak lagi "Customer email missing"
let email =
  notification.customer_details?.email ||
  (typeof cf1.email === "string" ? cf1.email : null);

if (!email) {
  // gunakan helper baru yang lebih agresif
  email = getEmailRobust(notification);
  if (email) {
    console.log("🔎 [WEBHOOK] Email didapat via fallback robust:", email);
  }
}

// ✅✅ PATCH BARU: Timpa nama jika sebelumnya kosong/“Pelanggan” dan cf1 membawa nama valid
(() => {
  const cf1Name = typeof cf1.nama === "string" ? cf1.nama : (typeof cf1.name === "string" ? cf1.name : "");
  if (cf1Name && cf1Name.trim()) {
    const current = (nama ?? "").toString().trim().toLowerCase();
    if (!current || current === "pelanggan") {
      nama = cf1Name.trim();
    }
  }
})();

// ⬆️⬆️⬆️ END PATCH (logika lama tetap dipakai; hanya menambah fallback)

const total = notification.gross_amount;

let modulDipilih = [];

// 🔁 [ROLLBACK] Sumber modul: hanya dari item_details atau notification.modulDipilih (tanpa custom_field)
if (notification.item_details && notification.item_details.length > 0) {
  modulDipilih = notification.item_details.map((item) => {
    const nm = extractNamaModul(item.name ?? item);
    return { nama: nm, url: `/Modul/${encodeURIComponent(nm + ".pdf")}` };
  });
} else if (notification.modulDipilih && notification.modulDipilih.length > 0) {
  modulDipilih = notification.modulDipilih.map((m) => {
    const nm = extractNamaModul(m);
    return { nama: nm, url: `/Modul/${encodeURIComponent(nm + ".pdf")}` };
  });
}

// 🔁 [ROLLBACK] Tidak ada enrichment dari custom_field2/custom_field3

// ✅✅✅ [FALLBACK PATCH] Rekonstruksi modul dari custom_field2 jika sumber utama kosong
// Penempatan: setelah rollback comment di atas, tanpa mengubah logika lama
try {
  if ((!modulDipilih || modulDipilih.length === 0) && notification?.custom_field2) {
    const raw = notification.custom_field2;
    let cf2 = null;
    if (typeof raw === "string") {
      try { cf2 = JSON.parse(raw); } catch { cf2 = raw; }
    } else if (raw && typeof raw === "object") {
      cf2 = raw;
    }

    const pushIfNew = (name) => {
      const nm = extractNamaModul(name);
      if (!nm || nm === "Modul Tidak Dikenal") return;
      modulDipilih.push({ nama: nm, url: `/Modul/${encodeURIComponent(nm + ".pdf")}` });
    };

    if (Array.isArray(cf2)) {
      // Bentuk: ["Modul 1 ...", { nama: "Modul 2 ..." }, ...]
      cf2.forEach((m) => {
        if (typeof m === "string") return pushIfNew(m);
        if (m && typeof m === "object") return pushIfNew(m.nama || m.name || m.id || "");
      });
    } else if (cf2 && typeof cf2 === "object") {
      // Bentuk: { modulDipilih: [...]} atau { modul: [...]} atau { modules: [...] }
      const arr = cf2.modulDipilih || cf2.modul || cf2.modules;
      if (Array.isArray(arr)) {
        arr.forEach((m) => {
          if (typeof m === "string") return pushIfNew(m);
          if (m && typeof m === "object") return pushIfNew(m.nama || m.name || m.id || "");
        });
      } else if (typeof cf2.modulSummary === "string") {
        // Ringkasan pendek: "Modul 1, Modul 2, Modul 3 +9 modul lainnya"
        const base = cf2.modulSummary.split("+")[0];
        base.split(",").map((s) => s.trim()).filter(Boolean).forEach(pushIfNew);
      }
    } else if (typeof cf2 === "string") {
      // Kadang berupa string list dipisah koma
      cf2.split(",").map((s) => s.trim()).filter(Boolean).forEach(pushIfNew);
    }

    if (modulDipilih.length > 0) {
      console.log("🧩 [WEBHOOK] modulDipilih direkonstruksi dari custom_field2 (fallback)", modulDipilih.length);
    }
  }
} catch (e) {
  console.warn("⚠️ [WEBHOOK] Gagal rekonstruksi modul dari custom_field2:", e.message);
}

// ---------- [PATCH] Dedup & sanitize ----------
modulDipilih = modulDipilih
  .map((m) => ({ nama: extractNamaModul(m?.nama ?? m) }))
  .filter((m) => m.nama && m.nama !== "Modul Tidak Dikenal");


      const seen = new Set();
      modulDipilih = modulDipilih.filter((m) => {
        const key = m.nama.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // ----------------------------------------------

      if (!email) {
        console.error(`❌ [WEBHOOK] Email tidak ditemukan untuk order_id: ${order_id}`);
        return sendResponse(200, { error: "Customer email missing", order_id });
      }

      if (!modulDipilih || modulDipilih.length === 0) {
        console.error(`❌ [WEBHOOK] Tidak ada modul ditemukan untuk order_id: ${order_id}`);
        return sendResponse(200, { error: "No modules found in order", order_id });
      }

      // [LEGACY] Generate link download aman (HMAC 24 jam) — DIPERTAHANKAN
      let downloadLinks = [];
      try {
        const secret = process.env.DOWNLOAD_SECRET || "";
        const verifierBase = process.env.DOWNLOAD_VERIFIER_URL || ""; // jika ada layanan verifier

        // ⏰ EXP dalam milidetik (sinkron dengan verifyDownloadLink yang membandingkan dengan Date.now())
        const expMs = Date.now() + 24 * 3600 * 1000;

        downloadLinks = modulDipilih.map((m) => {
          const moduleName = extractNamaModul(m?.nama ?? m);

          // --- [LEGACY - DIPERTAHANKAN] Rumus lama (tidak dipakai lagi untuk URL utama) ---
          const legacyToken = secret
            ? crypto
                .createHmac("sha256", secret)
                .update(`${moduleName}.${originalOrderIdForSignature}.${Math.floor(expMs / 1000)}`)
                .digest("hex")
            : "";
          const legacyDirectPath = `https://kidsworksheet.store/Modul/${encodeURIComponent(moduleName)}`;
          const legacyUrl = `${legacyDirectPath}?order=${encodeURIComponent(
            originalOrderIdForSignature
          )}&exp=${Math.floor(expMs / 1000)}&token=${legacyToken}`;
          // -------------------------------------------------------------------------------

          // --- [BARU - SINKRON VERIFIER] Rumus baru: sig = HMAC(file:expMs), params: file, exp, sig ---
          const fileParam = `${moduleName}.pdf`; // verifier mengharapkan nama file lengkap
          const sig = secret
            ? crypto.createHmac("sha256", secret).update(`${fileParam}:${expMs}`).digest("hex")
            : "";

          const verifiedUrl = verifierBase
            ? `${verifierBase}?file=${encodeURIComponent(fileParam)}&exp=${expMs}&sig=${sig}`
            : `${legacyDirectPath}?file=${encodeURIComponent(fileParam)}&exp=${expMs}&sig=${sig}`; // fallback jika verifierBase kosong

          return {
            nama: moduleName,
            url: verifiedUrl,     // ← URL LEGACY (tetap disimpan)
            legacy_url: legacyUrl // ← LEGACY
          };
        });
      } catch (e) {
        console.error("❌ [WEBHOOK] Gagal membuat download link aman:", e);
      }

      // ============================================================
      // [DIRECT GCS MODE] — Override URL agar langsung ke GCS (tanpa sig & expiry)
      //                    KODE LEGACY DI ATAS TETAP ADA & TIDAK DIHAPUS
      // ============================================================
      try {
        downloadLinks = downloadLinks.map((link) => {
          const nm = extractNamaModul(link?.nama ?? link);
          const safe = String(nm).replace(/[<>:"/\\|?*]/g, "-").trim();
          const gcsUrl = `https://kidsworksheet.store/Modul/${encodeURIComponent(safe)}.pdf`;
          return {
            ...link,
            url: gcsUrl,       // ← timpa ke direct GCS
            legacy_url: link.legacy_url ?? gcsUrl
          };
        });
      } catch (e) {
        console.error("❌ [WEBHOOK] Gagal override direct GCS URL:", e);
      }

      // ---------- [PATCH] Guard: pastikan jumlah link == jumlah modul ----------
      if (downloadLinks.length < modulDipilih.length) {
        console.warn(
          `⚠️ [WEBHOOK] downloadLinks(${downloadLinks.length}) < modulDipilih(${modulDipilih.length}) — regenerating direct GCS links`
        );
        downloadLinks = modulDipilih.map((m) => {
          const nm = extractNamaModul(m?.nama ?? m);
          const safe = String(nm).replace(/[<>:"/\\|?*]/g, "-").trim();
          const url = `https://kidsworksheet.store/Modul/${encodeURIComponent(safe)}.pdf`;
          return { nama: nm, url, legacy_url: url };
        });
      }
      // ------------------------------------------------------------------------

      try {
        const emailPayload = {
          order_id: originalOrderIdForSignature,
          nama,
          email,
          total,
          modulDipilih,
          status: transactionStatus,
          gross_amount: notification.gross_amount,
          settlement_time: notification.settlement_time || null,
          downloadLinks,
          download_url: downloadLinks?.[0]?.url || null
        };

        console.log(`📤 [WEBHOOK] Calling sendInvoiceEmail:`, JSON.stringify(emailPayload, null, 2));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        const resp = await fetch(SEND_INVOICE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "payment-webhook/1.0",
          },
          body: JSON.stringify(emailPayload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const responseText = await resp.text();

        if (resp.ok) {
          console.log(`✅ [WEBHOOK] Email invoice terkirim ke ${email} (${originalOrderIdForSignature})`);
        } else {
          console.error(`❌ [WEBHOOK] Gagal mengirim email ke ${email} (${originalOrderIdForSignature})`);
          console.error(`❌ [WEBHOOK] Status: ${resp.status} ${resp.statusText}`);
          console.error(`❌ [WEBHOOK] Response: ${responseText}`);
        }
      } catch (emailError) {
        console.error(`❌ [WEBHOOK] Error saat memanggil sendInvoiceEmail:`, emailError);
      }
    } else {
      console.log(`⚠️ [WEBHOOK] Payment status: ${transactionStatus} - Email tidak dikirim`);
    }

    console.log(`✅ [WEBHOOK] Webhook processed successfully for order: ${order_id}`);
    return sendResponse(200, { success: true, message: "Webhook processed", order_id });
  } catch (err) {
    console.error("❌ [WEBHOOK] Error in webhook:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ============================================================
// === [2] Endpoint baru: verifikasi status pembayaran ===
// ============================================================
app.get("/check-status", async (req, res) => {
  const { order_id } = req.query;

  if (!order_id) {
    console.error("❌ [CHECK-STATUS] order_id missing in request");
    return res.status(400).json({ error: "order_id required" });
  }

  try {
    console.log(`🔍 [CHECK-STATUS] Checking status for order_id: ${order_id}`);

    const response = await fetch(`${MIDTRANS_STATUS_BASE}/${order_id}/status`, {
      headers: {
        Authorization:
          "Basic " + Buffer.from(MIDTRANS_SERVER_KEY + ":").toString("base64"),
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();
    console.log("📦 [CHECK-STATUS] Response:", data);

    if (!data || !data.transaction_status) {
      console.error("❌ [CHECK-STATUS] Invalid response from Midtrans");
      return res.status(400).json({ error: "Invalid response from Midtrans" });
    }

    return res.status(200).json({
      order_id: data.order_id,
      transaction_status: data.transaction_status,
      fraud_status: data.fraud_status,
      gross_amount: data.gross_amount,
    });
  } catch (err) {
    console.error("❌ [CHECK-STATUS] Error verifying status:", err);
    return res.status(500).json({ error: "Failed to verify transaction", details: err.message });
  }
});

// ============================================================
// === [3] Export sebagai Cloud Function ===
// ============================================================
export const paymentWebhook = app;
