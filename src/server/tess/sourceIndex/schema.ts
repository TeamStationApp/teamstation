/** The build and reader must agree before serving any source. */
export const SCHEMA_VERSION = 1

/** The compact map travels in every cached system prompt, so it stays small. */
export const DIRECTORY_MAP_LIMIT = 4000

/** Why a map cannot travel in the prompt, or undefined when it can. */
export function directoryMapProblem(map: string): string | undefined {
  if (map.trim() === '') return 'src/DIRECTORY_MAP.md is empty'
  if (map.length > DIRECTORY_MAP_LIMIT)
    return `src/DIRECTORY_MAP.md is ${map.length} characters; the limit is ${DIRECTORY_MAP_LIMIT}`
  return undefined
}

export const SOURCE_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  directory TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('code', 'test', 'fixture')),
  lines INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX files_directory ON files(directory);
CREATE TABLE entries (
  parent TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  PRIMARY KEY (parent, name)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE search USING fts5(
  content, content = 'files', content_rowid = 'id',
  tokenize = 'trigram case_sensitive 1', detail = 'none'
);
CREATE TABLE symbols (
  path TEXT NOT NULL REFERENCES files(path), name TEXT NOT NULL,
  kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature TEXT NOT NULL, doc TEXT
);
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_path ON symbols(path, line);
`
