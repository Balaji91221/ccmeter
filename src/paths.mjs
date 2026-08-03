import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

/**
 * Candidate roots that hold `projects/<encoded-cwd>/<session-id>.jsonl`.
 * Claude Code honours CLAUDE_CONFIG_DIR and has used both ~/.claude and
 * the XDG location across versions, so check all of them.
 */
export function dataRoots({ dir } = {}) {
  if (dir) return [dir];
  if (process.env.CCMETER_DIR) return [process.env.CCMETER_DIR];

  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const d of process.env.CLAUDE_CONFIG_DIR.split(',')) candidates.push(d.trim());
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  candidates.push(join(homedir(), '.claude'), join(xdg, 'claude'));

  const roots = [];
  for (const c of candidates) {
    const p = join(c, 'projects');
    if (existsSync(p) && statSync(p).isDirectory() && !roots.includes(p)) roots.push(p);
  }
  return roots;
}

/** Config lives next to our own state, not inside Claude's directory. */
export function configDir() {
  if (process.env.CCMETER_CONFIG_DIR) return process.env.CCMETER_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'ccmeter');
}

export function configPath(name) {
  return join(configDir(), name);
}

/**
 * Claude encodes a project's working directory into a flat folder name by
 * replacing path separators (and dots) with dashes:
 *   /Users/ada/dev/my.app  ->  -Users-ada-dev-my-app
 * The mapping is lossy, so we cannot perfectly invert it. We recover the
 * real cwd from the `cwd` field inside the transcript when available and
 * fall back to a readable guess here.
 */
export function decodeProjectDir(dirName) {
  const trimmed = dirName.replace(/^-+/, '');
  const guessPath = '/' + trimmed.replace(/-/g, '/');
  return { encoded: dirName, guessPath, short: trimmed.split('-').pop() || dirName };
}

/** All `<root>/<encoded>` project folders across every data root. */
export function listProjectDirs(opts = {}) {
  const out = [];
  for (const root of dataRoots(opts)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      out.push({ root, dirName: e.name, path: join(root, e.name), ...decodeProjectDir(e.name) });
    }
  }
  return out;
}

/** All session transcript files, optionally filtered to one project. */
export function listTranscripts(opts = {}) {
  const files = [];
  for (const proj of listProjectDirs(opts)) {
    let entries;
    try {
      entries = readdirSync(proj.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      files.push({
        file: join(proj.path, e.name),
        sessionId: basename(e.name, '.jsonl'),
        projectDir: proj.dirName,
        projectGuess: proj.guessPath,
        projectShort: proj.short,
      });
    }
  }
  return files;
}
