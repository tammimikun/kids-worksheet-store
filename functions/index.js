/**
 * Kids Worksheet Store – Firebase Functions Entry Point (Revisi Final Sinkronisasi Secrets)
 * Author: Muhammad Rijal Tammimi
 * Menjaga semua logika lama tetap utuh, hanya menyesuaikan ekspor & secrets agar sinkron dengan Firebase Functions Gen2.
 */

const { onRequest } = require("firebase-functions/v2/https");

// Import handler lama (tidak diubah)
const midtrans = require("./src/midtransHandler");
const webhook = require("./src/paymentWebhook");
const sendEmail = require("./src/sendInvoiceEmail");
const verifier = require("./src/downloadVerifier");

// Util kecil agar kompatibel dengan berbagai bentuk export (function langsung / ESM object)
function pickHandler(mod, keyGuess) {
  if (typeof mod === "function") return mod;
  if (mod && typeof mod.default === "function") return mod.default;
  if (keyGuess && typeof mod?.[keyGuess] === "function") return mod[keyGuess];
  const first = mod && Object.values(mod).find((v) => typeof v === "function");
  if (first) return first;
  throw new Error("Invalid handler export: " + JSON.stringify(Object.keys(mod || {})));
}

// 🟩 Fungsi Midtrans Handler
exports.midtransHandler = onRequest(
  {
    region: "asia-southeast2",
    // ✅ Disesuaikan agar membaca secret versi baru (UPPER_SNAKE_CASE)
    secrets: ["MIDTRANS_SERVER_KEY", "MIDTRANS_CLIENT_KEY"],
  },
  pickHandler(midtrans, "midtransHandler")
);

// 🟩 Fungsi Webhook Pembayaran
exports.paymentWebhook = onRequest(
  {
    region: "asia-southeast2",
    // ✅ Gunakan format secret terbaru
    secrets: ["MIDTRANS_SERVER_KEY", "MIDTRANS_CLIENT_KEY"],
  },
  pickHandler(webhook, "paymentWebhook")
);

// 🟩 Fungsi Kirim Email Invoice
exports.sendInvoiceEmail = onRequest(
  {
    region: "asia-southeast2",
    // ✅ Disesuaikan ke SENDGRID_API_KEY agar sinkron dengan secret yang baru
    secrets: ["SENDGRID_API_KEY", "FROM_EMAIL"],
  },
  pickHandler(sendEmail, "sendInvoiceEmail")
);

// 🟩 Fungsi Download Verifier (tidak diubah, tetap kompatibel)
exports.downloadVerifier = pickHandler(verifier, "downloadVerifier");
