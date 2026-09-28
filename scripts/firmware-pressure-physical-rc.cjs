const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { SerialLink } = require('../electron/serial-link.cjs');
const { VehicleSession, mavlink20, uint64Pair } = require('../electron/vehicle-session.cjs');

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const portPath = argument('port') || 'COM11';
const durationSeconds = Math.max(5, Number(argument('seconds') || 60));
const logRoot = path.join(__dirname, '../artifacts/pressure-test-physical-rc');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const monoUs = () => Math.round(performance.now() * 1000);

async function waitFor(session, event, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const listener = value => {
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.off(event, listener);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${event} 超时`));
    }, timeoutMs);
    session.on(event, listener);
  });
}

async function main() {
  fs.mkdirSync(logRoot, { recursive: true });
  const link = new SerialLink();
  const session = new VehicleSession(link, logRoot);
  const errors = [];
  let latestLogs = [];
  let rcTimer = null;
  let pingTimer = null;
  let timeSyncTimer = null;
  let hilTimer = null;
  let reportTimer = null;
  let pingSequence = 0;
  let downloadedLog = null;
  let pressureStartedAt = 0;

  session.on('error', error => errors.push({ time: Date.now(), message: error.message }));
  session.on('logs', logs => { latestLogs = logs; });

  const stopTimers = () => {
    for (const timer of [rcTimer, pingTimer, timeSyncTimer, hilTimer, reportTimer]) {
      if (timer) clearInterval(timer);
    }
  };

  try {
    await link.open({ path: portPath, baudRate: 921600, autoReconnect: false });
    if (!session.connected) await waitFor(session, 'heartbeat', () => true, 10000);

    session.listLogs();
    await delay(2500);
    const candidate = [...latestLogs]
      .filter(entry => entry.size > 1024)
      .sort((a, b) => b.size - a.size)[0];

    /* 保持 MAVLink RC 输入流，但始终请求上锁；实体 SBUS 仍在飞控侧最后发布并拥有优先权。 */
    const safeChannels = [1500, 1500, 1000, 1500, 1000, 1000, 1000, 1000];
    rcTimer = setInterval(() => {
      session.sendRcOverride(safeChannels)
        .catch(error => errors.push({ time: Date.now(), message: error.message }));
    }, 40);

    pressureStartedAt = Date.now();
    pingTimer = setInterval(() => {
      pingSequence = (pingSequence + 1) >>> 0;
      session.send(new mavlink20.messages.ping(uint64Pair(monoUs()), pingSequence, 0, 0), 0)
        .catch(error => errors.push({ time: Date.now(), message: error.message }));
    }, 1);
    timeSyncTimer = setInterval(() => {
      session.send(new mavlink20.messages.timesync(uint64Pair(0), uint64Pair(monoUs())), 1)
        .catch(error => errors.push({ time: Date.now(), message: error.message }));
    }, 2);
    hilTimer = setInterval(() => {
      session.sendHilSensor({
        timeUsec: monoUs(), xacc: 0, yacc: 0, zacc: -9.80665, xgyro: 0,
        xmag: 0.22, ymag: 0, zmag: 0.43, absPressure: 1013.25, temperature: 25
      }).catch(error => errors.push({ time: Date.now(), message: error.message }));
    }, 2);

    let downloadPromise = null;
    if (candidate) {
      const destination = path.join(logRoot, `pressure-download-${candidate.id}-${Date.now()}.bin`);
      downloadPromise = session.downloadLog(candidate, destination)
        .then(result => { downloadedLog = { id: candidate.id, ...result }; })
        .catch(error => errors.push({ time: Date.now(), message: `日志下载：${error.message}` }));
    }

    reportTimer = setInterval(() => {
      const stats = session.linkStats();
      console.log(JSON.stringify({
        elapsedSeconds: Math.round((Date.now() - pressureStartedAt) / 1000),
        armed: session.telemetry.armed,
        rxBytes: stats.rxBytes,
        txBytes: stats.txBytes,
        rxPackets: stats.rxPackets,
        lostPackets: stats.lostPackets,
        txQueueBytes: stats.txQueueBytes,
        droppedTx: stats.droppedTx
      }));
    }, 5000);

    await delay(durationSeconds * 1000);
    if (session.download) session.cancelDownload('物理遥控器压力测试到时，主动结束下载');
    if (downloadPromise) await Promise.race([downloadPromise, delay(500)]);

    const result = {
      port: portPath,
      durationSeconds,
      startedAt: new Date(pressureStartedAt).toISOString(),
      endedAt: new Date().toISOString(),
      physicalRcConnected: true,
      telemetry: session.telemetry,
      link: session.linkStats(),
      candidateLog: candidate || null,
      downloadedLog,
      errors: errors.slice(-50)
    };
    const resultPath = path.join(logRoot, `pressure-result-${Date.now()}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, resultPath }, null, 2));
  } finally {
    stopTimers();
    try { await session.sendRcOverride([], true); } catch {}
    await delay(150);
    session.dispose();
    await link.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
