import sgMail from "@sendgrid/mail";
import crypto from "crypto";

// ===== ENV =====
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@kidsworksheet.store";
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET || "3fA9jPpL0xK7!@2zYhVb";

// ✅ Shim tambahan untuk jaga konsistensi Secret Manager
(() => {
  const ENV = process.env;
  if (!ENV.SENDGRID_API_KEY) {
    ENV.SENDGRID_API_KEY =
      ENV.sendgrid_api_key ||
      ENV.sendgridApiKey ||
      ENV["sendgrid-api-key"] ||
      "";
  }
  if (!ENV.FROM_EMAIL) {
    ENV.FROM_EMAIL = ENV.from_email || ENV.FromEmail || FROM_EMAIL;
  }
})();

/* 🟢 Tambahan dari saran Gemini:
   Saat proses build (Firebase CLI), secrets belum di-inject.
   Maka, kita buat simulasi agar validator tidak error,
   tetapi saat runtime tetap memakai secrets asli.
*/
if (process.env.FUNCTION_TARGET === undefined) {
  console.warn(
    "⚠️ [BUILD PHASE] Firebase Secrets belum tersedia, melewati validasi API key."
  );
} else {
  if (!process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
    console.warn(
      "⚠️ [SENDGRID] ENV SENDGRID_API_KEY belum aktif (kemungkinan false positive saat build)."
    );
  }
}

// (BARIS LAMA DIPERTAHANKAN)
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/** 🔢 Generator Nomor Invoice */
function generateInvoiceNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const seq = String(Math.floor(1 + Math.random() * 9999)).padStart(4, "0");
  return `KWS-${d}${m}${y}-${seq}`;
}

/** 🔗 Generator URL download (langsung ke GCS) */
function makeSecureDownloadUrl(modulName) {
  const nameValue =
    typeof modulName === "string"
      ? modulName
      : modulName?.nama || "Modul Tidak Dikenal";

  const safeName = nameValue
    .replace(/[:]/g, "-")
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim();

  const fileName = `${safeName}.pdf`;
  return `https://kidsworksheet.store/Modul/${encodeURIComponent(fileName)}`;
}

export const sendInvoiceEmail = async (req, res) => {
  try {
    console.log("📩 Payload diterima:", JSON.stringify(req.body, null, 2));
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const {
      order_id,
      status,
      total,
      nama,
      email,
      modulDipilih,
      downloadLinks,
      download_url,
    } = req.body;

    if (!order_id || !email || !total) {
      console.error("❌ Data wajib kosong:", { order_id, total, email });
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedStatus = String(status || "").toLowerCase();
    if (!(normalizedStatus === "settlement" || normalizedStatus === "success")) {
      console.log(`ℹ️ Status transaksi ${status}, email tidak dikirim.`);
      return res.status(200).json({ message: "Non-settlement ignored." });
    }

    if (!process.env.SENDGRID_API_KEY) {
      console.error("❌ [EMAIL] SENDGRID_API_KEY tidak diset di environment");
      return res.status(500).json({ error: "SendGrid API key not configured" });
    }
    if (!process.env.FROM_EMAIL && !FROM_EMAIL) {
      console.error("❌ [EMAIL] FROM_EMAIL tidak diset di environment");
      return res.status(500).json({ error: "Sender email not configured" });
    }

    const invoiceNumber = generateInvoiceNumber();
    console.log(`📄 Invoice: ${invoiceNumber}`);

    if (!Array.isArray(modulDipilih) || modulDipilih.length === 0) {
      console.error("❌ Tidak ada modul ditemukan");
      return res.status(400).json({ error: "No modules found" });
    }

    // ✅ Tambahan normalisasi agar semua modul terbaca
    let normalizedModules = modulDipilih.map((m) => {
      if (typeof m === "string") return { nama: m };
      if (m && typeof m === "object") {
        return {
          nama: m.nama?.nama || m.nama || m.name || "Modul Tidak Dikenal",
          url: m.url || "",
        };
      }
      return { nama: "Modul Tidak Dikenal" };
    });

    // ✅ Perbaikan: gunakan normalizedModules jika downloadLinks tidak lengkap
    const effectiveLinks =
      Array.isArray(downloadLinks) && downloadLinks.length >= normalizedModules.length
        ? downloadLinks
        : normalizedModules.map((m, idx) => {
            const safeNama = (m.nama || `Modul ${idx + 1}`)
              .replace(/[<>:"/\\|?*]/g, "-")
              .trim();
            const urlModul = m.url || makeSecureDownloadUrl(safeNama);
            return { nama: safeNama, url: urlModul };
          });

    const modulRows = effectiveLinks
      .map((m, i) => {
        const name = typeof m === "string" ? m : m.nama || "Modul";
        const url =
          typeof m === "string"
            ? makeSecureDownloadUrl(name)
            : m.url || makeSecureDownloadUrl(name);
        return `
          <tr style="border-bottom:1px solid #ddd;text-align:center">
            <td style="padding:8px;">${i + 1}</td>
            <td style="padding:8px;">${name}</td>
            <td style="padding:8px;">
              <a href="${url}" target="_blank"
                 style="background:#22c55e;color:white;text-decoration:none;
                        padding:6px 14px;border-radius:8px;font-weight:500">
                 Unduh Modul
              </a>
            </td>
          </tr>`;
      })
      .join("");

    const tanggal = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "long",
      timeStyle: "short",
    });
    const totalRupiah = Number(total).toLocaleString("id-ID");

    const html = `
<!DOCTYPE html>
<html lang="id">
<head><meta charset="UTF-8"><title>Invoice ${invoiceNumber}</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f9fafb;padding:24px;color:#333">
<div style="max-width:700px;margin:auto;background:#fff;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,.05);padding:32px">
  <div style="text-align:center;margin-bottom:24px">
    <img src="https://storage.googleapis.com/kidsworksheet.store/Logo/logo.png" alt="Logo" style="height:80px">
    <h2 style="margin-bottom:4px;">Invoice ${invoiceNumber}</h2>
    <p style="color:#666">Order ID: ${order_id}</p>
  </div>
  <p><strong>Nama:</strong> ${nama}</p>
  <p><strong>Email:</strong> ${email}</p>
  <p><strong>Tanggal:</strong> ${tanggal}</p>
  <p><strong>Status Pembayaran:</strong> <span style="color:green;font-weight:bold;">Berhasil</span></p>

  <table style="width:100%;border-collapse:collapse;margin-top:18px">
    <thead style="background:#f1f5f9">
      <tr><th style="padding:8px;">No</th><th style="padding:8px;">Modul</th><th style="padding:8px;">Link Download</th></tr>
    </thead>
    <tbody>${modulRows}</tbody>
  </table>

  <div style="text-align:right;margin-top:18px;font-size:18px;font-weight:bold">
    Total: Rp${totalRupiah}
  </div>
</div>
</body>
</html>`;

    console.log(`📤 Mengirim email ke ${email}...`);
    try {
      const emailResult = await sgMail.send({
        to: email,
        from: { email: process.env.FROM_EMAIL || FROM_EMAIL, name: "Kids Worksheet Store" },
        subject: `Invoice ${invoiceNumber} — Kids Worksheet Store`,
        html,
      });

      console.log(`✅ [EMAIL] SendGrid response:`, emailResult[0]?.statusCode);
      console.log(`✅ Email terkirim ke ${email} (${order_id})`);
      return res.status(200).json({
        success: true,
        message: "Email sent successfully",
        invoiceNumber,
        order_id,
        email_sent_to: email,
        download_url:
          (Array.isArray(effectiveLinks) && effectiveLinks[0]?.url) ||
          download_url ||
          null,
      });
    } catch (sendGridError) {
      console.error("❌ [EMAIL] SendGrid error:", sendGridError);
      return res.status(200).json({
        success: false,
        message: "Email sending failed, but webhook processed",
        error: sendGridError.message,
        order_id,
      });
    }
  } catch (err) {
    console.error("❌ Error sendInvoiceEmail:", err);
    return res
      .status(500)
      .json({ error: "Failed to send invoice email", details: err.message });
  }
};
