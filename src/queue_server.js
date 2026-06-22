import { spawn } from 'child_process';
import { readFileSync, constants as fsConstants } from 'fs';
import { access, appendFile, mkdir, readFile } from 'fs/promises';
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
  return text.replace(/\x1b\[[0-9;]*m/g, '');
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

    app.get('/health', (_req, res) => {
      res.json(
        apiJson({
          ok: true,
          queueDir: path.resolve(this.#opts.queueDir),
          outputDir: this.#opts.outputDir ? path.resolve(this.#opts.outputDir) : null,
        }),
      );
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
        res.status(400).json(apiJson({ok: false, error: err.message}));
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
        res.status(400).json(apiJson({ok: false, error: err.message}));
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
