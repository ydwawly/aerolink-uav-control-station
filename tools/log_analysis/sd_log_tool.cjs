const fs = require('fs');
const path = require('path');
const { SerialLink } = require('../../electron/serial-link.cjs');
const { VehicleSession } = require('../../electron/vehicle-session.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function waitFor(predicate, timeoutMs, description) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${description} timeout`);
    await sleep(50);
  }
}

async function readLogList(session) {
  session.listLogs();
  await waitFor(() => session.logEntries.size > 0, 5000, 'log list');
  let previous = -1;
  let stableSince = Date.now();
  while (Date.now() - stableSince < 500) {
    if (session.logEntries.size !== previous) {
      previous = session.logEntries.size;
      stableSince = Date.now();
    }
    await sleep(50);
  }
  return [...session.logEntries.values()].sort((a, b) => a.id - b.id);
}

async function main() {
  const command = process.argv[2] || 'list';
  const port = option('port', 'COM11');
  const link = new SerialLink();
  const session = new VehicleSession(link, path.join(__dirname, 'tlogs'), { replay: true });
  session.on('error', error => process.stderr.write(`session: ${error.message}\n`));
  try {
    await link.open({ path: port, baudRate: 921600, autoReconnect: false });
    await waitFor(() => session.connected, 5000, 'heartbeat');
    const logs = await readLogList(session);
    if (command === 'list') {
      process.stdout.write(`${JSON.stringify(logs, null, 2)}\n`);
      return;
    }
    if (command !== 'window') throw new Error(`unknown command: ${command}`);
    const id = Number(option('id'));
    const offset = Number(option('offset'));
    const length = Number(option('length'));
    const output = path.resolve(option('output'));
    const listed = logs.find(entry => Number(entry.id) === id);
    if (!listed) throw new Error(`log ${id} not found`);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0)
      throw new Error('invalid offset/length');
    if (offset + length > Number(listed.size)) throw new Error(`range exceeds log size ${listed.size}`);

    fs.mkdirSync(path.dirname(output), { recursive: true });
    const partial = `${output}.partial`;
    const fd = fs.openSync(partial, 'w');
    fs.ftruncateSync(fd, offset);
    fs.closeSync(fd);
    const entry = { ...listed, size: offset + length };
    let lastShown = 0;
    session.on('logProgress', progress => {
      const received = progress.received - offset;
      if (received - lastShown >= 65536 || received >= length) {
        lastShown = received;
        process.stderr.write(`download ${Math.max(0, received)}/${length}\n`);
      }
    });
    await session.downloadLog(entry, partial);
    const source = fs.openSync(partial, 'r');
    const compact = Buffer.alloc(length);
    let done = 0;
    while (done < compact.length) {
      const count = fs.readSync(source, compact, done, compact.length - done, offset + done);
      if (!count) throw new Error(`short read at ${done}`);
      done += count;
    }
    fs.closeSync(source);
    fs.writeFileSync(output, compact);
    fs.unlinkSync(partial);
    fs.writeFileSync(`${output}.json`, JSON.stringify({ id, sourceSize: listed.size, offset, length }, null, 2));
    process.stdout.write(`${JSON.stringify({ id, sourceSize: listed.size, offset, length, output }, null, 2)}\n`);
  } finally {
    session.dispose();
    await link.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
