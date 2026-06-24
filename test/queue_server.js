import assert from 'assert/strict';
import http from 'http';
import net from 'net';
import {tmpdir} from 'os';
import path from 'path';
import {mkdtemp, readFile, rm, writeFile} from 'fs/promises';

import QueueServer from '../src/queue_server.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => {
          const isJson = res.headers['content-type']?.includes('application/json');
          resolve({
            status: res.statusCode,
            text,
            json: isJson ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const queueDir = await mkdtemp(path.join(tmpdir(), 'airfreyr-queue-test-'));
  const queueFile = path.join(queueDir, 'kids.txt');
  let server;

  try {
    await writeFile(
      queueFile,
      ['Kids,Artist,Title,https://example.com/active # note', '# Kids,Disabled,Old,https://example.com/disabled', ''].join('\n'),
      'utf8',
    );
    await writeFile(path.join(queueDir, 'ignored.md'), '# not a queue', 'utf8');

    const port = await freePort();
    server = new QueueServer({
      hostname: '127.0.0.1',
      port,
      queueDir,
      projectConfig: {},
    });
    await server.start();

    const root = await request(port, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.text, /AirFreyr Queues/);
    assert.match(root.text, /id="version"/);

    const lists = await request(port, 'GET', '/api/lists');
    assert.equal(lists.status, 200);
    assert.equal(lists.json.ok, true);
    assert.equal(typeof lists.json.version, 'string');
    assert.deepEqual(lists.json.lists, [
      {
        file: 'kids.txt',
        filePath: queueFile,
        total: 2,
        active: 1,
        disabled: 1,
      },
    ]);

    const list = await request(port, 'GET', '/api/list?file=kids.txt');
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 2);
    assert.equal(list.json.entries[0].line, 1);
    assert.equal(list.json.entries[0].genre, 'Kids');
    assert.equal(list.json.entries[0].artist, 'Artist');
    assert.equal(list.json.entries[0].title, 'Title');
    assert.equal(list.json.entries[0].note, 'note');
    assert.equal(list.json.entries[1].disabled, true);

    const traversal = await request(port, 'GET', '/api/list?file=../kids.txt');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.json.ok, false);

    const disabled = await request(port, 'POST', '/api/list/item', {
      file: 'kids.txt',
      line: 1,
      action: 'disable',
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.active, 0);
    assert.equal(disabled.json.disabled, 2);
    assert.match(await readFile(queueFile, 'utf8'), /^# Kids,Artist,Title/);

    const deleted = await request(port, 'POST', '/api/list/item', {
      file: 'kids.txt',
      line: 2,
      action: 'delete',
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.entries.length, 1);
    assert.doesNotMatch(await readFile(queueFile, 'utf8'), /Disabled/);

    const invalidAction = await request(port, 'POST', '/api/list/item', {
      file: 'kids.txt',
      line: 1,
      action: 'enable',
    });
    assert.equal(invalidAction.status, 400);
    assert.equal(invalidAction.json.ok, false);

    const created = await request(port, 'POST', '/api/list', {file: 'new-list.txt'});
    assert.equal(created.status, 201);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.file, 'new-list.txt');
    assert.equal(created.json.total, 0);
    assert.equal(await readFile(path.join(queueDir, 'new-list.txt'), 'utf8'), '');

    const duplicate = await request(port, 'POST', '/api/list', {file: 'new-list.txt'});
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.json.ok, false);
  } finally {
    if (server) await server.stop();
    await rm(queueDir, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
