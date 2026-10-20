// Node >= 18: sử dụng fetch có sẵn, không cần cài package test.
const FEE_URL = process.env.FEE_URL || 'http://localhost:4001';
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const COUNT = Math.max(1, Number(process.env.COUNT || 200));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 10));
const AMOUNT = Number(process.env.AMOUNT || 1_000);
const student = process.env.STUDENT_ID || '1';

async function stats() {
  try {
    const response = await fetch(`${BANK_URL}/stats`);
    return await response.json();
  } catch {
    return null;
  }
}

(async () => {
  const before = await stats();
  const statuses = {};
  const timings = [];
  let cursor = 0;
  const started = performance.now();

  async function worker() {
    while (cursor < COUNT) {
      cursor++;
      const begin = performance.now();
      try {
        const response = await fetch(`${FEE_URL}/students/${student}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: AMOUNT })
        });
        const data = await response.json();
        const key = `${response.status} ${data.status || 'UNKNOWN'}`;
        statuses[key] = (statuses[key] || 0) + 1;
      } catch {
        statuses.NETWORK_ERROR = (statuses.NETWORK_ERROR || 0) + 1;
      }
      timings.push(performance.now() - begin);
    }
  }

  // Đo tốc độ GET khi các POST đang thực hiện (hữu ích cho tình huống 2).
  const workers = Array.from({ length: Math.min(COUNT, CONCURRENCY) }, worker);
  const running = Promise.all(workers);
  if (process.env.MEASURE_FEES === '1') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = performance.now();
    const response = await fetch(`${FEE_URL}/students/${student}/fees`);
    console.log(`GET fees khi tải cao: ${response.status}, ${(performance.now() - t0).toFixed(1)}ms`);
  }
  await running;

  const after = await stats();
  const totalMs = performance.now() - started;
  console.log('\n--- LOAD TEST ---');
  console.log({ COUNT, CONCURRENCY, AMOUNT, totalMs: Math.round(totalMs),
    avgMs: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
    maxMs: Math.round(Math.max(...timings)), statuses });
  if (before && after) {
    console.log('Bank before:', before);
    console.log('Bank after: ', after);
    console.log('Bank delta: ', Object.fromEntries(
      Object.keys(after).map((key) => [key, after[key] - before[key]])
    ));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
