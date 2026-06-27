import path from 'path';

export const QUEUE_FILE_EXTENSION = '.json';

export function titleCaseGenreStem(stem) {
  return stem
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function genreFromQueueFilename(file) {
  const stem = path.basename(String(file).trim()).replace(/\.(json|txt)$/i, '');
  if (!stem) throw new Error('invalid queue file name');
  return titleCaseGenreStem(stem);
}

export function ensureQueueExtension(name) {
  const value = String(name || '').trim();
  if (!value) return value;
  return value.toLowerCase().endsWith('.json') ? value : `${value}.json`;
}

export function stripQueueExtension(name) {
  return String(name || '').replace(/\.(json|txt)$/i, '');
}

function escapeCsvField(field) {
  if (field == null) return '';
  const value = String(field);
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function parseCsvLine(line) {
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

function splitQueueLineBody(rawLine) {
  const disabled = /^\s*#/.test(rawLine);
  const body = rawLine.replace(/^\s*#\s?/, '');
  const noteMatch = body.match(/(\s+#.*)$/);
  const note = noteMatch ? noteMatch[1].replace(/^\s+#\s?/, '').trim() : '';
  const content = (noteMatch ? body.slice(0, noteMatch.index) : body).trim();
  return {disabled, content, note};
}

export function parseCsvQueueLine(rawLine, lineNumber, fileGenre, fileStem) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  const {disabled, content, note} = splitQueueLineBody(rawLine);
  if (!content) return null;

  const parts = parseCsvLine(content);
  const urlIndex = parts.findIndex(part => /^https?:\/\//i.test(part));
  if (urlIndex < 0) throw new Error(`line ${lineNumber}: missing http(s) URL`);

  let fields = parts.slice(0, urlIndex);
  if (fileStem && fields.length === 4 && fields[0] === fileStem) fields = fields.slice(1);

  const url = parts.slice(urlIndex).join(',').trim();
  const {genre, artist, title} = parseQueueFields(fields, fileGenre, lineNumber);
  return normalizeStoredEntry({genre, artist, title, url, disabled, note}, fileGenre);
}

export function importCsvText(text, file) {
  const fileGenre = genreFromQueueFilename(file);
  const fileStem = stripQueueExtension(path.basename(file));
  const entries = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const entry = parseCsvQueueLine(rawLine, index + 1, fileGenre, fileStem);
    if (entry) entries.push(entry);
  }
  if (!entries.length) throw new Error('no valid queue lines found');
  return entries;
}

export function normalizeStoredEntry(
  {genre, artist, title, url, path: urlAlias, disabled = false, note = ''},
  fileGenre,
) {
  const resolvedUrl = url || urlAlias || '';
  const entry = {
    artist: String(artist || '').trim(),
    title: String(title || '').trim(),
    url: String(resolvedUrl).trim(),
    disabled: !!disabled,
  };
  const trimmedNote = String(note || '').trim();
  if (trimmedNote) entry.note = trimmedNote;
  const entryGenre = String(genre || '').trim();
  if (entryGenre && entryGenre !== fileGenre) entry.genre = entryGenre;
  if (!entry.artist) throw new Error('artist is required');
  if (!entry.url) throw new Error('url is required');
  if (!/^https?:\/\//i.test(entry.url)) throw new Error('url must be an http(s) URL');
  return entry;
}

export function normalizeQueueMirrors(mirrors) {
  if (mirrors == null) return [];
  if (!Array.isArray(mirrors)) throw new Error('mirrors must be an array');
  return mirrors.map(mirror => String(mirror).trim()).filter(Boolean);
}

export function resolveQueueMirrorRoots(document, availableRoots) {
  const selected = normalizeQueueMirrors(document?.mirrors);
  if (!selected.length) return [];
  const available = new Map(
    (availableRoots || []).map(root => [path.resolve(String(root)), String(root)]),
  );
  return selected
    .map(mirror => path.resolve(mirror))
    .filter(resolved => available.has(resolved))
    .map(resolved => available.get(resolved));
}

export function queueMirrorOptions(document, availableRoots) {
  const selected = new Set(
    normalizeQueueMirrors(document?.mirrors).map(mirror => path.resolve(mirror)),
  );
  return (availableRoots || []).map(root => {
    const resolved = path.resolve(String(root));
    return {path: String(root), selected: selected.has(resolved)};
  });
}

export function emptyQueueDocument() {
  return {mirrors: [], entries: []};
}

export function serializeQueueDocument(document) {
  const payload = {entries: document.entries};
  const mirrors = normalizeQueueMirrors(document.mirrors);
  if (mirrors.length) payload.mirrors = mirrors;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseQueueDocument(text) {
  const trimmed = text.trim();
  if (!trimmed) return emptyQueueDocument();
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return {mirrors: [], entries: parsed};
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries))
    throw new Error('queue file must be a JSON object with an "entries" array');
  return {
    mirrors: normalizeQueueMirrors(parsed.mirrors),
    entries: parsed.entries,
  };
}

export function entryLabel(entry) {
  return [entry.artist, entry.title].filter(Boolean).join(' - ') || entry.url;
}

export function toApiEntry(entry, index, fileGenre) {
  const genre = entry.genre || fileGenre || '';
  return {
    line: index + 1,
    disabled: !!entry.disabled,
    genre,
    artist: entry.artist || '',
    title: entry.title || '',
    url: entry.url || '',
    note: entry.note || '',
    label: entryLabel(entry),
  };
}

export function toDownloadEntry(entry, fileGenre) {
  return {
    genre: entry.genre || fileGenre,
    artist: entry.artist,
    title: entry.title || '',
    url: entry.url,
  };
}

export function activeDownloadEntries(document, fileGenre) {
  return document.entries
    .filter(entry => !entry.disabled)
    .map(entry => toDownloadEntry(entry, fileGenre));
}
