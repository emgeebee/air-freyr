# @emgeebee/airfreyr

Download music from Deezer and YouTube. Fork of [freyr-js](https://github.com/miraclx/freyr-js) with an HTTP queue server for remote track requests.

## Requirements

- Node.js >= 16
- Python >= 3.2 (for `youtube-dl-exec`)
- [AtomicParsley](https://github.com/miraclx/atomicparsley/releases) on your `PATH`

## Installation

```bash
npm install -g @emgeebee/airfreyr
# or
npx @emgeebee/airfreyr <command>
```

From source:

```bash
git clone https://github.com/emgeebee/air-freyr.git && cd air-freyr
npm install && npm link
```

## Queue server

Run an HTTP server that appends tracks to queue files and triggers downloads automatically.

```bash
airfreyr serve
```

### Configuration

Precedence: CLI flags → environment variables → `conf.json` → defaults.

| Flag | Env | `conf.json` | Purpose |
| --- | --- | --- | --- |
| `-q, --queue-dir <DIR>` | `AIRFREYR_QUEUE_DIR` | `serve.queueDir` | Queue `.txt` files directory |
| `-D, --output-dir <DIR>` | `AIRFREYR_OUTPUT_DIR` | `dirs.output` | Download output directory |
| `-p, --port <PORT>` | `AIRFREYR_PORT` | `serve.port` | Listen port (default: `3797`) |
| `-H, --hostname <HOST>` | `AIRFREYR_HOSTNAME` | `serve.hostname` | Bind address |

```json
"serve": {
  "hostname": "localhost",
  "port": 3797,
  "queueDir": "."
},
"dirs": {
  "output": "./0"
}
```

Downloads use `dirs.output` unless overridden by `-D` or `AIRFREYR_OUTPUT_DIR`.

```bash
AIRFREYR_QUEUE_DIR=./queues AIRFREYR_OUTPUT_DIR=./music airfreyr serve
```

### API

All responses include `"version"` (the running `@emgeebee/airfreyr` package version).

**POST `/add`** — append a track and start downloading the queue file.

```json
{
  "file": "arlo.txt",
  "genre": "Kids",
  "artist": "Moana",
  "title": "You're Welcome",
  "path": "https://www.youtube.com/watch?v=G8QjumNNNBY"
}
```

- `title` is optional
- `path` can also be sent as `url`
- Existing tracks in the file are skipped; only new lines are downloaded
- If a download is already running for that file, another run is queued when it finishes

**GET `/status?file=arlo.txt`** — check whether a download is in progress (includes `lastError` if the last run failed)

```bash
curl 'http://<nas-ip>:3797/status?file=arlo.txt'
```

Example when a download failed:

```json
{
  "version": "1.0.1",
  "ok": true,
  "file": "arlo.txt",
  "download": {
    "running": false,
    "pending": false,
    "lastError": "airfreyr exited with code 2",
    "lastExitCode": 2,
    "lastStartedAt": "2026-06-22T20:15:00.000Z",
    "lastFinishedAt": "2026-06-22T20:15:42.000Z"
  }
}
```

If `lastError` is set, check container logs for detail: `sudo docker logs --tail 100 airfreyr`

**GET `/health`** — server status and configured directories

```bash
curl -X POST http://localhost:3797/add \
  -H 'Content-Type: application/json' \
  -d '{"file":"arlo.txt","genre":"Kids","artist":"Moana","title":"You'\''re Welcome","path":"https://www.youtube.com/watch?v=G8QjumNNNBY"}'
```

## Batch downloads

Download tracks listed in a queue file:

```bash
airfreyr -i arlo.txt
airfreyr -i arlo.txt -d ./music   # custom output directory
```

### Queue file format

One track per line as CSV: `genre,artist,title,url`

`title` is optional (legacy 3-column rows: `genre,artist,url`). Lines starting with `#` are comments.

```text
Kids,Moana,You're Welcome,https://www.youtube.com/watch?v=G8QjumNNNBY
Kids,Peppa Pig,Jumping in Muddy Puddles,https://www.youtube.com/watch?v=t7dTdE8Aqtw
Dance,LMFAO,,https://www.youtube.com/watch?v=wyx6JDQCslE
```

Files are organised as `<output>/<genre>/youtube/<artist> - <title>.<format>`.

## CLI

```bash
airfreyr <url-or-uri>              # download a single track
airfreyr -i queue.txt              # batch download from file
airfreyr serve                     # start the queue server
airfreyr urify <url>               # convert URLs to service URIs
airfreyr --help                    # full options
```

Common flags:

| Flag | Purpose |
| --- | --- |
| `-d, --directory <DIR>` | Output directory |
| `-f, --force` | Overwrite existing files |
| `-b, --bitrate <N>` | Audio bitrate (default: `320k`) |
| `-x, --format <FORMAT>` | Output format (default: `mp3`) |
| `--no-logo` / `--no-header` | Quieter output |

## Configuration

On first run, airfreyr creates a user config file with service credentials and defaults:

- Linux: `~/.config/AirFreyr/d3fault.x4p`
- macOS: `~/Library/Preferences/AirFreyr/d3fault.x4p`

Project defaults live in [`conf.json`](conf.json). Use `-o, --config <FILE>` to point at an alternative.

## Docker (queue server)

A minimal `node:20-alpine` image runs `npx @emgeebee/airfreyr@latest serve` and **restarts every 3 hours** to pull the latest npm publish.

### Quick start (build once)

```bash
mkdir -p docker/queues docker/music docker/config
cp docker/conf.json.example docker/config/conf.json

cd docker
docker compose up --build
```

### No build — plain `node:alpine`

If you only want the stock Node image plus a mounted entrypoint script:

```bash
cd docker
docker compose -f compose.alpine.yml up -d
```

This uses `node:20-alpine` directly. Python is installed on first start (`apk add python3 bash`), then the entrypoint runs `npx`.

Queue files go in `docker/queues/` (e.g. `arlo.txt`). Downloads land in `docker/music/`.

### `docker run` (without compose)

```bash
docker build -f docker/Dockerfile -t airfreyr-serve .

docker run -d --name airfreyr \
  --restart unless-stopped \
  -p 3797:3797 \
  -e AIRFREYR_HOSTNAME=0.0.0.0 \
  -e AIRFREYR_REFRESH_HOURS=3 \
  -v "$PWD/queues:/data/queues" \
  -v "$PWD/music:/data/music" \
  -v "$PWD/config:/data/config" \
  airfreyr-serve
```

Put `conf.json` at `config/conf.json` inside the mounted config volume.

### Synology Container Manager

Use [`docker/synology-compose.yml`](docker/synology-compose.yml) and [`docker/conf.json.example`](docker/conf.json.example).

#### 1. Create folders on the NAS

In **File Station**, create:

```text
/volume1/docker/airfreyr/queues    ← queue .txt files (arlo.txt, pop.txt, …)
/volume1/docker/airfreyr/music     ← downloaded tracks
/volume1/docker/airfreyr/config    ← conf.json
```

Change `volume1` if your shared folder lives on a different volume.

#### 2. Copy config and compose onto the NAS

| NAS path | Source in repo |
| --- | --- |
| `/volume1/docker/airfreyr/config/conf.json` | `docker/conf.json.example` |
| `/volume1/docker/airfreyr/docker-compose.yml` | `docker/synology-compose.yml` |

Edit paths in `docker-compose.yml` if not using `volume1`. Put queue files in `queues/`.

#### 3. Create the container project

**Container Manager → Project → Create**

- **Project name:** `airfreyr`
- **Path:** `/volume1/docker/airfreyr/docker-compose.yml`
- Start the project (pulls `node:20-alpine`, no build step)

#### Directory mappings

| NAS folder | Container path | Purpose |
| --- | --- | --- |
| `/volume1/docker/airfreyr/queues` | `/data/queues` | Queue `.txt` files |
| `/volume1/docker/airfreyr/music` | `/data/music` | Downloaded music |
| `/volume1/docker/airfreyr/config` | `/data/config` | `conf.json` (+ saved auth after first run) |

#### Port

Map host port **3797** → container **3797**. Then from your LAN:

```bash
curl http://<nas-ip>:3797/health
```

#### Manual container (UI fields)

If you prefer **Container → Create** instead of a Project:

| Setting | Value |
| --- | --- |
| Image | `node:20-alpine` |
| Command | `apk add --no-cache python3 bash && exec /entrypoint.sh` |
| Entrypoint | mount `serve-entrypoint.sh` → `/entrypoint.sh` |
| Port | `3797:3797` |
| `AIRFREYR_HOSTNAME` | `0.0.0.0` |
| `AIRFREYR_QUEUE_DIR` | `/data/queues` |
| `AIRFREYR_OUTPUT_DIR` | `/data/music` |
| `AIRFREYR_CONFIG` | `/data/config/conf.json` |
| Volume | `/volume1/docker/airfreyr/queues` → `/data/queues` |
| Volume | `/volume1/docker/airfreyr/music` → `/data/music` |
| Volume | `/volume1/docker/airfreyr/config` → `/data/config` |
| Restart policy | Unless stopped |

The container runs `npx @emgeebee/airfreyr@latest serve` and refreshes every 3 hours.

#### "Build project failed" (no useful logs)

Synology often shows only `Build project '…' failed` with no detail. The real error is elsewhere.

**1. Check the folders exist first** (most common cause):

```bash
ls -la /volume1/docker/airfreyr/queues
ls -la /volume1/docker/airfreyr/music
ls -la /volume1/docker/airfreyr/config/conf.json
```

Synology will fail if any mapped folder or `conf.json` is missing.

**2. Get the real error via SSH** (Control Panel → Terminal & SNMP → Enable SSH):

```bash
cd /volume1/docker/airfreyr
sudo docker compose config          # validate compose syntax
sudo docker compose up              # run in foreground — errors print here
# or after a failed project start:
sudo docker compose logs --tail 50
sudo docker logs airfreyr 2>&1
```

**3. In Container Manager UI**

- **Container** → select `airfreyr` → **Details** → **Log** tab (runtime logs, after container starts)
- **Project** → your project → **Action** → delete and recreate after fixing paths
- **Log Center** → search for `docker` / `container` around the failure time

**4. Common fixes**

| Problem | Fix |
| --- | --- |
| Volume path wrong | Use absolute paths; edit `volume1` in `docker-compose.yml` |
| `conf.json` missing | Copy `docker/conf.json.example` to `config/conf.json` |
| Old project stuck | Delete project + container, recreate |
| Still using `build:` | Use `docker/synology-compose.yml` — it has no build step |
| Port in use | Change `3797:3797` to e.g. `3798:3797` |

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AIRFREYR_HOSTNAME` | `0.0.0.0` | Bind address (use `0.0.0.0` in Docker) |
| `AIRFREYR_PORT` | `3797` | HTTP port |
| `AIRFREYR_QUEUE_DIR` | `/data/queues` | Queue `.txt` directory |
| `AIRFREYR_OUTPUT_DIR` | `/data/music` | Download output directory |
| `AIRFREYR_CONFIG` | `/data/config/conf.json` | Config file for download runs |
| `AIRFREYR_REFRESH_HOURS` | `3` | Restart interval to pull latest from npm |
| `AIRFREYR_REFRESH_SECONDS` | — | Override refresh interval in seconds |

On each restart the entrypoint clears the npx cache and runs `npx --yes @emgeebee/airfreyr@latest serve`.

## Publishing to npm

Pushes to `main` or `master` run [`.github/workflows/publish.yml`](.github/workflows/publish.yml), matching the simple pipeline in [phone_cli](https://github.com/emgeebee/cli):

1. `npm ci`
2. `npm publish --access public`

Uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no `NPM_TOKEN` secret). On npmjs.com, link the GitHub repo to the `@emgeebee` scope before the first publish.

You can also trigger manually: **Actions → publish → Run workflow**.

### Test the API

```bash
curl http://localhost:3797/health

curl -X POST http://localhost:3797/add \
  -H 'Content-Type: application/json' \
  -d '{"file":"arlo.txt","genre":"Kids","artist":"Moana","title":"You'\''re Welcome","path":"https://www.youtube.com/watch?v=G8QjumNNNBY"}'
```

## License

Apache-2.0. Based on [freyr-js](https://github.com/miraclx/freyr-js) by Miraculous Owonubi.
