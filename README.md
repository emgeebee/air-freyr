# @emgeebee/airfreyr

Download music from Spotify, Apple Music, Deezer, and YouTube. Fork of [freyr-js](https://github.com/miraclx/freyr-js) with an HTTP queue server for remote track requests.

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

**GET `/status?file=arlo.txt`** — check whether a download is in progress

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

A lightweight image runs `npx @emgeebee/airfreyr@latest serve` and **restarts every 3 hours** so npm fetches the newest publish.

### Quick start

```bash
mkdir -p docker/queues docker/music docker/config
cp conf.json docker/config/conf.json   # edit paths/services as needed

cd docker
docker compose up --build
```

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
