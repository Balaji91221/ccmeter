import { loadAllSkills } from './skills.mjs';

/**
 * Keyword / heuristic intent classification.
 * Returns { skill, score, secondary, complexity, signals }
 */
export function classify(prompt, { skillsRoot, skillForce } = {}) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();

  if (skillForce) {
    return {
      skill: skillForce,
      score: 1,
      secondary: [],
      complexity: estimateComplexity(text),
      signals: [`forced:${skillForce}`],
      confidence: 'high',
    };
  }

  const skills = loadAllSkills(skillsRoot);
  const scores = new Map();
  const signals = [];

  for (const sk of skills) {
    let score = 0;
    for (const t of sk.triggers) {
      if (!t) continue;
      if (lower.includes(t)) {
        score += t.length > 6 ? 2 : 1.2;
        signals.push(`${sk.name}:${t}`);
      }
    }
    // word-boundary-ish boost for short tokens
    for (const t of sk.triggers) {
      if (t.length <= 4) {
        const re = new RegExp(`\\b${escapeRe(t)}\\b`, 'i');
        if (re.test(text)) score += 0.5;
      }
    }
    scores.set(sk.name, score);
  }

  // Extra phrase heuristics
  const extras = [
    [/revamp|re-?architect|folder structure|project structure|overhaul/i, 'revamp', 3],
    [/refactor|cleanup|restructure|extract module|dedupe/i, 'refactor', 2.5],
    [/fix|bug|broken|stacktrace|exception|crash|not working|failing/i, 'debug', 2.5],
    [/unit test|e2e|coverage|pytest|jest|write tests|add tests/i, 'test', 2.5],
    [/add |implement |build |create |new feature|endpoint/i, 'feature', 1.8],
    [/continue|update the (entire )?plan/i, 'revamp', 1.5],
  ];
  for (const [re, skill, w] of extras) {
    if (re.test(text)) {
      scores.set(skill, (scores.get(skill) || 0) + w);
      signals.push(`heuristic:${skill}`);
    }
  }

  let best = 'unknown';
  let bestScore = 0;
  for (const [k, v] of scores) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }

  const secondary = [...scores.entries()]
    .filter(([k, v]) => k !== best && v >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);

  const complexity = estimateComplexity(text);
  const confidence =
    bestScore >= 3 ? 'high' : bestScore >= 1.5 ? 'medium' : bestScore > 0 ? 'low' : 'none';

  if (bestScore === 0) best = 'feature'; // safe default for "do something"

  return {
    skill: best,
    score: bestScore,
    secondary,
    complexity,
    signals,
    confidence,
  };
}

function estimateComplexity(text) {
  const t = text.toLowerCase();
  let score = 0;
  if (t.length > 280) score += 1;
  if (t.length > 600) score += 1;
  if (/entire|whole|all modules|monorepo|migrate|revamp|redesign|architecture/i.test(t)) score += 2;
  if (/production|incident|sev|outage|security|auth/i.test(t)) score += 1;
  if (/and then|also|plus|as well as/i.test(t)) score += 1;
  if (/quick|typo|rename|one line/i.test(t)) score -= 1;
  if (score >= 3) return 'XL';
  if (score >= 2) return 'L';
  if (score >= 1) return 'M';
  return 'S';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function modelForComplexity(c) {
  switch (c) {
    case 'S':
      return 'claude-haiku-4.5';
    case 'M':
      return 'claude-sonnet-5';
    case 'L':
      return 'claude-sonnet-5';
    case 'XL':
      return 'claude-opus-5';
    default:
      return 'claude-sonnet-5';
  }
}
