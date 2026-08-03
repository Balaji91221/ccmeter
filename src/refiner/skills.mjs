import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default skills root: <repo>/skills */
export function defaultSkillsRoot() {
  return join(__dirname, '../../skills');
}

/**
 * Minimal indentation-based YAML parser for steward.defaults.yaml.
 * Supports nested maps, arrays of scalars, and arrays of maps.
 */
export function parseYamlReliable(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  '))
    .filter((raw) => raw.trim() && !raw.trim().startsWith('#'))
    .map((raw) => raw);

  function parseBlock(startIdx, baseIndent) {
    const map = {};
    let i = startIdx;

    while (i < lines.length) {
      const raw = lines[i];
      const indent = raw.match(/^ */)[0].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        i++;
        continue;
      }
      const t = raw.trim();
      if (t.startsWith('- ')) break;

      const m = /^([\w.-]+):\s*(.*)$/.exec(t);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1];
      const val = m[2];

      if (val !== '') {
        map[key] = coerce(val);
        i++;
        continue;
      }

      const next = lines[i + 1];
      if (!next) {
        map[key] = null;
        i++;
        continue;
      }
      const nextIndent = next.match(/^ */)[0].length;
      const nextT = next.trim();
      if (nextIndent <= indent) {
        map[key] = null;
        i++;
        continue;
      }
      if (nextT.startsWith('- ')) {
        const r = parseArray(i + 1, nextIndent);
        map[key] = r.value;
        i = r.nextIndex;
      } else {
        const r = parseBlock(i + 1, nextIndent);
        map[key] = r.value;
        i = r.nextIndex;
      }
    }
    return { value: map, nextIndex: i };
  }

  function parseArray(startIdx, baseIndent) {
    const arr = [];
    let i = startIdx;
    while (i < lines.length) {
      const raw = lines[i];
      const indent = raw.match(/^ */)[0].length;
      if (indent < baseIndent) break;
      const t = raw.trim();
      if (indent === baseIndent && !t.startsWith('- ')) break;
      if (indent > baseIndent) {
        i++;
        continue;
      }
      if (!t.startsWith('- ')) break;

      const rest = t.slice(2).trim();
      if (rest === '') {
        i++;
        continue;
      }

      // Map item: - id: explore
      if (/^[\w.-]+:\s*/.test(rest)) {
        const obj = {};
        const first = /^([\w.-]+):\s*(.*)$/.exec(rest);
        if (first) {
          if (first[2] !== '') {
            obj[first[1]] = coerce(first[2]);
          } else {
            const next = lines[i + 1];
            if (next && next.match(/^ */)[0].length > baseIndent) {
              const ni = next.match(/^ */)[0].length;
              if (next.trim().startsWith('- ')) {
                const r = parseArray(i + 1, ni);
                obj[first[1]] = r.value;
                i = r.nextIndex - 1;
              } else {
                const r = parseBlock(i + 1, ni);
                obj[first[1]] = r.value;
                i = r.nextIndex - 1;
              }
            } else {
              obj[first[1]] = null;
            }
          }
        }
        i++;
        // Sibling keys of this map item (indent > baseIndent)
        while (i < lines.length) {
          const r2 = lines[i];
          const ind2 = r2.match(/^ */)[0].length;
          const t2 = r2.trim();
          if (ind2 <= baseIndent) break;
          if (t2.startsWith('- ')) break;
          const fm = /^([\w.-]+):\s*(.*)$/.exec(t2);
          if (!fm) {
            i++;
            continue;
          }
          if (fm[2] !== '') {
            obj[fm[1]] = coerce(fm[2]);
            i++;
          } else {
            const next = lines[i + 1];
            if (next && next.match(/^ */)[0].length > ind2) {
              const ni = next.match(/^ */)[0].length;
              if (next.trim().startsWith('- ')) {
                const r = parseArray(i + 1, ni);
                obj[fm[1]] = r.value;
                i = r.nextIndex;
              } else {
                const r = parseBlock(i + 1, ni);
                obj[fm[1]] = r.value;
                i = r.nextIndex;
              }
            } else {
              obj[fm[1]] = null;
              i++;
            }
          }
        }
        arr.push(obj);
        continue;
      }

      arr.push(coerce(rest));
      i++;
    }
    return { value: arr, nextIndex: i };
  }

  const { value } = parseBlock(0, 0);
  return value;
}

function coerce(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => coerce(x.trim()))
      .filter((x) => x !== '');
  }
  return s;
}

export function listSkills(skillsRoot = defaultSkillsRoot()) {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

export function loadSkill(name, skillsRoot = defaultSkillsRoot()) {
  const dir = join(skillsRoot, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`unknown skill: ${name}`);
  }
  const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const templatePath = join(dir, 'prompt.template.md');
  const defaultsPath = join(dir, 'steward.defaults.yaml');
  const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';
  const defaults = existsSync(defaultsPath)
    ? parseYamlReliable(readFileSync(defaultsPath, 'utf8'))
    : { skill: name, stages: [] };

  return {
    name,
    dir,
    skillMd,
    template,
    defaults,
    triggers: extractTriggers(skillMd),
  };
}

function extractTriggers(skillMd) {
  const m = /^##\s*Trigger\s*\n+([^\n#]+)/im.exec(skillMd);
  if (!m) return [];
  return m[1]
    .split(/,/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadAllSkills(skillsRoot = defaultSkillsRoot()) {
  return listSkills(skillsRoot).map((n) => loadSkill(n, skillsRoot));
}
