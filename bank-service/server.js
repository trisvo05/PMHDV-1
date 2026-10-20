require('dotenv').config();
const express = require('express');
const http = require('node:http');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 0));
const FAIL_RATE = Math.min(1, Math.max(0, Number(process.env.FAIL_RATE || 0)));
const DROP_RATE = Math.min(1, Math.max(0, Number(process.env.DROP_RATE || 0)));
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const byKey = new Map(); // Idempotency-Key -> giao dịch đã trừ tiền
const byReference = new Map(); // reference -> giao dịch đã trừ tiền
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get('/stats', (req, res) => res.json(stats));

app.post('/charges', async (req, res) => {
  stats.requests++;
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');

  if (!key || typeof reference !== 'string' || !reference.trim() ||
      !Number.isSafeInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid reference, amount or Idempotency-Key' });
  }

  // Cùng khóa + cùng nội dung: trả kết quả cũ, KHÔNG trừ thêm.
  const saved = byKey.get(key);
  if (saved) {
    if (saved.reference !== reference || saved.amount !== amount) {
      return res.status(409).json({ error: 'Idempotency-Key reused with different data' });
    }
    return res.status(201).json(saved);
  }
  // Chặn trừ lại cùng reference kể cả khi client đổi khóa.
  if (byReference.has(reference)) {
    return res.status(409).json({ error: 'Reference was already charged' });
  }
  if (amount > LIMIT) {
    return res.status(402).json({ error: 'Bank limit exceeded (20,000,000 VND)' });
  }

  if (DELAY_MS > 0) await sleep(DELAY_MS);

  // Re-check sau await: hai yêu cầu trùng có thể cùng đang chờ DELAY_MS.
  const afterDelay = byKey.get(key);
  if (afterDelay) {
    if (afterDelay.reference !== reference || afterDelay.amount !== amount) {
      return res.status(409).json({ error: 'Idempotency-Key reused with different data' });
    }
    return res.status(201).json(afterDelay);
  }
  if (byReference.has(reference)) {
    return res.status(409).json({ error: 'Reference was already charged' });
  }

  // Lỗi 500 xảy ra TRƯỚC khi trừ tiền.
  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'Temporary bank error' });
  }

  const charge = { chargeId: `C${stats.charges + 1}`, reference, amount };
  byKey.set(key, charge);
  byReference.set(reference, charge);
  stats.charges++;
  // Không hề thực hiện lần trừ thứ hai => duplicates luôn = 0.

  // Đã trừ tiền nhưng mất phản hồi: client bắt buộc dùng lại cùng khóa để retry.
  if (Math.random() < DROP_RATE) {
    console.log(`[DROP] Charged ${reference} but dropped connection`);
    req.socket.destroy();
    return;
  }

  return res.status(201).json(charge);
});

const server = http.createServer(app);
server.keepAliveTimeout = 5_000;
// Node phiên bản mới có buffer phụ: tắt để đúng idle timeout 5 giây.
if ('keepAliveTimeoutBuffer' in server) server.keepAliveTimeoutBuffer = 0;
server.headersTimeout = 10_000;
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[TCP] New connection #${stats.connections}`);
  socket.on('error', () => {}); // socket bị drop: không làm sập process
});

server.listen(PORT, () => {
  console.log(`Bank Service: http://localhost:${PORT}`);
  console.log({ DELAY_MS, FAIL_RATE, DROP_RATE });
});
