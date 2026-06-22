import { spawn } from 'child_process';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import cors from 'cors';
import express from 'express';

const CLI_PATH = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'cli.js');
const DEFAULT_CONF_PATH = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'conf.json');

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
    const state = this.#state.get(filePath) || {running: false, pending: false};
    this.#state.set(filePath, state);
    if (state.running) {
      state.pending = true;
      return;
    }
    this.#run(filePath, runner, state);
  }

  getStatus(filePath) {
    return this.#state.get(filePath) || {running: false, pending: false};
  }

  #run(filePath, runner, state) {
    state.running = true;
    runner(filePath)
      .catch(err => {
        console.error(`[airfreyr serve] download failed for ${filePath}: ${err.message}`);
      })
      .finally(() => {
        state.running = false;
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
      const args = [CLI_PATH, '-i', filePath, '--no-logo', '--no-header', ...this.#opts.extraCliArgs];
      if (this.#opts.outputDir) args.push('-d', this.#opts.outputDir);
      if (this.#opts.config) args.push('-o', this.#opts.config);
      const child = spawn(process.execPath, args, {
        cwd: this.#opts.queueDir,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`airfreyr exited with code ${code}`));
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

    const app = express().use(cors()).use(express.json({limit: '64kb'}));

    app.get('/health', (_req, res) => {
      res.json({
        ok: true,
        queueDir: path.resolve(this.#opts.queueDir),
        outputDir: this.#opts.outputDir ? path.resolve(this.#opts.outputDir) : null,
      });
    });

    app.post('/add', async (req, res) => {
      try {
        const item = normalizeAddPayload(req.body);
        const filePath = resolveQueueFile(this.#opts.queueDir, item.file);
        const line = formatBatchCsvLine(item).trimEnd();
        await this.#appendLine(filePath, item);
        this.#scheduler.schedule(filePath, fp => this.#spawnDownload(fp));
        res.status(201).json({
          ok: true,
          file: item.file,
          filePath,
          line,
          download: this.#scheduler.getStatus(filePath),
        });
      } catch (err) {
        res.status(400).json({ok: false, error: err.message});
      }
    });

    app.get('/status', (req, res) => {
      try {
        const filePath = resolveQueueFile(this.#opts.queueDir, req.query.file);
        res.json({ok: true, file: req.query.file, download: this.#scheduler.getStatus(filePath)});
      } catch (err) {
        res.status(400).json({ok: false, error: err.message});
      }
    });

    await new Promise((resolve, reject) => {
      this.#server = app.listen(this.#opts.port, this.#opts.hostname, resolve);
      this.#server.on('error', reject);
    });

    console.log(`[airfreyr serve] listening on ${this.baseUrl}`);
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
