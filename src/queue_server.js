import { spawn } from 'child_process';
import { readFileSync, constants as fsConstants } from 'fs';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import cors from 'cors';
import express from 'express';
import filenamify from 'filenamify';

import {
  QUEUE_FILE_EXTENSION,
  emptyQueueDocument,
  ensureQueueExtension,
  genreFromQueueFilename,
  importCsvText,
  normalizeStoredEntry,
  parseQueueDocument,
  serializeQueueDocument,
  stripQueueExtension,
  toApiEntry,
} from './queue_format.js';

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

function summarizeDownloadLog(output) {
  const text = stripAnsi(output);
  const batchLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.includes('[airfreyr] batch:'));
  if (batchLine) return batchLine.replace(/^.*\[airfreyr\]\s*batch:\s*/i, '');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const statsIndex = lines.findIndex(line => line.includes('============ Stats ============'));
  if (statsIndex >= 0) return lines.slice(statsIndex).join(' | ');
  return tailLines(output, 12);
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

export function collectMirrorRoots(projectConfig = {}, outputDir = null) {
  const base = path.resolve(outputDir || '.');
  const dirs = projectConfig.dirs || {};
  return Array.from(
    new Set(
      [
        ...(dirs.mirror || []),
        ...(process.env.AIRFREYR_MIRROR_DIRS || '')
          .split(',')
          .map(dir => dir.trim())
          .filter(Boolean),
      ]
        .map(dir => path.resolve(dir))
        .filter(dir => dir !== base),
    ),
  );
}

async function assertWritableDir(dir, label) {
  try {
    await mkdir(dir, {recursive: true});
    await access(dir, fsConstants.R_OK | fsConstants.W_OK);
  } catch (err) {
    const denied = err?.code === 'EACCES' || err?.code === 'EPERM';
    const suffix = denied
      ? ' — grant write access to the user running airfreyr (on Synology, set PUID/PGID to the shared-folder owner)'
      : '';
    throw new Error(`${label} not writable: ${dir}${suffix}`);
  }
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
    projectConfig,
    extraCliArgs: opts.extraCliArgs || [],
  };
}

export const genreFromQueueFile = genreFromQueueFilename;

async function readQueueDocument(filePath) {
  const text = await readFile(filePath, 'utf8');
  return parseQueueDocument(text);
}

async function writeQueueDocument(filePath, document) {
  await writeFile(filePath, serializeQueueDocument(document), 'utf8');
}

function resolveQueueFile(dataDir, file) {
  if (!file || typeof file !== 'string') throw new Error('`file` is required');
  const base = path.resolve(dataDir);
  const resolved = path.resolve(base, file);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
    throw new Error('`file` must resolve within the data directory');
  if (!resolved.toLowerCase().endsWith('.json'))
    throw new Error('`file` must be a .json queue file');
  return resolved;
}

async function readQueueEntries(filePath, file) {
  const fileGenre = genreFromQueueFilename(file);
  const document = await readQueueDocument(filePath);
  return document.entries.map((entry, index) => toApiEntry(entry, index, fileGenre));
}

function summarizeEntries(entries) {
  return {
    total: entries.length,
    active: entries.filter(entry => !entry.disabled).length,
    disabled: entries.filter(entry => entry.disabled).length,
  };
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function audioFormatFromArgs(args = []) {
  let format = 'mp3';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-x' || arg === '--format') {
      if (args[index + 1]) format = args[index + 1];
      index += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--format=')) {
      format = arg.slice('--format='.length);
    } else if (typeof arg === 'string' && arg.startsWith('-x') && arg.length > 2) {
      format = arg.slice(2);
    }
  }
  return format || 'mp3';
}

function resolveBatchEntryPaths(entry, format) {
  if (!entry?.genre || !entry?.artist) return null;
  const title = entry.title || entry.artist;
  const trackBaseName = `${entry.artist} - ${title}`;
  const outFileName = `${filenamify(trackBaseName, {replacement: '_'})}.${format}`;
  const genrePath = filenamify(entry.genre, {replacement: '_'});
  return {
    download: {
      trackPath: genrePath,
      outFileName,
    },
    mirror: {
      trackPath: path.join(
        genrePath,
        filenamify('Compilations', {replacement: '_'}),
        filenamify('YouTube', {replacement: '_'}),
      ),
      outFileName,
    },
  };
}

async function addEntryFileStatuses(list, resolveLocations) {
  return {
    ...list,
    entries: await Promise.all(
      list.entries.map(async entry => ({
        ...entry,
        files: await resolveLocations(entry),
      })),
    ),
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
      .filter(dirent => dirent.isFile() && dirent.name.toLowerCase().endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async dirent => {
        const filePath = resolveQueueFile(dataDir, dirent.name);
        const entries = await readQueueEntries(filePath, dirent.name);
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
  const entries = await readQueueEntries(filePath, file);
  return {
    file,
    filePath,
    entries,
    ...summarizeEntries(entries),
  };
}

function normalizeQueueFileName(file) {
  if (!file || typeof file !== 'string') throw new Error('`file` is required');
  const trimmed = ensureQueueExtension(file.trim());
  if (path.basename(trimmed) !== trimmed) throw new Error('`file` must be a filename only');
  if (trimmed === '.json') throw new Error('invalid `file` name');
  return trimmed;
}

async function createQueueFile(dataDir, file) {
  const name = normalizeQueueFileName(file);
  const filePath = resolveQueueFile(dataDir, name);
  try {
    await access(filePath, fsConstants.F_OK);
    throw new Error('`file` already exists');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeQueueDocument(filePath, emptyQueueDocument());
  return readQueueFile(dataDir, name);
}

async function renameQueueFile(dataDir, file, newFile) {
  const from = normalizeQueueFileName(file);
  const to = normalizeQueueFileName(newFile);
  if (from === to) return readQueueFile(dataDir, to);
  const fromPath = resolveQueueFile(dataDir, from);
  const toPath = resolveQueueFile(dataDir, to);
  try {
    await access(fromPath, fsConstants.F_OK);
  } catch {
    throw new Error('`file` does not exist');
  }
  try {
    await access(toPath, fsConstants.F_OK);
    throw new Error('`newFile` already exists');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await rename(fromPath, toPath);
  return {from, file: to, ...(await readQueueFile(dataDir, to))};
}

async function updateQueueFileItem(dataDir, file, line, action) {
  const filePath = resolveQueueFile(dataDir, file);
  const lineNumber = Number.parseInt(line, 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('`line` must be a positive integer');
  if (!['disable', 'delete'].includes(action)) throw new Error('`action` must be "disable" or "delete"');

  const document = await readQueueDocument(filePath);
  const index = lineNumber - 1;
  if (index >= document.entries.length) throw new Error('`line` does not exist in the selected file');

  if (action === 'disable') document.entries[index].disabled = true;
  else document.entries.splice(index, 1);

  await writeQueueDocument(filePath, document);
  return readQueueFile(dataDir, file);
}

async function retryQueueFileItem(dataDir, file, line) {
  const list = await readQueueFile(dataDir, file);
  const lineNumber = Number.parseInt(line, 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('`line` must be a positive integer');
  const entry = list.entries.find(item => item.line === lineNumber);
  if (!entry) throw new Error('`line` does not exist in the selected file');
  if (entry.disabled) throw new Error('`line` must reference an active song entry');
  return {file, line: lineNumber, entry};
}

function normalizeAddPayload(body) {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const {file, artist, title} = body;
  const url = body.path ?? body.url;
  if (!file) throw new Error('`file` is required');
  if (!artist) throw new Error('`artist` is required');
  if (!url) throw new Error('`path` is required');
  if (!/^https?:\/\//i.test(url)) throw new Error('`path` must be an http(s) URL');
  const fileGenre = genreFromQueueFilename(file);
  return {
    file,
    entry: normalizeStoredEntry(
      {
        genre: body.genre || fileGenre,
        artist,
        title: title || '',
        url,
      },
      fileGenre,
    ),
  };
}

async function appendBulkQueueLines(dataDir, file, text) {
  const filePath = resolveQueueFile(dataDir, file);
  const fileGenre = genreFromQueueFilename(file);
  const imported = importCsvText(text, file);
  const document = await readQueueDocument(filePath);
  document.entries.push(...imported);
  await writeQueueDocument(filePath, document);
  return {file, added: imported.length, ...(await readQueueFile(dataDir, file))};
}

async function migrateTxtQueueFiles(dataDir) {
  let dirents;
  try {
    dirents = await readdir(dataDir, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.txt')) continue;
    const txtPath = path.join(dataDir, dirent.name);
    const jsonName = ensureQueueExtension(stripQueueExtension(dirent.name));
    const jsonPath = path.join(dataDir, jsonName);
    const text = await readFile(txtPath, 'utf8');
    const document = {entries: importCsvText(text, jsonName)};
    try {
      await access(jsonPath, fsConstants.F_OK);
      console.warn(`[airfreyr serve] skipped ${dirent.name} migration — ${jsonName} already exists`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await writeQueueDocument(jsonPath, document);
      console.log(`[airfreyr serve] migrated ${dirent.name} → ${jsonName}`);
    }
    await unlink(txtPath);
  }
}

class FileDownloadScheduler {
  #state = new Map();

  schedule(filePath, runner) {
    const state = this.#state.get(filePath) || {
      running: false,
      pending: false,
      lastError: null,
      lastLog: null,
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
        lastLog: null,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastExitCode: null,
      }
    );
  }

  setLastLog(filePath, log) {
    const state = this.#state.get(filePath);
    if (state) state.lastLog = log;
  }

  setExitCode(filePath, code) {
    const state = this.#state.get(filePath);
    if (state) state.lastExitCode = code;
  }

  #run(filePath, runner, state) {
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    state.lastError = null;
    state.lastLog = null;
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

function queueUiHtml(version) {
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
    .song-link {
      margin-top: 8px;
      overflow-wrap: anywhere;
      font-size: 0.9rem;
    }
    .song-link a {
      color: var(--accent);
      text-decoration: none;
    }
    .song-link a:hover { text-decoration: underline; }
    .file-statuses {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .file-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .file-chip.exists {
      border-color: rgba(77, 213, 153, 0.45);
      color: var(--accent);
    }
    .file-chip.missing {
      border-color: rgba(255, 107, 107, 0.45);
      color: #ffb4b4;
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
    .version {
      display: inline-block;
      margin-left: 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--accent);
      font-size: 0.75rem;
      font-weight: 600;
      vertical-align: middle;
    }
    .header-actions, .panel-head-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .panel-head-actions { flex-shrink: 0; }
    button.primary {
      border-color: rgba(77, 213, 153, 0.45);
      background: rgba(77, 213, 153, 0.14);
    }
    button.primary:hover { border-color: var(--accent); }
    .error {
      margin-bottom: 16px;
      border: 1px solid rgba(255, 107, 107, 0.6);
      border-radius: 12px;
      padding: 12px 14px;
      background: rgba(255, 107, 107, 0.12);
      color: #ffd7d7;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(8, 12, 20, 0.72);
      z-index: 20;
    }
    .modal-backdrop[hidden] { display: none; }
    .modal {
      width: min(480px, 100%);
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    .modal.wide { width: min(720px, 100%); }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
    }
    .modal-head h2 {
      margin: 0;
      font-size: 1.05rem;
    }
    .modal-body {
      display: grid;
      gap: 14px;
      padding: 20px;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field label {
      color: var(--muted);
      font-size: 0.85rem;
    }
    .field input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
    }
    .field input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .field textarea {
      width: 100%;
      min-height: 220px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
      line-height: 1.45;
    }
    .field textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 0.85rem;
      line-height: 1.45;
    }
    .download-status {
      margin: 0 18px 18px;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: rgba(31, 43, 67, 0.72);
    }
    .download-status h3 {
      margin: 0 0 8px;
      font-size: 0.95rem;
    }
    .download-status pre {
      margin: 8px 0 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(8, 12, 20, 0.55);
      color: #d7deea;
      font: 0.8rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .status-ok { color: var(--accent); }
    .status-warn { color: #ffd166; }
    .status-bad { color: #ffb4b4; }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 20px 20px;
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
        <h1>AirFreyr Queues <span id="version" class="version">v${version}</span></h1>
        <p>View queue lists, comment out songs, or remove songs from a list.</p>
      </div>
      <div class="header-actions">
        <button id="refresh" type="button">Refresh</button>
      </div>
    </header>
    <div id="error" class="error" hidden></div>
    <section class="layout">
      <aside class="panel">
        <div class="panel-head">
          <h2>Lists</h2>
          <div class="panel-head-actions">
            <span id="list-count" class="meta"></span>
            <button id="new-list" type="button" class="primary">New list</button>
          </div>
        </div>
        <div id="lists"></div>
      </aside>
      <section class="panel">
        <div class="panel-head">
          <h2 id="songs-title">Songs</h2>
          <div class="panel-head-actions">
            <span id="songs-count" class="meta"></span>
            <button id="paste-lines" type="button" disabled>Paste lines</button>
            <button id="rename-list" type="button" disabled>Rename</button>
            <button id="add-song" type="button" class="primary" disabled>Add song</button>
          </div>
        </div>
        <div id="songs" class="songs">
          <div class="empty">Choose a list to view its songs.</div>
        </div>
        <div id="download-status" class="download-status" hidden>
          <h3>Download</h3>
          <div id="download-summary" class="meta"></div>
          <div id="download-files" class="download-files"></div>
          <pre id="download-log" hidden></pre>
          <p class="hint">Container logs: <code>docker logs --tail 100 airfreyr</code></p>
        </div>
      </section>
    </section>
  </main>
  <div id="add-song-modal" class="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-song-title">
      <div class="modal-head">
        <h2 id="add-song-title">Add song</h2>
        <button id="add-song-close" type="button" aria-label="Close">Close</button>
      </div>
      <form id="add-song-form">
        <div class="modal-body">
          <p class="hint">Genre is taken from the list filename (<span id="add-genre-hint"></span>).</p>
          <div class="field">
            <label for="add-artist">Artist</label>
            <input id="add-artist" name="artist" type="text" required autocomplete="off">
          </div>
          <div class="field">
            <label for="add-title">Title <span class="meta">(optional)</span></label>
            <input id="add-title" name="title" type="text" autocomplete="off">
          </div>
          <div class="field">
            <label for="add-url">URL</label>
            <input id="add-url" name="path" type="url" required placeholder="https://..." autocomplete="off">
          </div>
        </div>
        <div class="modal-actions">
          <button id="add-song-cancel" type="button">Cancel</button>
          <button type="submit" class="primary">Add &amp; download</button>
        </div>
      </form>
    </div>
  </div>
  <div id="paste-lines-modal" class="modal-backdrop" hidden>
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="paste-lines-title">
      <div class="modal-head">
        <h2 id="paste-lines-title">Paste lines</h2>
        <button id="paste-lines-close" type="button" aria-label="Close">Close</button>
      </div>
      <form id="paste-lines-form">
        <div class="modal-body">
          <p class="hint">One song per line as CSV: <code>artist,title,url</code> (title optional). Genre comes from the list filename. Lines starting with <code>#</code> are imported as disabled entries. Blank lines are skipped.</p>
          <div class="field">
            <label for="paste-lines-input">Queue lines</label>
            <textarea id="paste-lines-input" name="lines" required placeholder="Kids,Moana,You're Welcome,https://www.youtube.com/watch?v=G8QjumNNNBY"></textarea>
          </div>
        </div>
        <div class="modal-actions">
          <button id="paste-lines-cancel" type="button">Cancel</button>
          <button type="submit" class="primary">Add lines &amp; download</button>
        </div>
      </form>
    </div>
  </div>
  <div id="rename-list-modal" class="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rename-list-title">
      <div class="modal-head">
        <h2 id="rename-list-title">Rename list</h2>
        <button id="rename-list-close" type="button" aria-label="Close">Close</button>
      </div>
      <form id="rename-list-form">
        <div class="modal-body">
          <p class="hint">Genre is taken from the list name. Use spaces or hyphens for multi-word genres, e.g. <code>folk rock.json</code> → Folk Rock.</p>
          <div class="field">
            <label for="rename-list-input">List name</label>
            <input id="rename-list-input" name="newFile" type="text" required autocomplete="off">
          </div>
        </div>
        <div class="modal-actions">
          <button id="rename-list-cancel" type="button">Cancel</button>
          <button type="submit" class="primary">Rename</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    var state = {lists: [], selectedFile: null};
    var listsEl = document.getElementById('lists');
    var songsEl = document.getElementById('songs');
    var errorEl = document.getElementById('error');
    var listCountEl = document.getElementById('list-count');
    var songsTitleEl = document.getElementById('songs-title');
    var songsCountEl = document.getElementById('songs-count');
    var versionEl = document.getElementById('version');
    var addSongBtn = document.getElementById('add-song');
    var pasteLinesBtn = document.getElementById('paste-lines');
    var addSongModal = document.getElementById('add-song-modal');
    var addSongForm = document.getElementById('add-song-form');
    var pasteLinesModal = document.getElementById('paste-lines-modal');
    var pasteLinesForm = document.getElementById('paste-lines-form');
    var renameListBtn = document.getElementById('rename-list');
    var renameListModal = document.getElementById('rename-list-modal');
    var renameListForm = document.getElementById('rename-list-form');
    var downloadStatusEl = document.getElementById('download-status');
    var downloadSummaryEl = document.getElementById('download-summary');
    var downloadFilesEl = document.getElementById('download-files');
    var downloadLogEl = document.getElementById('download-log');
    var statusPollTimer = null;

    function text(value) {
      return value == null ? '' : String(value);
    }

    function queueFileBaseName(file) {
      var value = String(file || '');
      var slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\\\'));
      return slash >= 0 ? value.slice(slash + 1) : value;
    }

    function stripJsonExtension(name) {
      var value = String(name || '');
      return value.toLowerCase().slice(-5) === '.json' ? value.slice(0, -5) : value;
    }

    function ensureJsonExtension(name) {
      var value = String(name || '').trim();
      if (!value) return value;
      return value.toLowerCase().slice(-5) === '.json' ? value : value + '.json';
    }

    function genreFromListFile(file) {
      var stem = stripJsonExtension(queueFileBaseName(file));
      if (!stem) return 'Unknown';
      return stem
        .split(/[\\s_-]+/)
        .filter(Boolean)
        .map(function(word) {
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
    }

    function setListActionsEnabled(enabled) {
      addSongBtn.disabled = !enabled;
      pasteLinesBtn.disabled = !enabled;
      renameListBtn.disabled = !enabled;
    }

    function openAddSongModal() {
      if (!state.selectedFile) {
        setError('Choose a list before adding a song');
        return;
      }
      setError('');
      document.getElementById('add-song-title').textContent = 'Add song to ' + state.selectedFile;
      document.getElementById('add-genre-hint').textContent = genreFromListFile(state.selectedFile);
      addSongModal.hidden = false;
      document.getElementById('add-artist').focus();
    }

    function closeAddSongModal() {
      addSongModal.hidden = true;
      addSongForm.reset();
    }

    function openPasteLinesModal() {
      if (!state.selectedFile) {
        setError('Choose a list before pasting lines');
        return;
      }
      setError('');
      document.getElementById('paste-lines-title').textContent = 'Paste lines into ' + state.selectedFile;
      pasteLinesModal.hidden = false;
      document.getElementById('paste-lines-input').focus();
    }

    function closePasteLinesModal() {
      pasteLinesModal.hidden = true;
      pasteLinesForm.reset();
    }

    function openRenameListModal() {
      if (!state.selectedFile) {
        setError('Choose a list before renaming');
        return;
      }
      setError('');
      document.getElementById('rename-list-title').textContent =
        'Rename ' + genreFromListFile(state.selectedFile);
      document.getElementById('rename-list-input').value = stripJsonExtension(state.selectedFile);
      renameListModal.hidden = false;
      document.getElementById('rename-list-input').focus();
      document.getElementById('rename-list-input').select();
    }

    function closeRenameListModal() {
      renameListModal.hidden = true;
      renameListForm.reset();
    }

    function setVersion(version) {
      if (version) versionEl.textContent = 'v' + version;
    }

    function setError(message) {
      errorEl.hidden = !message;
      errorEl.textContent = message || '';
    }

    function clearElement(element) {
      while (element.firstChild) element.removeChild(element.firstChild);
    }

    function requestJson(url, options) {
      return fetch(url, options).then(function(res) {
        return res.json().then(function(body) {
          if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
          if (body.version) setVersion(body.version);
          return body;
        });
      });
    }

    function renderFileLocations(container, locations) {
      clearElement(container);
      (locations || []).forEach(function(location) {
        var chip = document.createElement('span');
        chip.className =
          'file-chip ' + (location.exists ? 'exists' : location.configured ? 'missing' : 'unconfigured');
        chip.title = location.path || location.root || 'No path configured';
        chip.textContent = (location.exists ? '✓' : location.configured ? '✕' : '-') + ' ' + location.label;
        container.appendChild(chip);
      });
    }

    function renderDownloadFiles(files) {
      clearElement(downloadFilesEl);
      if (!files || !files.length) return;
      files.forEach(function(file) {
        var row = document.createElement('div');
        row.className = 'download-file-row';
        var label = document.createElement('div');
        label.className = 'meta';
        label.textContent = file.label || '';
        var locations = document.createElement('div');
        locations.className = 'file-statuses';
        renderFileLocations(locations, file.files || []);
        row.appendChild(label);
        row.appendChild(locations);
        downloadFilesEl.appendChild(row);
      });
    }

    function renderDownloadStatus(download, files) {
      if (!state.selectedFile || !download) {
        downloadStatusEl.hidden = true;
        clearElement(downloadFilesEl);
        return;
      }
      downloadStatusEl.hidden = false;
      var parts = [];
      if (download.running) parts.push('<span class="status-warn">running</span>');
      if (download.pending) parts.push('<span class="status-warn">queued</span>');
      if (!download.running && !download.pending && !download.lastError) {
        parts.push('<span class="status-ok">idle</span>');
      }
      if (download.lastStartedAt) parts.push('started ' + download.lastStartedAt);
      if (download.lastFinishedAt) parts.push('finished ' + download.lastFinishedAt);
      if (download.lastExitCode != null) parts.push('exit ' + download.lastExitCode);
      if (download.lastError) {
        parts.push('<span class="status-bad">' + text(download.lastError) + '</span>');
      }
      downloadSummaryEl.innerHTML = parts.join(' · ');
      renderDownloadFiles(files);
      if (download.lastLog) {
        downloadLogEl.hidden = false;
        downloadLogEl.textContent = download.lastLog;
      } else {
        downloadLogEl.hidden = true;
        downloadLogEl.textContent = '';
      }
    }

    function refreshDownloadStatus() {
      if (!state.selectedFile) {
        renderDownloadStatus(null, []);
        return Promise.resolve();
      }
      return requestJson('/status?file=' + encodeURIComponent(state.selectedFile))
        .then(function(body) {
          renderDownloadStatus(body.download, body.files);
          if (body.download && (body.download.running || body.download.pending)) {
            if (!statusPollTimer) {
              statusPollTimer = window.setInterval(refreshDownloadStatus, 3000);
            }
          } else if (statusPollTimer) {
            window.clearInterval(statusPollTimer);
            statusPollTimer = null;
          }
        })
        .catch(function(err) {
          downloadSummaryEl.textContent = err.message;
          downloadStatusEl.hidden = false;
        });
    }

    function renderLists() {
      listCountEl.textContent = state.lists.length ? state.lists.length + ' list(s)' : '';
      if (!state.lists.length) {
        listsEl.innerHTML = '<div class="empty">No .json queue lists found.</div>';
        return;
      }

      listsEl.innerHTML = '';
      state.lists.forEach(function(list) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-button' + (list.file === state.selectedFile ? ' active' : '');
        button.innerHTML = '<strong></strong><span class="meta"></span>';
        button.querySelector('strong').textContent = genreFromListFile(list.file);
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
      return entry.title || entry.artist || entry.url || entry.label || '';
    }

    function songMeta(entry) {
      var values = [];
      if (entry.note) values.push(entry.note);
      return values.join(' | ');
    }

    function renderSongLink(container, entry) {
      clearElement(container);
      if (!entry.url) return;
      var link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.url;
      container.appendChild(link);
    }

    function renderSongs(list) {
      songsTitleEl.textContent = list.file ? genreFromListFile(list.file) : 'Songs';
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
          '<div class="song-link"></div>' +
          '<div class="file-statuses"></div>' +
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
        renderSongLink(row.querySelector('.song-link'), entry);
        renderFileLocations(row.querySelector('.file-statuses'), entry.files || []);

        var actions = row.querySelector('.actions');
        if (!entry.disabled) {
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'primary';
          retry.textContent = 'Retry';
          retry.addEventListener('click', function() {
            retrySong(entry.line);
          });
          actions.appendChild(retry);

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
          if (window.confirm('Delete this song from ' + list.file + '?')) mutateSong(entry.line, 'delete');
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
          setListActionsEnabled(!!state.selectedFile);
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
      setListActionsEnabled(!!file);
      renderLists();
      songsEl.innerHTML = '<div class="empty">Loading...</div>';
      return requestJson('/api/list?file=' + encodeURIComponent(file))
        .then(function(body) {
          renderSongs(body);
          return refreshDownloadStatus();
        })
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

    function retrySong(line) {
      setError('');
      return requestJson('/api/list/item/retry', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: state.selectedFile, line: line}),
      })
        .then(function() {
          return refreshDownloadStatus();
        })
        .catch(function(err) {
          setError(err.message);
        });
    }

    function createList() {
      var input = window.prompt('New list name (e.g. folk rock):', 'queue');
      if (input == null) return;
      var file = input.trim();
      if (!file) {
        setError('List name is required');
        return;
      }
      file = ensureJsonExtension(file);
      setError('');
      return requestJson('/api/list', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: file}),
      })
        .then(function(body) {
          return refreshLists().then(function() {
            return loadList(body.file);
          });
        })
        .catch(function(err) {
          setError(err.message);
        });
    }

    function submitAddSong(event) {
      event.preventDefault();
      if (!state.selectedFile) {
        setError('Choose a list before adding a song');
        return;
      }
      var formData = new FormData(addSongForm);
      var payload = {
        file: state.selectedFile,
        artist: String(formData.get('artist') || '').trim(),
        title: String(formData.get('title') || '').trim(),
        path: String(formData.get('path') || '').trim(),
      };
      if (!payload.artist || !payload.path) {
        setError('Artist and URL are required');
        return;
      }
      setError('');
      var submitBtn = addSongForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      return requestJson('/add', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      })
        .then(function() {
          closeAddSongModal();
          return refreshLists().then(function() {
            return loadList(state.selectedFile);
          }).then(refreshDownloadStatus);
        })
        .catch(function(err) {
          setError(err.message);
        })
        .finally(function() {
          submitBtn.disabled = false;
        });
    }

    function submitPasteLines(event) {
      event.preventDefault();
      if (!state.selectedFile) {
        setError('Choose a list before pasting lines');
        return;
      }
      var lines = String(new FormData(pasteLinesForm).get('lines') || '').trim();
      if (!lines) {
        setError('Paste at least one queue line');
        return;
      }
      setError('');
      var submitBtn = pasteLinesForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      return requestJson('/api/list/lines', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: state.selectedFile, lines: lines}),
      })
        .then(function() {
          closePasteLinesModal();
          return refreshLists().then(function() {
            return loadList(state.selectedFile);
          }).then(refreshDownloadStatus);
        })
        .catch(function(err) {
          setError(err.message);
        })
        .finally(function() {
          submitBtn.disabled = false;
        });
    }

    function submitRenameList(event) {
      event.preventDefault();
      if (!state.selectedFile) {
        setError('Choose a list before renaming');
        return;
      }
      var newFile = String(new FormData(renameListForm).get('newFile') || '').trim();
      if (!newFile) {
        setError('List name is required');
        return;
      }
      newFile = ensureJsonExtension(newFile);
      setError('');
      var submitBtn = renameListForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      return requestJson('/api/list/rename', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: state.selectedFile, newFile: newFile}),
      })
        .then(function(body) {
          closeRenameListModal();
          state.selectedFile = body.file;
          return refreshLists().then(function() {
            return loadList(body.file);
          });
        })
        .catch(function(err) {
          setError(err.message);
        })
        .finally(function() {
          submitBtn.disabled = false;
        });
    }

    document.getElementById('refresh').addEventListener('click', refreshLists);
    document.getElementById('new-list').addEventListener('click', createList);
    addSongBtn.addEventListener('click', openAddSongModal);
    pasteLinesBtn.addEventListener('click', openPasteLinesModal);
    renameListBtn.addEventListener('click', openRenameListModal);
    document.getElementById('add-song-close').addEventListener('click', closeAddSongModal);
    document.getElementById('add-song-cancel').addEventListener('click', closeAddSongModal);
    addSongModal.addEventListener('click', function(event) {
      if (event.target === addSongModal) closeAddSongModal();
    });
    addSongForm.addEventListener('submit', submitAddSong);
    document.getElementById('paste-lines-close').addEventListener('click', closePasteLinesModal);
    document.getElementById('paste-lines-cancel').addEventListener('click', closePasteLinesModal);
    pasteLinesModal.addEventListener('click', function(event) {
      if (event.target === pasteLinesModal) closePasteLinesModal();
    });
    pasteLinesForm.addEventListener('submit', submitPasteLines);
    document.getElementById('rename-list-close').addEventListener('click', closeRenameListModal);
    document.getElementById('rename-list-cancel').addEventListener('click', closeRenameListModal);
    renameListModal.addEventListener('click', function(event) {
      if (event.target === renameListModal) closeRenameListModal();
    });
    renameListForm.addEventListener('submit', submitRenameList);
    refreshLists();
  </script>
</body>
</html>`;
}

export default class QueueServer {
  #opts;
  #scheduler = new FileDownloadScheduler();
  #server = null;
  #mirrorRoots = [];

  constructor(opts = {}) {
    this.#opts = resolveServeConfig(opts, opts.projectConfig);
  }

  get baseUrl() {
    return `http://${this.#opts.hostname}:${this.#opts.port}`;
  }

  get #audioFormat() {
    return audioFormatFromArgs(this.#opts.extraCliArgs);
  }

  async #resolveEntryFileLocations(entry) {
    const resolvedPaths = resolveBatchEntryPaths(entry, this.#audioFormat);
    const outputRoot = this.#opts.outputDir ? path.resolve(this.#opts.outputDir) : null;
    const downloadPath = outputRoot && resolvedPaths
      ? path.join(outputRoot, resolvedPaths.download.trackPath, resolvedPaths.download.outFileName)
      : null;
    const locations = [
      {
        type: 'download',
        label: 'Download',
        root: outputRoot,
        path: downloadPath,
        configured: !!downloadPath,
        exists: await fileExists(downloadPath),
      },
    ];
    for (const mirrorRoot of this.#mirrorRoots) {
      const root = path.resolve(mirrorRoot);
      const mirrorPath = resolvedPaths
        ? path.join(root, resolvedPaths.mirror.trackPath, resolvedPaths.mirror.outFileName)
        : null;
      locations.push({
        type: 'mirror',
        label: `Mirror ${locations.filter(location => location.type === 'mirror').length + 1}`,
        root,
        path: mirrorPath,
        configured: !!mirrorPath,
        exists: await fileExists(mirrorPath),
      });
    }
    return locations;
  }

  async #readQueueFile(file) {
    return addEntryFileStatuses(await readQueueFile(this.#opts.queueDir, file), entry =>
      this.#resolveEntryFileLocations(entry),
    );
  }

  async #withEntryFileStatuses(list) {
    return addEntryFileStatuses(list, entry => this.#resolveEntryFileLocations(entry));
  }

  async #resolveMirrorRoots() {
    let projectConfig = this.#opts.projectConfig || {};
    if (this.#opts.config) projectConfig = await loadProjectConfig(this.#opts.config);
    return collectMirrorRoots(projectConfig, this.#opts.outputDir);
  }

  async #spawnDownload(filePath, extraArgs = []) {
    const mirrorRoots = await this.#resolveMirrorRoots();
    return new Promise((resolve, reject) => {
      const dlArgs = ['-i', filePath, '--no-logo', '--no-header', ...extraArgs, ...this.#opts.extraCliArgs];
      if (this.#opts.outputDir) dlArgs.push('-d', this.#opts.outputDir);
      if (this.#opts.config) dlArgs.push('-o', this.#opts.config);
      for (const mirrorRoot of mirrorRoots) dlArgs.push('--mirror-dir', mirrorRoot);

      const spawnEnv = { ...process.env };
      if (mirrorRoots.length) spawnEnv.AIRFREYR_MIRROR_DIRS = mirrorRoots.join(',');

      const useNpx = process.env.AIRFREYR_SPAWN_NPX === '1';
      const cmd = useNpx ? 'npx' : process.execPath;
      const args = useNpx
        ? ['--yes', `@emgeebee/airfreyr@${VERSION}`, ...dlArgs]
        : [CLI_PATH, ...dlArgs];

      console.log(`[airfreyr serve] download: ${cmd} ${args.join(' ')}`);
      if (mirrorRoots.length)
        console.log(`[airfreyr serve] mirror directories: ${mirrorRoots.join(', ')}`);
      else
        console.warn('[airfreyr serve] no mirror directories configured for this download');

      let output = '';
      const child = spawn(cmd, args, {
        cwd: useNpx ? this.#opts.queueDir : path.dirname(CLI_PATH),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
      const collectOutput = chunk => {
        process.stdout.write(chunk);
        output += chunk.toString();
        if (output.length > 16000) output = output.slice(-16000);
      };
      child.stdout?.on('data', collectOutput);
      child.stderr?.on('data', chunk => {
        process.stderr.write(chunk);
        output += chunk.toString();
        if (output.length > 16000) output = output.slice(-16000);
      });
      child.on('error', reject);
      child.on('close', code => {
        this.#scheduler.setExitCode(filePath, code);
        const detail = summarizeDownloadLog(output);
        this.#scheduler.setLastLog(filePath, detail || null);
        if (code === 0) resolve();
        else {
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

  async #appendEntry(filePath, entry) {
    await mkdir(path.dirname(filePath), {recursive: true});
    const document = await readQueueDocument(filePath).catch(err => {
      if (err.code === 'ENOENT') return emptyQueueDocument();
      throw err;
    });
    document.entries.push(entry);
    await writeQueueDocument(filePath, document);
    return document.entries.length;
  }

  async start() {
    const port = this.#opts.port;
    if (!Number.isFinite(port) || port < 1 || port > 65535)
      throw new Error('port must be a valid TCP port');

    if (this.#opts.config) await assertReadable(this.#opts.config, 'config file');
    let projectConfig = {};
    if (this.#opts.config) {
      projectConfig = await loadProjectConfig(this.#opts.config);
    }
    if (this.#opts.outputDir) {
      try {
        await mkdir(this.#opts.outputDir, {recursive: true});
        await access(this.#opts.outputDir, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        throw new Error(`output directory not writable: ${this.#opts.outputDir}`);
      }
    }

    this.#mirrorRoots = await this.#resolveMirrorRoots();
    for (const mirrorRoot of this.#mirrorRoots) {
      try {
        await assertWritableDir(mirrorRoot, 'mirror directory');
      } catch (err) {
        console.warn(`[airfreyr serve] ${err.message}`);
      }
    }
    if (!this.#mirrorRoots.length)
      console.warn(
        '[airfreyr serve] no mirror directories configured — add dirs.mirror to conf.json or set AIRFREYR_MIRROR_DIRS',
      );

    try {
      await mkdir(this.#opts.queueDir, {recursive: true});
    } catch (err) {
      throw new Error(`queue directory not writable: ${this.#opts.queueDir}`);
    }

    await migrateTxtQueueFiles(this.#opts.queueDir);

    const app = express().use(cors()).use(express.json({limit: '256kb'}));

    app.get('/', (_req, res) => {
      res.type('html').send(queueUiHtml(VERSION));
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
        res.json(apiJson({ok: true, ...(await this.#readQueueFile(req.query.file))}));
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list', async (req, res) => {
      try {
        const created = await createQueueFile(this.#opts.queueDir, req.body.file);
        res.status(201).json(
          apiJson({
            ok: true,
            ...(await this.#withEntryFileStatuses(created)),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list/rename', async (req, res) => {
      try {
        const {file, newFile} = req.body || {};
        if (!file) throw new Error('`file` is required');
        if (!newFile) throw new Error('`newFile` is required');
        const renamed = await renameQueueFile(this.#opts.queueDir, file, newFile);
        res.json(
          apiJson({
            ok: true,
            ...(await this.#withEntryFileStatuses(renamed)),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list/lines', async (req, res) => {
      try {
        const {file, lines} = req.body || {};
        if (!file) throw new Error('`file` is required');
        if (!lines || typeof lines !== 'string') throw new Error('`lines` is required');
        const filePath = resolveQueueFile(this.#opts.queueDir, file);
        const result = await appendBulkQueueLines(this.#opts.queueDir, file, lines);
        this.#scheduler.schedule(filePath, fp => this.#spawnDownload(fp));
        res.status(201).json(
          apiJson({
            ok: true,
            ...(await this.#withEntryFileStatuses(result)),
            download: this.#scheduler.getStatus(filePath),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list/item', async (req, res) => {
      try {
        const list = await updateQueueFileItem(
          this.#opts.queueDir,
          req.body.file,
          req.body.line,
          req.body.action,
        );
        res.json(
          apiJson({
            ok: true,
            ...(await this.#withEntryFileStatuses(list)),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list/item/retry', async (req, res) => {
      try {
        const {file, line} = req.body || {};
        const retry = await retryQueueFileItem(this.#opts.queueDir, file, line);
        const filePath = resolveQueueFile(this.#opts.queueDir, file);
        this.#scheduler.schedule(filePath, fp =>
          this.#spawnDownload(fp, ['--line', String(retry.line), '--remirror']),
        );
        res.json(
          apiJson({
            ok: true,
            ...retry,
            download: this.#scheduler.getStatus(filePath),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/add', async (req, res) => {
      try {
        const {file, entry} = normalizeAddPayload(req.body);
        const filePath = resolveQueueFile(this.#opts.queueDir, file);
        const line = await this.#appendEntry(filePath, entry);
        this.#scheduler.schedule(filePath, fp => this.#spawnDownload(fp));
        res.status(201).json(
          apiJson({
            ok: true,
            file,
            filePath,
            line,
            entry,
            download: this.#scheduler.getStatus(filePath),
          }),
        );
      } catch (err) {
        apiError(res, err);
      }
    });

    app.get('/status', async (req, res) => {
      try {
        const filePath = resolveQueueFile(this.#opts.queueDir, req.query.file);
        const list = await this.#readQueueFile(req.query.file);
        res.json(
          apiJson({
            ok: true,
            file: req.query.file,
            download: this.#scheduler.getStatus(filePath),
            files: list.entries.map(entry => ({
              label: entry.label,
              files: entry.files,
            })),
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
    if (this.#mirrorRoots.length)
      console.log(`[airfreyr serve] mirror directories: ${this.#mirrorRoots.join(', ')}`);
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
