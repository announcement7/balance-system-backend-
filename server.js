const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const admin = require("firebase-admin");

const app = express();
const PORT = 3000;

// ✅ Firestore setup
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// JSON storage for legacy receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://swiftcapitalportal.onrender.com",
  })
);

// Helpers
function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}
function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

///////////////////////////////////////////////////////////////////////////////
// 💸 1️⃣ Loan Payment Endpoint (your original)
///////////////////////////////////////////////////////////////////////////////
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
      callback_url: "https://swift-capital.onrender.com/callback",
      channel_id: "000205",
    };
    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer f7a932be3cd1251ab70bae129aacd9ae527287e927c5f45ec1cf4a3948eaf443`,
        "Content-Type": "application/json",
      },
    });

    if (resp.data.success) {
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
      const receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, message: "STK push sent", reference, receipt: receiptData });
    } else {
      res.status(400).json({ success: false, error: "STK push failed" });
    }
  } catch (err) {
    console.error("Payment error:", err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

///////////////////////////////////////////////////////////////////////////////
// 🧾 2️⃣ Loan Payment Callback (unchanged)
///////////////////////////////////////////////////////////////////////////////
app.post("/callback", (req, res) => {
  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  const status = data.status?.toLowerCase();
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

  writeReceipts(receipts);
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

///////////////////////////////////////////////////////////////////////////////
// 💰 3️⃣ Deposit System (Firebase integrated)
///////////////////////////////////////////////////////////////////////////////
app.post("/deposit", async (req, res) => {
  try {
    const { userId, phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) return res.status(400).json({ error: "Invalid phone" });
    if (!amount || amount < 1) return res.status(400).json({ error: "Amount must be >= 1" });

    const reference = "DEPOSIT-" + Date.now();
    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Wallet Deposit",
      callback_url: "https://swift-capital.onrender.com/deposit-callback",
      channel_id: "000205",
    };

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer f7a932be3cd1251ab70bae129aacd9ae527287e927c5f45ec1cf4a3948eaf443`,
        "Content-Type": "application/json",
      },
    });

    await db.collection("deposits").doc(reference).set({
      userId,
      phone: formattedPhone,
      amount: Math.round(amount),
      reference,
      status: "pending",
      note: "STK push sent. Check your phone.",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reference, message: "STK push sent. Check your phone." });
  } catch (err) {
    console.error("Deposit initiation error:", err.message);
    res.status(500).json({ error: "Deposit failed." });
  }
});

app.post("/deposit-callback", async (req, res) => {
  const data = req.body;
  const ref = data.external_reference;
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
  }

  const depositRef = db.collection("deposits").doc(ref);
  const depositSnap = await depositRef.get();
  if (!depositSnap.exists) return res.status(404).json({ error: "Reference not found" });

  const depositData = depositSnap.data();
  await depositRef.update({
    status: depositStatus,
    note,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (depositStatus === "success") {
    const userRef = db.collection("users").doc(depositData.userId);
    const userSnap = await userRef.get();
    const currentBalance = userSnap.exists ? userSnap.data().balance || 0 : 0;
    await userRef.set(
      {
        balance: currentBalance + depositData.amount,
        lastDeposit: depositData.amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  res.json({ ResultCode: 0, ResultDesc: "Deposit callback handled successfully" });
});

///////////////////////////////////////////////////////////////////////////////
// 📊 4️⃣ Get User + Transactions
///////////////////////////////////////////////////////////////////////////////
app.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  const userSnap = await db.collection("users").doc(userId).get();
  const balance = userSnap.exists ? userSnap.data().balance || 0 : 0;

  const depositsSnap = await db
    .collection("deposits")
    .where("userId", "==", userId)
    .orderBy("timestamp", "desc")
    .get();

  const transactions = depositsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json({ balance, transactions });
});

///////////////////////////////////////////////////////////////////////////////
// 🚀 Start Server
///////////////////////////////////////////////////////////////////////////////
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
