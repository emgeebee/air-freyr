import assert from 'assert/strict';
import http from 'http';
import net from 'net';
import {tmpdir} from 'os';
import path from 'path';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'fs/promises';

import QueueServer, {genreFromQueueFile} from '../src/queue_server.js';
import {
  importCsvText,
  parseQueueDocument,
  serializeQueueDocument,
} from '../src/queue_format.js';

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
  assert.equal(genreFromQueueFile('pop.json'), 'Pop');
  assert.equal(genreFromQueueFile('kids.json'), 'Kids');
  assert.equal(genreFromQueueFile('folk rock.json'), 'Folk Rock');
  assert.equal(genreFromQueueFile('folk-rock.json'), 'Folk Rock');

  const migrateDir = await mkdtemp(path.join(tmpdir(), 'airfreyr-migrate-test-'));
  const migrateTxt = path.join(migrateDir, 'pop.txt');
  const migrateJson = path.join(migrateDir, 'pop.json');
  try {
    await writeFile(
      migrateTxt,
      'The Automatic,Monster,https://example.com/track\n',
      'utf8',
    );
    const migrateServer = new QueueServer({
      hostname: '127.0.0.1',
      port: await freePort(),
      queueDir: migrateDir,
      projectConfig: {},
    });
    await migrateServer.start();
    const migrated = parseQueueDocument(await readFile(migrateJson, 'utf8'));
    assert.equal(migrated.entries.length, 1);
    assert.equal(migrated.entries[0].artist, 'The Automatic');
    assert.equal(migrated.entries[0].title, 'Monster');
    await migrateServer.stop();
  } finally {
    await rm(migrateDir, {recursive: true, force: true});
  }

  const queueDir = await mkdtemp(path.join(tmpdir(), 'airfreyr-queue-test-'));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'airfreyr-output-test-'));
  const mirrorOne = await mkdtemp(path.join(tmpdir(), 'airfreyr-mirror-one-test-'));
  const mirrorTwo = await mkdtemp(path.join(tmpdir(), 'airfreyr-mirror-two-test-'));
  const queueFile = path.join(queueDir, 'kids.json');
  let server;

  try {
    const initialDocument = {
      entries: [
        {
          artist: 'Artist',
          title: 'Title',
          url: 'https://example.com/active',
          note: 'note',
        },
        {
          artist: 'Disabled',
          title: 'Old',
          url: 'https://example.com/disabled',
          disabled: true,
        },
      ],
    };
    await writeFile(queueFile, serializeQueueDocument(initialDocument), 'utf8');
    await writeFile(path.join(queueDir, 'ignored.md'), '# not a queue', 'utf8');
    const downloadPath = path.join(outputDir, 'Kids', 'Artist - Title.mp3');
    const mirrorPath = path.join(mirrorOne, 'Kids', 'Compilations', 'YouTube', 'Artist - Title.mp3');
    await mkdir(path.dirname(downloadPath), {recursive: true});
    await mkdir(path.dirname(mirrorPath), {recursive: true});
    await writeFile(downloadPath, 'downloaded', 'utf8');
    await writeFile(mirrorPath, 'mirrored', 'utf8');

    const port = await freePort();
    server = new QueueServer({
      hostname: '127.0.0.1',
      port,
      queueDir,
      outputDir,
      projectConfig: {
        dirs: {
          mirror: [mirrorOne, mirrorTwo],
        },
      },
    });
    await server.start();

    const root = await request(port, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.text, /AirFreyr Queues/);
    assert.match(root.text, /id="version"/);
    assert.match(root.text, /id="add-song"/);
    assert.match(root.text, /id="paste-lines"/);
    assert.match(root.text, /id="rename-list"/);
    assert.match(root.text, /\.split\(\/\[\\s_-\]\+\/\)/);
    assert.doesNotMatch(root.text, /\.split\(\/\[s_-\]\+\/\)/);
    assert.match(root.text, /link\.target = '_blank'/);
    assert.match(root.text, /renderFileLocations/);
    assert.doesNotMatch(root.text, /Delete line/);

    const lists = await request(port, 'GET', '/api/lists');
    assert.equal(lists.status, 200);
    assert.equal(lists.json.ok, true);
    assert.equal(typeof lists.json.version, 'string');
    assert.deepEqual(lists.json.lists, [
      {
        file: 'kids.json',
        filePath: queueFile,
        total: 2,
        active: 1,
        disabled: 1,
      },
    ]);

    const list = await request(port, 'GET', '/api/list?file=kids.json');
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 2);
    assert.equal(list.json.entries[0].line, 1);
    assert.equal(list.json.entries[0].genre, 'Kids');
    assert.equal(list.json.entries[0].artist, 'Artist');
    assert.equal(list.json.entries[0].title, 'Title');
    assert.equal(list.json.entries[0].note, 'note');
    assert.deepEqual(list.json.entries[0].files, [
      {
        type: 'download',
        label: 'Download',
        root: outputDir,
        path: downloadPath,
        configured: true,
        exists: true,
      },
      {
        type: 'mirror',
        label: 'Mirror 1',
        root: mirrorOne,
        path: mirrorPath,
        configured: true,
        exists: true,
      },
      {
        type: 'mirror',
        label: 'Mirror 2',
        root: mirrorTwo,
        path: path.join(mirrorTwo, 'Kids', 'Compilations', 'YouTube', 'Artist - Title.mp3'),
        configured: true,
        exists: false,
      },
    ]);
    assert.equal(list.json.entries[1].disabled, true);

    const status = await request(port, 'GET', '/status?file=kids.json');
    assert.equal(status.status, 200);
    assert.equal(status.json.files[0].label, 'Artist - Title');
    assert.equal(status.json.files[0].files[0].exists, true);
    assert.equal(status.json.files[0].files[1].exists, true);
    assert.equal(status.json.files[0].files[2].exists, false);

    const traversal = await request(port, 'GET', '/api/list?file=../kids.json');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.json.ok, false);

    const retry = await request(port, 'POST', '/api/list/item/retry', {
      file: 'kids.json',
      line: 1,
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.ok, true);
    assert.equal(retry.json.line, 1);

    const disabled = await request(port, 'POST', '/api/list/item', {
      file: 'kids.json',
      line: 1,
      action: 'disable',
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.active, 0);
    assert.equal(disabled.json.disabled, 2);
    const afterDisable = parseQueueDocument(await readFile(queueFile, 'utf8'));
    assert.equal(afterDisable.entries[0].disabled, true);

    const deleted = await request(port, 'POST', '/api/list/item', {
      file: 'kids.json',
      line: 2,
      action: 'delete',
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.entries.length, 1);
    const afterDelete = parseQueueDocument(await readFile(queueFile, 'utf8'));
    assert.equal(afterDelete.entries.length, 1);
    assert.doesNotMatch(afterDelete.entries[0].artist, /Disabled/);

    const invalidAction = await request(port, 'POST', '/api/list/item', {
      file: 'kids.json',
      line: 1,
      action: 'enable',
    });
    assert.equal(invalidAction.status, 400);
    assert.equal(invalidAction.json.ok, false);

    const created = await request(port, 'POST', '/api/list', {file: 'new-list.json'});
    assert.equal(created.status, 201);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.file, 'new-list.json');
    assert.equal(created.json.total, 0);
    assert.deepEqual(parseQueueDocument(await readFile(path.join(queueDir, 'new-list.json'), 'utf8')), {
      entries: [],
    });

    const duplicate = await request(port, 'POST', '/api/list', {file: 'new-list.json'});
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.json.ok, false);

    const bulk = await request(port, 'POST', '/api/list/lines', {
      file: 'kids.json',
      lines: [
        'LMFAO,Sexy And I Know It,https://www.youtube.com/watch?v=wyx6JDQCslE',
        '# Disabled,Old,https://example.com/disabled',
        '',
        'Moana,Welcome,https://example.com/welcome',
      ].join('\n'),
    });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.json.ok, true);
    assert.equal(bulk.json.added, 3);
    const bulkDocument = parseQueueDocument(await readFile(queueFile, 'utf8'));
    assert.equal(bulkDocument.entries.length, 4);
    assert.equal(bulkDocument.entries[1].artist, 'LMFAO');
    assert.equal(bulkDocument.entries[2].disabled, true);
    assert.equal(bulkDocument.entries[3].artist, 'Moana');

    const added = await request(port, 'POST', '/add', {
      file: 'kids.json',
      artist: 'Artist',
      title: 'Song',
      path: 'https://example.com/new-track',
    });
    assert.equal(added.status, 201);
    const afterAdd = parseQueueDocument(await readFile(queueFile, 'utf8'));
    assert.equal(afterAdd.entries.at(-1).artist, 'Artist');
    assert.equal(afterAdd.entries.at(-1).title, 'Song');
    assert.equal(afterAdd.entries.at(-1).url, 'https://example.com/new-track');

    const bulkInvalid = await request(port, 'POST', '/api/list/lines', {
      file: 'kids.json',
      lines: 'Not,a,valid,line',
    });
    assert.equal(bulkInvalid.status, 400);
    assert.equal(bulkInvalid.json.ok, false);

    const renamed = await request(port, 'POST', '/api/list/rename', {
      file: 'kids.json',
      newFile: 'folk rock.json',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.ok, true);
    assert.equal(renamed.json.from, 'kids.json');
    assert.equal(renamed.json.file, 'folk rock.json');
    const renamedPath = path.join(queueDir, 'folk rock.json');
    assert.equal(
      parseQueueDocument(await readFile(renamedPath, 'utf8')).entries.length,
      5,
    );

    const renameMissing = await request(port, 'POST', '/api/list/rename', {
      file: 'kids.json',
      newFile: 'missing.json',
    });
    assert.equal(renameMissing.status, 400);
    assert.equal(renameMissing.json.ok, false);

    const retryMissing = await request(port, 'POST', '/api/list/item/retry', {
      file: 'folk rock.json',
      line: 999,
    });
    assert.equal(retryMissing.status, 400);
    assert.equal(retryMissing.json.ok, false);

    const imported = importCsvText(
      'LMFAO,Sexy And I Know It,https://example.com/track',
      'pop.json',
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0].artist, 'LMFAO');
    assert.equal(imported[0].title, 'Sexy And I Know It');
  } finally {
    if (server) await server.stop();
    await rm(queueDir, {recursive: true, force: true});
    await rm(outputDir, {recursive: true, force: true});
    await rm(mirrorOne, {recursive: true, force: true});
    await rm(mirrorTwo, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
