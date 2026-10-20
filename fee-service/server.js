require('dotenv').config();
const express = require('express');
const http = require('node:http');
const https = require('node:https');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4001);
const BANK_URL = new URL(process.env.BANK_URL || 'http://localhost:4002');
const transport = BANK_URL.protocol === 'https:' ? https : http;
const agent = new transport.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 10,
  keepAliveMsecs: 1_000
});

const fees = new Map([['1', 50_000_000], ['2', 0], ['3', 3_200_000]]);
const reserved = new Map(); // Tiền đang PROCESSING/PENDING, tránh chi vượt công nợ.
const payments = new Map();
let paymentSeq = 0;

const TOTAL_TIMEOUT_MS = 4_000; // Phải dưới 4,5 giây.
const REQUEST_TIMEOUT_MS = 1_100;
const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noConnectionCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);

function callBank(payment, timeoutMs) {
  const body = JSON.stringify({ reference: payment.id, amount: payment.amount });
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const request = transport.request(new URL('/charges', BANK_URL), {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Idempotency-Key': payment.id
      }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = {};
        try { data = JSON.parse(raw); } catch { /* unknown response */ }
        finish(null, { statusCode: response.statusCode, data });
      });
      response.on('error', (error) => finish(error));
      response.on('aborted', () => {
        const error = new Error('Bank response aborted');
        error.code = 'ECONNRESET';
        finish(error);
      });
    });

    request.on('error', (error) => finish(error));
    // Tính cả thời gian chờ socket trong Agent queue.
    timer = setTimeout(() => {
      const error = new Error('Bank request timed out');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    }, timeoutMs);
    request.end(body);
  });
}

function releaseReservation(payment) {
  if (payment.reserved) {
    reserved.set(payment.studentId, (reserved.get(payment.studentId) || 0) - payment.amount);
    payment.reserved = false;
  }
}

function markPaid(payment, chargeId) {
  if (payment.status !== 'PAID') {
    fees.set(payment.studentId, fees.get(payment.studentId) - payment.amount);
    releaseReservation(payment);
    payment.status = 'PAID';
    payment.chargeId = chargeId;
  }
}

function markFailed(payment) {
  payment.status = 'FAILED';
  releaseReservation(payment);
}

async function processPayment(payment) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let uncertain = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) break;

    try {
      const { statusCode, data } = await callBank(payment, Math.min(REQUEST_TIMEOUT_MS, left));
      if (statusCode === 201 && data.chargeId) {
        markPaid(payment, data.chargeId);
        return {
          code: 201,
          body: { paymentId: payment.id, status: 'PAID', chargeId: payment.chargeId,
            remainingDebt: fees.get(payment.studentId) }
        };
      }
      if ([400, 402, 409].includes(statusCode)) {
        markFailed(payment);
        return {
          code: statusCode,
          body: { error: data.error || 'Bank rejected the payment',
            paymentId: payment.id, status: 'FAILED' }
        };
      }
      // Lỗi 500/502/...: thử lại (tạm thời), không tạo paymentId mới.
      uncertain = true;
    } catch (error) {
      if (noConnectionCodes.has(error.code) && !uncertain) {
        markFailed(payment);
        return {
          code: 503,
          body: { error: 'Cannot connect to bank', paymentId: payment.id, status: 'FAILED' }
        };
      }
      // Timeout hoặc rớt khi đang chờ: có thể ngân hàng đã trừ tiền.
      uncertain = true;
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoff = attempt * 100;
      const remaining = deadline - Date.now();
      if (remaining <= backoff) break;
      await sleep(backoff);
    }
  }

  payment.status = 'PENDING';
  return {
    code: 504,
    body: { error: 'Bank result unknown; retry with the same paymentId',
      paymentId: payment.id, status: 'PENDING' }
  };
}

app.get('/students/:id/fees', (req, res) => {
  if (!fees.has(req.params.id)) return res.status(404).json({ error: 'Student not found' });
  return res.json({ studentId: req.params.id, debt: fees.get(req.params.id) });
});

app.post('/students/:id/payments', async (req, res) => {
  const paymentId = `P${++paymentSeq}`;
  const studentId = req.params.id;
  const amount = req.body?.amount;
  const error = (code, message) => res.status(code).json({
    error: message, paymentId, status: 'FAILED'
  });

  if (!fees.has(studentId)) return error(404, 'Student not found');
  if (!Number.isSafeInteger(amount) || amount <= 0) return error(400, 'Invalid amount');
  const availableDebt = fees.get(studentId) - (reserved.get(studentId) || 0);
  if (amount > availableDebt) return error(400, 'Amount exceeds available debt');

  const payment = { id: paymentId, studentId, amount, status: 'PROCESSING', reserved: true };
  payments.set(paymentId, payment);
  reserved.set(studentId, (reserved.get(studentId) || 0) + amount);

  const result = await processPayment(payment);
  return res.status(result.code).json(result.body);
});

// Bổ sung: xem lệnh và đối soát lại PENDING bằng CHÍNH Idempotency-Key cũ.
app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  return res.json({ paymentId: payment.id, status: payment.status,
    amount: payment.amount, chargeId: payment.chargeId || null });
});
app.post('/payments/:id/retry', async (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status === 'PAID') {
    return res.json({ paymentId: payment.id, status: 'PAID', chargeId: payment.chargeId });
  }
  if (payment.status !== 'PENDING') {
    return res.status(409).json({ error: 'Only PENDING payments can be retried',
      paymentId: payment.id, status: payment.status });
  }
  payment.status = 'PROCESSING';
  const result = await processPayment(payment);
  return res.status(result.code).json(result.body);
});

app.listen(PORT, () => {
  console.log(`Fee Service: http://localhost:${PORT}`);
  console.log(`BANK_URL=${BANK_URL}`);
});
