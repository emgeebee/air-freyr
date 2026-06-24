import assert from 'assert/strict';
import http from 'http';
import net from 'net';
import {tmpdir} from 'os';
import path from 'path';
import {mkdtemp, readFile, rm, writeFile} from 'fs/promises';

import QueueServer, {fixDuplicateFilenameCsvField, genreFromQueueFile} from '../src/queue_server.js';

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
  assert.equal(genreFromQueueFile('pop.txt'), 'Pop');
  assert.equal(genreFromQueueFile('folk rock.txt'), 'Folk Rock');
  assert.equal(genreFromQueueFile('folk-rock.txt'), 'Folk Rock');
  assert.deepEqual(
    fixDuplicateFilenameCsvField(
      'pop,Dance,Foster the People,https://example.com/track # pumped up kicks',
      'pop',
    ),
    {
      line: 'Dance,Foster the People,https://example.com/track # pumped up kicks',
      changed: true,
    },
  );
  assert.deepEqual(
    fixDuplicateFilenameCsvField(
      "Dance,The Weekend,Can't Feel My Face,https://example.com/track",
      'pop',
    ),
    {
      line: "Dance,The Weekend,Can't Feel My Face,https://example.com/track",
      changed: false,
    },
  );
  assert.deepEqual(
    fixDuplicateFilenameCsvField('# pop,Dance,Foster the People,https://example.com/track', 'pop'),
    {
      line: '# Dance,Foster the People,https://example.com/track',
      changed: true,
    },
  );

  const sanitizeDir = await mkdtemp(path.join(tmpdir(), 'airfreyr-sanitize-test-'));
  const sanitizedFile = path.join(sanitizeDir, 'pop.txt');
  try {
    await writeFile(
      sanitizedFile,
      'pop,Dance,Foster the People,https://example.com/track\n',
      'utf8',
    );
    const sanitizeServer = new QueueServer({
      hostname: '127.0.0.1',
      port: await freePort(),
      queueDir: sanitizeDir,
      projectConfig: {},
    });
    await sanitizeServer.start();
    assert.equal(
      await readFile(sanitizedFile, 'utf8'),
      'Dance,Foster the People,https://example.com/track\n',
    );
    await sanitizeServer.stop();
  } finally {
    await rm(sanitizeDir, {recursive: true, force: true});
  }

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
    assert.match(root.text, /id="add-song"/);
    assert.match(root.text, /id="paste-lines"/);
    assert.match(root.text, /id="rename-list"/);

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

    const bulk = await request(port, 'POST', '/api/list/lines', {
      file: 'kids.txt',
      lines: [
        'Dance,LMFAO,https://www.youtube.com/watch?v=wyx6JDQCslE',
        '# Kids,Disabled,Old,https://example.com/disabled',
        '',
        'Kids,Moana,Welcome,https://example.com/welcome',
      ].join('\n'),
    });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.json.ok, true);
    assert.equal(bulk.json.added, 3);
    const bulkFile = await readFile(queueFile, 'utf8');
    assert.match(bulkFile, /Kids,Dance,LMFAO/);
    assert.match(bulkFile, /^# Kids,Disabled,Old/m);
    assert.match(bulkFile, /Kids,Moana,Welcome/);

    const added = await request(port, 'POST', '/add', {
      file: 'kids.txt',
      artist: 'Artist',
      title: 'Song',
      path: 'https://example.com/new-track',
    });
    assert.equal(added.status, 201);
    assert.match(await readFile(queueFile, 'utf8'), /Kids,Artist,Song,https:\/\/example.com\/new-track/);

    const bulkInvalid = await request(port, 'POST', '/api/list/lines', {
      file: 'kids.txt',
      lines: 'Not,a,valid,line',
    });
    assert.equal(bulkInvalid.status, 400);
    assert.equal(bulkInvalid.json.ok, false);

    const renamed = await request(port, 'POST', '/api/list/rename', {
      file: 'kids.txt',
      newFile: 'folk rock.txt',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.ok, true);
    assert.equal(renamed.json.from, 'kids.txt');
    assert.equal(renamed.json.file, 'folk rock.txt');
    const renamedPath = path.join(queueDir, 'folk rock.txt');
    assert.match(await readFile(renamedPath, 'utf8'), /Kids,Artist/);

    const renameMissing = await request(port, 'POST', '/api/list/rename', {
      file: 'kids.txt',
      newFile: 'missing.txt',
    });
    assert.equal(renameMissing.status, 400);
    assert.equal(renameMissing.json.ok, false);
  } finally {
    if (server) await server.stop();
    await rm(queueDir, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
