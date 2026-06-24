import { spawn } from 'child_process';
import { readFileSync, constants as fsConstants } from 'fs';
import { access, appendFile, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
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

export function collectMirrorRoots(projectConfig = {}, outputDir = null) {
  const dirs = projectConfig.dirs || {};
  return Array.from(
    new Set(
      [
        ...(dirs.mirror || []),
        ...(process.env.AIRFREYR_MIRROR_DIRS || '')
          .split(',')
          .map(dir => dir.trim())
          .filter(Boolean),
        ...(dirs.mirrorToOutput && outputDir ? [outputDir] : []),
      ].map(dir => path.resolve(dir)),
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

function splitQueueLineBody(rawLine) {
  const disabled = /^\s*#/.test(rawLine);
  const prefix = disabled ? rawLine.match(/^(\s*#\s?)/)[1] : '';
  const body = rawLine.replace(/^\s*#\s?/, '');
  const noteMatch = body.match(/(\s+#.*)$/);
  const note = noteMatch ? noteMatch[1] : '';
  const content = (noteMatch ? body.slice(0, noteMatch.index) : body).trim();
  return {prefix, content, note};
}

export function fixDuplicateFilenameCsvField(rawLine, fileStem) {
  if (!fileStem) return {line: rawLine, changed: false};
  if (!rawLine.trim()) return {line: rawLine, changed: false};

  const {prefix, content, note} = splitQueueLineBody(rawLine);
  if (!content) return {line: rawLine, changed: false};

  const parts = parseCsvLine(content);
  const urlIndex = parts.findIndex(part => /^https?:\/\//i.test(part));
  if (urlIndex < 0 || parts.length !== 4) return {line: rawLine, changed: false};
  if (parts[0] !== fileStem) return {line: rawLine, changed: false};

  const fixedContent = parts.slice(1).map(escapeCsvField).join(',');
  const line = `${prefix}${fixedContent}${note}`;
  return {line, changed: line !== rawLine};
}

async function sanitizeQueueFile(filePath, fileStem) {
  const text = await readFile(filePath, 'utf8');
  const {lines, newline, trailingNewline} = splitEditableLines(text);
  let changed = false;
  const fixedLines = lines.map(line => {
    const result = fixDuplicateFilenameCsvField(line, fileStem);
    if (result.changed) changed = true;
    return result.line;
  });
  if (!changed) return false;
  await writeFile(filePath, joinEditableLines(fixedLines, newline, trailingNewline), 'utf8');
  return true;
}

async function sanitizeQueueDirectory(dataDir) {
  let dirents;
  try {
    dirents = await readdir(dataDir, {withFileTypes: true});
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.txt')) continue;
    const filePath = resolveQueueFile(dataDir, dirent.name);
    const fileStem = dirent.name.replace(/\.txt$/i, '');
    if (await sanitizeQueueFile(filePath, fileStem))
      console.log(`[airfreyr serve] removed duplicate filename field in ${dirent.name}`);
  }
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

function normalizeQueueFileName(file) {
  if (!file || typeof file !== 'string') throw new Error('`file` is required');
  const trimmed = file.trim();
  if (!trimmed.endsWith('.txt')) throw new Error('`file` must end with .txt');
  if (path.basename(trimmed) !== trimmed) throw new Error('`file` must be a filename only');
  if (trimmed === '.txt') throw new Error('invalid `file` name');
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
  await writeFile(filePath, '', 'utf8');
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

async function retryQueueFileItem(dataDir, file, line) {
  const list = await readQueueFile(dataDir, file);
  const lineNumber = Number.parseInt(line, 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('`line` must be a positive integer');
  const entry = list.entries.find(item => item.line === lineNumber);
  if (!entry) throw new Error('`line` does not exist in the selected file');
  if (entry.disabled) throw new Error('`line` must reference an active song entry');
  return {file, line: lineNumber, entry};
}

function titleCaseGenreStem(stem) {
  return stem
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function genreFromQueueFile(file) {
  const stem = path.basename(String(file).trim()).replace(/\.txt$/i, '');
  if (!stem) throw new Error('invalid queue file name');
  return titleCaseGenreStem(stem);
}

function parseQueueFields(fields, fileGenre, lineNumber) {
  let genre;
  let artist;
  let title;
  if (fileGenre) {
    genre = fileGenre;
    if (fields.length >= 3) {
      artist = fields[1];
      title = fields.slice(2).join(',');
    } else if (fields.length === 2) {
      artist = fields[0];
      title = fields[1];
    } else if (fields.length === 1) {
      artist = fields[0];
      title = '';
    } else throw new Error(`line ${lineNumber}: artist is required`);
  } else {
    genre = fields[0];
    artist = fields[1];
    if (!genre) throw new Error(`line ${lineNumber}: genre is required`);
    if (!artist) throw new Error(`line ${lineNumber}: artist is required`);
    title = fields.length > 2 ? fields.slice(2).join(',') : '';
  }
  if (!artist) throw new Error(`line ${lineNumber}: artist is required`);
  return {genre, artist, title};
}

function normalizeAddPayload(body) {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const {file, artist, title} = body;
  const url = body.path ?? body.url;
  if (!file) throw new Error('`file` is required');
  if (!artist) throw new Error('`artist` is required');
  if (!url) throw new Error('`path` is required');
  if (!/^https?:\/\//i.test(url)) throw new Error('`path` must be an http(s) URL');
  return {
    file,
    genre: body.genre || genreFromQueueFile(file),
    artist,
    title: title || '',
    path: url,
  };
}

function parseBulkQueueLine(rawLine, lineNumber, fileGenre) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  const disabled = /^\s*#/.test(rawLine);
  const body = rawLine.replace(/^\s*#\s?/, '');
  const content = body.replace(/#.*$/, '').trim();
  if (!content) return null;
  const parts = parseCsvLine(content);
  const urlIndex = parts.findIndex(part => /^https?:\/\//i.test(part));
  if (urlIndex < 0) throw new Error(`line ${lineNumber}: missing http(s) URL`);
  const fields = parts.slice(0, urlIndex);
  const url = parts.slice(urlIndex).join(',').trim();
  const {genre, artist, title} = parseQueueFields(fields, fileGenre, lineNumber);
  return {genre, artist, title, path: url, disabled};
}

function formatBulkQueueLine(item) {
  const line = formatBatchCsvLine(item).trimEnd();
  return item.disabled ? `# ${line}\n` : formatBatchCsvLine(item);
}

function parseBulkQueueText(text, file) {
  const fileGenre = genreFromQueueFile(file);
  const items = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const item = parseBulkQueueLine(rawLine, index + 1, fileGenre);
    if (item) items.push(item);
  }
  if (!items.length) throw new Error('no valid queue lines found');
  return items;
}

async function appendBulkQueueLines(dataDir, file, text) {
  const filePath = resolveQueueFile(dataDir, file);
  const items = parseBulkQueueText(text, file);
  await mkdir(path.dirname(filePath), {recursive: true});
  await appendFile(filePath, items.map(formatBulkQueueLine).join(''), 'utf8');
  return {file, added: items.length, ...(await readQueueFile(dataDir, file))};
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
          <p class="hint">One song per line as CSV: <code>artist,title,url</code> (title optional). Genre comes from the list filename. Lines starting with <code>#</code> are saved as disabled entries. Blank lines and plain comments are skipped.</p>
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
          <p class="hint">Genre is taken from the list name. Use spaces or hyphens for multi-word genres, e.g. <code>folk rock.txt</code> → Folk Rock.</p>
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

    function stripTxtExtension(name) {
      var value = String(name || '');
      return value.toLowerCase().slice(-4) === '.txt' ? value.slice(0, -4) : value;
    }

    function ensureTxtExtension(name) {
      var value = String(name || '').trim();
      if (!value) return value;
      return value.toLowerCase().slice(-4) === '.txt' ? value : value + '.txt';
    }

    function genreFromListFile(file) {
      var stem = stripTxtExtension(queueFileBaseName(file));
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
      document.getElementById('rename-list-input').value = stripTxtExtension(state.selectedFile);
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

    function requestJson(url, options) {
      return fetch(url, options).then(function(res) {
        return res.json().then(function(body) {
          if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
          if (body.version) setVersion(body.version);
          return body;
        });
      });
    }

    function renderDownloadStatus(download) {
      if (!state.selectedFile || !download) {
        downloadStatusEl.hidden = true;
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
        renderDownloadStatus(null);
        return Promise.resolve();
      }
      return requestJson('/status?file=' + encodeURIComponent(state.selectedFile))
        .then(function(body) {
          renderDownloadStatus(body.download);
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
        listsEl.innerHTML = '<div class="empty">No .txt queue lists found.</div>';
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
      return entry.title || entry.artist || entry.url || entry.raw;
    }

    function songMeta(entry) {
      var values = [];
      if (entry.note) values.push(entry.note);
      if (entry.url) values.push(entry.url);
      return values.join(' | ');
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
      file = ensureTxtExtension(file);
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
      newFile = ensureTxtExtension(newFile);
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

  constructor(opts = {}) {
    this.#opts = resolveServeConfig(opts, opts.projectConfig);
  }

  get baseUrl() {
    return `http://${this.#opts.hostname}:${this.#opts.port}`;
  }

  #spawnDownload(filePath, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const dlArgs = ['-i', filePath, '--no-logo', '--no-header', ...extraArgs, ...this.#opts.extraCliArgs];
      if (this.#opts.outputDir) dlArgs.push('-d', this.#opts.outputDir);
      if (this.#opts.config) dlArgs.push('-o', this.#opts.config);

      const useNpx = process.env.AIRFREYR_SPAWN_NPX === '1';
      const cmd = useNpx ? 'npx' : process.execPath;
      const args = useNpx
        ? ['--yes', `@emgeebee/airfreyr@${VERSION}`, ...dlArgs]
        : [CLI_PATH, ...dlArgs];

      console.log(`[airfreyr serve] download: ${cmd} ${args.join(' ')}`);

      let output = '';
      const child = spawn(cmd, args, {
        cwd: useNpx ? this.#opts.queueDir : path.dirname(CLI_PATH),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
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
        const detail = tailLines(output, 8);
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

  async #appendLine(filePath, item) {
    await mkdir(path.dirname(filePath), {recursive: true});
    await appendFile(filePath, formatBatchCsvLine(item), 'utf8');
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

    const mirrorRoots = collectMirrorRoots(projectConfig, this.#opts.outputDir);
    for (const mirrorRoot of mirrorRoots) {
      await assertWritableDir(mirrorRoot, 'mirror directory');
    }

    try {
      await mkdir(this.#opts.queueDir, {recursive: true});
    } catch (err) {
      throw new Error(`queue directory not writable: ${this.#opts.queueDir}`);
    }

    await sanitizeQueueDirectory(this.#opts.queueDir);

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
        res.json(apiJson({ok: true, ...(await readQueueFile(this.#opts.queueDir, req.query.file))}));
      } catch (err) {
        apiError(res, err);
      }
    });

    app.post('/api/list', async (req, res) => {
      try {
        res.status(201).json(
          apiJson({
            ok: true,
            ...(await createQueueFile(this.#opts.queueDir, req.body.file)),
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
        res.json(
          apiJson({
            ok: true,
            ...(await renameQueueFile(this.#opts.queueDir, file, newFile)),
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
            ...result,
            download: this.#scheduler.getStatus(filePath),
          }),
        );
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
    if (mirrorRoots.length)
      console.log(`[airfreyr serve] mirror directories: ${mirrorRoots.join(', ')}`);
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
