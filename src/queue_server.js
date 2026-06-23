import { spawn } from 'child_process';
import { readFileSync, constants as fsConstants } from 'fs';
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import cors from 'cors';
import express from 'express';

const PACKAGE_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI_PATH = path.join(PACKAGE_ROOT, 'cli.js');
const DEFAULT_CONF_PATH = path.join(PACKAGE_ROOT, 'conf.json');
const VERSION = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version;

function stripAnsi(text) {
  const escapeChar = String.fromCharCode(27);
  return text.replace(new RegExp(`${escapeChar}\\[[0-9;]*m`, 'g'), '');
}

function tailLines(text, count = 4) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' | ');
}

async function assertReadable(filePath, label) {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`${label} not readable: ${filePath}`);
  }
}

function apiJson(body) {
  return {version: VERSION, ...body};
}

function apiError(res, err) {
  res.status(400).json(apiJson({ok: false, error: err.message}));
}

export async function loadProjectConfig(configPath = DEFAULT_CONF_PATH) {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export function resolveServeConfig(opts = {}, projectConfig = {}) {
  const serve = projectConfig.serve || {};
  const dirs = projectConfig.dirs || {};
  const port =
    opts.port ??
    (process.env.AIRFREYR_PORT ? parseInt(process.env.AIRFREYR_PORT, 10) : undefined) ??
    serve.port ??
    3797;
  const queueDir =
    opts.queueDir ||
    opts.dataDir ||
    process.env.AIRFREYR_QUEUE_DIR ||
    serve.queueDir ||
    process.cwd();
  const outputDir =
    opts.outputDir ||
    process.env.AIRFREYR_OUTPUT_DIR ||
    dirs.output ||
    null;
  return {
    hostname:
      opts.hostname || process.env.AIRFREYR_HOSTNAME || serve.hostname || 'localhost',
    port,
    queueDir,
    outputDir,
    config: opts.config || null,
    extraCliArgs: opts.extraCliArgs || [],
  };
}

function escapeCsvField(field) {
  if (field == null) return '';
  const value = String(field);
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function formatBatchCsvLine({genre, artist, title, path: url}) {
  const fields = [genre, artist];
  if (title) fields.push(title);
  fields.push(url);
  return `${fields.map(escapeCsvField).join(',')}\n`;
}

function resolveQueueFile(dataDir, file) {
  if (!file || typeof file !== 'string') throw new Error('`file` is required');
  const base = path.resolve(dataDir);
  const resolved = path.resolve(base, file);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
    throw new Error('`file` must resolve within the data directory');
  if (!resolved.endsWith('.txt')) throw new Error('`file` must be a .txt queue file');
  return resolved;
}

function parseCsvLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function splitEditableLines(text) {
  const trailingNewline = /\r?\n$/.test(text);
  const lines = text ? text.split(/\r?\n/) : [];
  if (trailingNewline) lines.pop();
  return {
    lines,
    newline: text.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline,
  };
}

function joinEditableLines(lines, newline, trailingNewline) {
  if (lines.length === 0) return '';
  return `${lines.join(newline)}${trailingNewline ? newline : ''}`;
}

function parseQueueEntry(rawLine, index) {
  const raw = rawLine.trim();
  if (!raw) return null;

  const disabled = /^\s*#/.test(rawLine);
  const body = disabled ? rawLine.replace(/^\s*#\s?/, '') : rawLine;
  const note = (body.match(/#(.*)$/) || [])[1]?.trim() || '';
  const content = body.replace(/#.*$/, '').trim();
  const parts = parseCsvLine(content);
  const urlIndex = parts.findIndex(part => /^https?:\/\//i.test(part));
  const fields = urlIndex >= 0 ? parts.slice(0, urlIndex) : [];
  const url = urlIndex >= 0 ? parts.slice(urlIndex).join(',').trim() : content;
  const [genre, artist, title] = fields;
  const label = [artist, title].filter(Boolean).join(' - ') || title || url || raw;

  return {
    line: index + 1,
    disabled,
    genre: genre || '',
    artist: artist || '',
    title: title || '',
    url: url || '',
    note,
    label,
    raw,
  };
}

async function readQueueEntries(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line, index) => parseQueueEntry(line, index))
    .filter(Boolean);
}

function summarizeEntries(entries) {
  return {
    total: entries.length,
    active: entries.filter(entry => !entry.disabled).length,
    disabled: entries.filter(entry => entry.disabled).length,
  };
}

async function listQueueFiles(dataDir) {
  let dirents;
  try {
    dirents = await readdir(dataDir, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return Promise.all(
    dirents
      .filter(dirent => dirent.isFile() && dirent.name.endsWith('.txt'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async dirent => {
        const filePath = resolveQueueFile(dataDir, dirent.name);
        const entries = await readQueueEntries(filePath);
        return {
          file: dirent.name,
          filePath,
          ...summarizeEntries(entries),
        };
      }),
  );
}

async function readQueueFile(dataDir, file) {
  const filePath = resolveQueueFile(dataDir, file);
  const entries = await readQueueEntries(filePath);
  return {
    file,
    filePath,
    entries,
    ...summarizeEntries(entries),
  };
}

async function updateQueueFileItem(dataDir, file, line, action) {
  const filePath = resolveQueueFile(dataDir, file);
  const lineNumber = Number.parseInt(line, 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('`line` must be a positive integer');
  if (!['disable', 'delete'].includes(action)) throw new Error('`action` must be "disable" or "delete"');

  const text = await readFile(filePath, 'utf8');
  const {lines, newline, trailingNewline} = splitEditableLines(text);
  const index = lineNumber - 1;
  if (index >= lines.length) throw new Error('`line` does not exist in the selected file');
  if (!lines[index].trim()) throw new Error('`line` must reference a song entry');

  if (action === 'disable') {
    if (!/^\s*#/.test(lines[index])) {
      const [, indent, body] = lines[index].match(/^(\s*)(.*)$/);
      lines[index] = `${indent}# ${body}`;
    }
  } else {
    lines.splice(index, 1);
  }

  await writeFile(filePath, joinEditableLines(lines, newline, trailingNewline), 'utf8');
  return readQueueFile(dataDir, file);
}

function normalizeAddPayload(body) {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const {file, genre, artist, title} = body;
  const url = body.path ?? body.url;
  if (!file) throw new Error('`file` is required');
  if (!genre) throw new Error('`genre` is required');
  if (!artist) throw new Error('`artist` is required');
  if (!url) throw new Error('`path` is required');
  if (!/^https?:\/\//i.test(url)) throw new Error('`path` must be an http(s) URL');
  return {file, genre, artist, title: title || '', path: url};
}

class FileDownloadScheduler {
  #state = new Map();

  schedule(filePath, runner) {
    const state = this.#state.get(filePath) || {
      running: false,
      pending: false,
      lastError: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastExitCode: null,
    };
    this.#state.set(filePath, state);
    if (state.running) {
      state.pending = true;
      return;
    }
    this.#run(filePath, runner, state);
  }

  getStatus(filePath) {
    return (
      this.#state.get(filePath) || {
        running: false,
        pending: false,
        lastError: null,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastExitCode: null,
      }
    );
  }

  setExitCode(filePath, code) {
    const state = this.#state.get(filePath);
    if (state) state.lastExitCode = code;
  }

  #run(filePath, runner, state) {
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    state.lastError = null;
    state.lastExitCode = null;
    runner(filePath)
      .catch(err => {
        state.lastError = err.message;
        console.error(`[airfreyr serve] download failed for ${filePath}: ${err.message}`);
      })
      .finally(() => {
        state.running = false;
        state.lastFinishedAt = new Date().toISOString();
        if (state.pending) {
          state.pending = false;
          this.#run(filePath, runner, state);
        }
      });
  }
}

function queueUiHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AirFreyr Queues</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101827;
      --panel: #172033;
      --panel-soft: #1f2b43;
      --text: #f5f7fb;
      --muted: #9ca8bd;
      --accent: #4dd599;
      --danger: #ff6b6b;
      --border: #2c3a55;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #1b5b76 0, transparent 32rem), var(--bg);
      color: var(--text);
      font-family: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }
    h1, h2, p { margin-top: 0; }
    h1 { margin-bottom: 6px; }
    p { color: var(--muted); }
    button {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 9px 12px;
      background: var(--panel-soft);
      color: var(--text);
      cursor: pointer;
      font: inherit;
    }
    button:hover { border-color: var(--accent); }
    button.danger:hover { border-color: var(--danger); color: #ffd7d7; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .layout {
      display: grid;
      grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
      gap: 18px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(23, 32, 51, 0.92);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px;
      border-bottom: 1px solid var(--border);
    }
    .panel-head h2 { margin: 0; font-size: 1rem; }
    .list-button {
      display: block;
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
      padding: 14px 18px;
      background: transparent;
      text-align: left;
    }
    .list-button.active { background: rgba(77, 213, 153, 0.12); }
    .list-button strong { display: block; margin-bottom: 4px; }
    .meta, .empty, .raw {
      color: var(--muted);
      font-size: 0.9rem;
    }
    .empty { padding: 18px; }
    .songs { display: grid; gap: 12px; padding: 18px; }
    .song {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: start;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(31, 43, 67, 0.72);
    }
    .song.disabled { opacity: 0.68; }
    .song h3 {
      margin: 0 0 6px;
      font-size: 1rem;
    }
    .raw {
      margin-top: 8px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .badge {
      display: inline-block;
      margin-left: 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 0.75rem;
      vertical-align: middle;
    }
    .error {
      margin-bottom: 16px;
      border: 1px solid rgba(255, 107, 107, 0.6);
      border-radius: 12px;
      padding: 12px 14px;
      background: rgba(255, 107, 107, 0.12);
      color: #ffd7d7;
    }
    @media (max-width: 760px) {
      header, .song { display: block; }
      .layout { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; margin-top: 12px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>AirFreyr Queues</h1>
        <p>View queue lists, comment out songs, or remove songs from a list.</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div id="error" class="error" hidden></div>
    <section class="layout">
      <aside class="panel">
        <div class="panel-head">
          <h2>Lists</h2>
          <span id="list-count" class="meta"></span>
        </div>
        <div id="lists"></div>
      </aside>
      <section class="panel">
        <div class="panel-head">
          <h2 id="songs-title">Songs</h2>
          <span id="songs-count" class="meta"></span>
        </div>
        <div id="songs" class="songs">
          <div class="empty">Choose a list to view its songs.</div>
        </div>
      </section>
    </section>
  </main>
  <script>
    var state = {lists: [], selectedFile: null};
    var listsEl = document.getElementById('lists');
    var songsEl = document.getElementById('songs');
    var errorEl = document.getElementById('error');
    var listCountEl = document.getElementById('list-count');
    var songsTitleEl = document.getElementById('songs-title');
    var songsCountEl = document.getElementById('songs-count');

    function text(value) {
      return value == null ? '' : String(value);
    }

    function setError(message) {
      errorEl.hidden = !message;
      errorEl.textContent = message || '';
    }

    function requestJson(url, options) {
      return fetch(url, options).then(function(res) {
        return res.json().then(function(body) {
          if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
          return body;
        });
      });
    }

    function renderLists() {
      listCountEl.textContent = state.lists.length ? state.lists.length + ' list(s)' : '';
      if (!state.lists.length) {
        listsEl.innerHTML = '<div class="empty">No .txt queue lists found.</div>';
        return;
      }

      listsEl.innerHTML = '';
      state.lists.forEach(function(list) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-button' + (list.file === state.selectedFile ? ' active' : '');
        button.innerHTML = '<strong></strong><span class="meta"></span>';
        button.querySelector('strong').textContent = list.file;
        button.querySelector('.meta').textContent =
          list.total + ' songs, ' + list.active + ' active, ' + list.disabled + ' disabled';
        button.addEventListener('click', function() {
          loadList(list.file);
        });
        listsEl.appendChild(button);
      });
    }

    function songTitle(entry) {
      if (entry.artist && entry.title) return entry.artist + ' - ' + entry.title;
      return entry.title || entry.artist || entry.url || entry.raw;
    }

    function songMeta(entry) {
      var values = [];
      if (entry.genre) values.push(entry.genre);
      if (entry.note) values.push(entry.note);
      if (entry.url) values.push(entry.url);
      return values.join(' | ');
    }

    function renderSongs(list) {
      songsTitleEl.textContent = list.file || 'Songs';
      songsCountEl.textContent = list.total + ' songs';
      songsEl.innerHTML = '';

      if (!list.entries.length) {
        songsEl.innerHTML = '<div class="empty">This list is empty.</div>';
        return;
      }

      list.entries.forEach(function(entry) {
        var row = document.createElement('article');
        row.className = 'song' + (entry.disabled ? ' disabled' : '');
        row.innerHTML =
          '<div>' +
          '<h3></h3>' +
          '<div class="meta"></div>' +
          '<div class="raw"></div>' +
          '</div>' +
          '<div class="actions"></div>';
        row.querySelector('h3').textContent = songTitle(entry);
        if (entry.disabled) {
          var badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'disabled';
          row.querySelector('h3').appendChild(badge);
        }
        row.querySelector('.meta').textContent = songMeta(entry);
        row.querySelector('.raw').textContent = 'Line ' + entry.line + ': ' + text(entry.raw);

        var actions = row.querySelector('.actions');
        if (!entry.disabled) {
          var disable = document.createElement('button');
          disable.type = 'button';
          disable.textContent = 'Disable';
          disable.addEventListener('click', function() {
            mutateSong(entry.line, 'disable');
          });
          actions.appendChild(disable);
        }

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger';
        remove.textContent = 'Delete';
        remove.addEventListener('click', function() {
          if (window.confirm('Delete line ' + entry.line + ' from ' + list.file + '?')) mutateSong(entry.line, 'delete');
        });
        actions.appendChild(remove);
        songsEl.appendChild(row);
      });
    }

    function refreshLists() {
      setError('');
      return requestJson('/api/lists')
        .then(function(body) {
          state.lists = body.lists || [];
          if (
            state.selectedFile &&
            !state.lists.some(function(list) {
              return list.file === state.selectedFile;
            })
          ) {
            state.selectedFile = null;
          }
          renderLists();
          if (state.selectedFile) return loadList(state.selectedFile);
          return null;
        })
        .catch(function(err) {
          setError(err.message);
        });
    }

    function loadList(file) {
      setError('');
      state.selectedFile = file;
      renderLists();
      songsEl.innerHTML = '<div class="empty">Loading...</div>';
      return requestJson('/api/list?file=' + encodeURIComponent(file))
        .then(renderSongs)
        .catch(function(err) {
          setError(err.message);
        });
    }

    function mutateSong(line, action) {
      setError('');
      return requestJson('/api/list/item', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: state.selectedFile, line: line, action: action}),
      })
        .then(function(body) {
          renderSongs(body);
          return refreshLists();
        })
        .catch(function(err) {
          setError(err.message);
        });
    }

    document.getElementById('refresh').addEventListener('click', refreshLists);
    refreshLists();
  </script>
</body>
</html>`;
}

export default class QueueServer {
  #opts;
  #scheduler = new FileDownloadScheduler();
  #server = null;

  constructor(opts = {}) {
    this.#opts = resolveServeConfig(opts, opts.projectConfig);
  }

  get baseUrl() {
    return `http://${this.#opts.hostname}:${this.#opts.port}`;
  }

  #spawnDownload(filePath) {
    return new Promise((resolve, reject) => {
      const dlArgs = ['-i', filePath, '--no-logo', '--no-header', ...this.#opts.extraCliArgs];
      if (this.#opts.outputDir) dlArgs.push('-d', this.#opts.outputDir);
      if (this.#opts.config) dlArgs.push('-o', this.#opts.config);

      const useNpx = process.env.AIRFREYR_SPAWN_NPX === '1';
      const cmd = useNpx ? 'npx' : process.execPath;
      const args = useNpx
        ? ['--yes', `@emgeebee/airfreyr@${VERSION}`, ...dlArgs]
        : [CLI_PATH, ...dlArgs];

      console.log(`[airfreyr serve] download: ${cmd} ${args.join(' ')}`);

      let stderr = '';
      const child = spawn(cmd, args, {
        cwd: useNpx ? this.#opts.queueDir : path.dirname(CLI_PATH),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      child.stdout?.on('data', chunk => process.stdout.write(chunk));
      child.stderr?.on('data', chunk => {
        process.stderr.write(chunk);
        stderr += chunk.toString();
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
      });
      child.on('error', reject);
      child.on('close', code => {
        this.#scheduler.setExitCode(filePath, code);
        if (code === 0) resolve();
        else {
          const detail = tailLines(stderr);
          reject(
            new Error(
              detail
                ? `airfreyr exited with code ${code}: ${detail}`
                : `airfreyr exited with code ${code}`,
            ),
          );
        }
      });
    });
  }

  async #appendLine(filePath, item) {
    await mkdir(path.dirname(filePath), {recursive: true});
    await appendFile(filePath, formatBatchCsvLine(item), 'utf8');
  }

  async start() {
    const port = this.#opts.port;
    if (!Number.isFinite(port) || port < 1 || port > 65535)
      throw new Error('port must be a valid TCP port');

    if (this.#opts.config) await assertReadable(this.#opts.config, 'config file');
    if (this.#opts.outputDir) {
      try {
        await access(this.#opts.outputDir, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        throw new Error(`output directory not writable: ${this.#opts.outputDir}`);
      }
    }

    const app = express().use(cors()).use(express.json({limit: '64kb'}));

    app.get('/', (_req, res) => {
      res.type('html').send(queueUiHtml());
    });

    app.get('/health', (_req, res) => {
      res.json(
        apiJson({
          ok: true,
          queueDir: path.resolve(this.#opts.queueDir),
          outputDir: this.#opts.outputDir ? path.resolve(this.#opts.outputDir) : null,
        }),
      );
    });

    app.get('/api/lists', async (_req, res) => {
      try {
        res.json(apiJson({ok: true, lists: await listQueueFiles(this.#opts.queueDir)}));
      } catch (err) {
        apiError(res, err);
      }
    });

    app.get('/api/list', async (req, res) => {
      try {
        res.json(apiJson({ok: true, ...(await readQueueFile(this.#opts.queueDir, req.query.file))}));
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list/item', async (req, res) => {
      try {
        res.json(
          apiJson({
            ok: true,
            ...(await updateQueueFileItem(this.#opts.queueDir, req.body.file, req.body.line, req.body.action)),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/add', async (req, res) => {
      try {
        const item = normalizeAddPayload(req.body);
        const filePath = resolveQueueFile(this.#opts.queueDir, item.file);
        const line = formatBatchCsvLine(item).trimEnd();
        await this.#appendLine(filePath, item);
        this.#scheduler.schedule(filePath, fp => this.#spawnDownload(fp));
        res.status(201).json(
          apiJson({
            ok: true,
            file: item.file,
            filePath,
            line,
            download: this.#scheduler.getStatus(filePath),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.get('/status', (req, res) => {
      try {
        const filePath = resolveQueueFile(this.#opts.queueDir, req.query.file);
        res.json(
          apiJson({
            ok: true,
            file: req.query.file,
            download: this.#scheduler.getStatus(filePath),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    await new Promise((resolve, reject) => {
      this.#server = app.listen(this.#opts.port, this.#opts.hostname, resolve);
      this.#server.on('error', reject);
    });

    console.log(`[airfreyr serve] v${VERSION} listening on ${this.baseUrl}`);
    console.log(`[airfreyr serve] queue directory: ${path.resolve(this.#opts.queueDir)}`);
    if (this.#opts.outputDir)
      console.log(`[airfreyr serve] output directory: ${path.resolve(this.#opts.outputDir)}`);
    console.log(`[airfreyr serve] POST ${this.baseUrl}/add`);
    return this;
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve, reject) => {
      this.#server.close(err => (err ? reject(err) : resolve()));
    });
    this.#server = null;
  }
}
