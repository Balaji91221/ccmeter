import { classify, modelForComplexity } from './classify.mjs';
import { loadSkill, defaultSkillsRoot } from './skills.mjs';

/**
 * Offline prompt refiner: heuristics + skill templates (no API required).
 */
export function refine(rawPrompt, opts = {}) {
  const raw = String(rawPrompt || '').trim();
  if (!raw) throw new Error('prompt is empty');

  const skillsRoot = opts.skillsRoot || defaultSkillsRoot();
  const classification = classify(raw, {
    skillsRoot,
    skillForce: opts.skill || null,
  });

  let skill;
  try {
    skill = loadSkill(classification.skill, skillsRoot);
  } catch {
    skill = loadSkill('feature', skillsRoot);
    classification.skill = 'feature';
  }

  const repo = opts.repo || extractRepo(raw) || opts.cwd || process.cwd();
  const stack = opts.stack || extractStack(raw);
  const related = opts.related || [];

  const title = makeTitle(raw, classification.skill);
  const goal = makeGoal(raw, classification.skill);
  const scope = makeScope(raw, classification.skill, repo);
  const constraints = makeConstraints(classification.skill, opts);
  const acceptance = makeAcceptance(classification.skill, raw);
  const deliverables = makeDeliverables(classification.skill);
  const risks = makeRisks(classification.skill);
  const assumptions = makeAssumptions(raw, classification, repo);
  const questions = opts.ask ? makeQuestions(raw, classification.skill) : [];
  const definitionOfDone = makeDoD(classification.skill, acceptance);

  const brief = {
    version: 1,
    title,
    skill_primary: classification.skill,
    skill_secondary: classification.secondary,
    goal,
    context: {
      repo,
      cwd: opts.cwd || process.cwd(),
      stack,
      related,
    },
    scope_in: scope.in,
    scope_out: scope.out,
    constraints,
    assumptions,
    acceptance,
    deliverables,
    risks,
    definition_of_done: definitionOfDone,
    complexity: opts.complexity || classification.complexity,
    suggested_model: opts.model || modelForComplexity(opts.complexity || classification.complexity),
    questions,
    raw_user_prompt: raw,
    classification: {
      confidence: classification.confidence,
      score: classification.score,
      signals: classification.signals,
    },
  };

  brief.refined_prompt = renderTemplate(skill.template, brief);

  const token_spec = buildTokenSpec(brief, skill.defaults);

  const human_summary = [
    `Skill: ${brief.skill_primary}` +
      (brief.skill_secondary?.length ? ` (+${brief.skill_secondary.join(', ')})` : ''),
    `Complexity: ${brief.complexity} · Model: ${brief.suggested_model}`,
    `Goal: ${brief.goal}`,
    `Stages: ${(token_spec.stages || []).map((s) => s.id).join(' → ') || '—'}`,
    `Acceptance: ${brief.acceptance.length} checks · Deliverables: ${brief.deliverables.join(', ')}`,
    classification.confidence === 'low' || classification.confidence === 'none'
      ? 'Note: low classification confidence — review skill choice.'
      : null,
    questions.length ? `Questions:\n- ${questions.join('\n- ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    brief,
    token_spec,
    human_summary,
    agent_message: toAgentMessage(brief),
  };
}

function buildTokenSpec(brief, defaults) {
  const base = defaults && typeof defaults === 'object' ? structuredCloneSafe(defaults) : {};
  return {
    id: slugify(brief.title),
    brief_ref: 'brief.json',
    skill_primary: brief.skill_primary,
    model: brief.suggested_model,
    complexity: brief.complexity,
    budgets: base.budgets || {
      context_tokens: 70000,
      input_new_tokens: 12000,
      output_tokens: 4000,
      cache_prefix_stable: true,
    },
    always_keep: base.always_keep || [
      'errors',
      'user_messages',
      'current_stage_goal',
      'pass_packet',
    ],
    stages: base.stages || [],
    fail_closed: base.fail_closed || {
      if_over_budget: 'compress_then_drop_lowest_score',
      if_need_detail: 'require_ccr_retrieve',
    },
    goal: brief.goal,
    acceptance: brief.acceptance,
  };
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function renderTemplate(template, brief) {
  if (!template) return brief.goal;
  const list = (arr) =>
    (arr || []).length ? (arr || []).map((x) => `- ${x}`).join('\n') : '- (none)';
  const ctx = brief.context || {};
  const map = {
    goal: brief.goal,
    repo: ctx.repo || '—',
    stack: (ctx.stack || []).join(', ') || '—',
    related: (ctx.related || []).join(', ') || '—',
    scope_in: list(brief.scope_in),
    scope_out: list(brief.scope_out),
    constraints: list(brief.constraints),
    assumptions: list(brief.assumptions),
    acceptance: list(brief.acceptance),
    deliverables: list(brief.deliverables),
    risks: list(brief.risks),
    definition_of_done: brief.definition_of_done,
    raw_user_prompt: brief.raw_user_prompt,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));
}

function toAgentMessage(brief) {
  return [
    brief.refined_prompt?.trim() || brief.goal,
    '',
    '---',
    'Follow the Engineering Brief above. Do not expand scope_out.',
    `Primary skill: ${brief.skill_primary}. Complexity: ${brief.complexity}.`,
    'Work stage-by-stage; keep intermediate findings concise.',
  ].join('\n');
}

function makeTitle(raw, skill) {
  const clean = raw.replace(/\s+/g, ' ').trim();
  const short = clean.length > 72 ? clean.slice(0, 69) + '…' : clean;
  const prefix = skill.charAt(0).toUpperCase() + skill.slice(1);
  return `${prefix}: ${short}`;
}

function makeGoal(raw, skill) {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  // Vague "update/continue the plan" → skill-shaped goal
  if (skill === 'revamp' && /revamp|folder structure|project structure|overhaul|redesign|update the (entire )?plan/i.test(cleaned)) {
    const target = extractPathish(cleaned) || cleaned.replace(/update the entire revamp plan for\s*/i, '').trim() || 'the codebase';
    return ensurePeriod(`Produce an updated revamp plan for ${target}: current map, target layout, migration phases, risks, and acceptance checks`);
  }
  if (skill === 'debug' && /^(fix|debug)\b/i.test(cleaned)) {
    return ensurePeriod(`Diagnose and fix: ${cleaned.replace(/^(fix|debug)\s*/i, '')}`);
  }
  // If already imperative and long enough, keep near-literal
  if (cleaned.length > 40 && /^(fix|add|implement|refactor|revamp|test|build)/i.test(cleaned)) {
    return ensurePeriod(cleaned);
  }
  const verbs = {
    debug: 'Diagnose and fix',
    feature: 'Implement',
    refactor: 'Refactor',
    revamp: 'Produce a revamp plan for',
    test: 'Add/improve tests for',
  };
  const v = verbs[skill] || 'Complete';
  return ensurePeriod(`${v}: ${cleaned}`);
}

function makeScope(raw, skill, repo) {
  const area = extractPathish(raw) || repo;
  const commonOut = [
    'Unrelated refactors',
    'Drive-by dependency upgrades',
    'Scope not listed in acceptance',
  ];
  switch (skill) {
    case 'debug':
      return {
        in: [
          `Failing behavior described in the request`,
          `Minimal fix path in ${area}`,
          'Verification of the failing scenario',
        ],
        out: ['Large redesign', ...commonOut],
      };
    case 'feature':
      return {
        in: [
          `Feature described: ${clip(raw, 120)}`,
          'Thin vertical slice + tests',
          `Code under ${area}`,
        ],
        out: ['Multi-feature roadmap', 'Unrelated polish', ...commonOut],
      };
    case 'refactor':
      return {
        in: [
          `Structural improvement for ${area}`,
          'Behavior-preserving changes with tests green',
        ],
        out: ['New product features', 'Public API breaks (unless stated)', ...commonOut],
      };
    case 'revamp':
      return {
        in: [
          `Current structure map of ${area}`,
          'Target folder/module layout',
          'Migration phases, risks, rollback notes',
          'Plan document / tree (implementation only if explicitly requested)',
        ],
        out: [
          'Full rewrite in one shot without a plan',
          'Unrelated product features',
          ...commonOut,
        ],
      };
    case 'test':
      return {
        in: [
          `Tests for behavior in ${area}`,
          'Happy path + at least one failure/edge case',
        ],
        out: ['Production feature changes unrelated to testability', ...commonOut],
      };
    default:
      return { in: [clip(raw, 160)], out: commonOut };
  }
}

function makeConstraints(skill, opts) {
  const base = [
    'Prefer minimal, reviewable diffs',
    'Do not invent product requirements not implied by the user',
    'State assumptions explicitly',
  ];
  if (opts.constraints) return [...opts.constraints, ...base];
  if (skill === 'debug') {
    return ['No drive-by refactors while fixing', 'Preserve production safety', ...base];
  }
  if (skill === 'refactor' || skill === 'revamp') {
    return [
      'Do not break public APIs unless listed in scope',
      'Keep tests green after each incremental step',
      ...base,
    ];
  }
  if (skill === 'feature') {
    return ['Match existing code style and patterns', 'Include tests for new behavior', ...base];
  }
  return base;
}

function makeAcceptance(skill, raw) {
  switch (skill) {
    case 'debug':
      return [
        'Root cause identified with evidence (or blocker documented)',
        'Fix applied for the reported failure path',
        'Failing scenario verified; no unexplained behavior change',
      ];
    case 'feature':
      return [
        'Feature works for the stated happy path',
        'At least one failure/edge path handled or tested',
        'Deliverables listed in the brief exist',
      ];
    case 'refactor':
      return [
        'Structure matches the stated goal',
        'Existing tests pass (or updated for moves only)',
        'Public behavior unchanged unless explicitly scoped',
      ];
    case 'revamp':
      return [
        'Current structure map is present and accurate enough to act on',
        'Target layout + module boundaries documented',
        'Migration phases, risks, and rollback notes included',
        'Acceptance checklist in the plan is testable',
      ];
    case 'test':
      return [
        'Named test cases exist for the risk under scope',
        'Targeted test suite passes',
        'Residual coverage gaps listed if any',
      ];
    default:
      return [`Request completed as specified: ${clip(raw, 100)}`];
  }
}

function makeDeliverables(skill) {
  switch (skill) {
    case 'debug':
      return ['Root-cause note', 'Code fix', 'Verification notes'];
    case 'feature':
      return ['Implementation', 'Tests', 'Short usage note'];
    case 'refactor':
      return ['Refactored modules', 'Behavior-preservation summary'];
    case 'revamp':
      return ['Structure map', 'Target tree', 'Migration plan', 'Risks/rollback'];
    case 'test':
      return ['New/updated tests', 'How to run them'];
    default:
      return ['Completed work summary'];
  }
}

function makeRisks(skill) {
  switch (skill) {
    case 'debug':
      return ['Misdiagnosed root cause', 'Regressions in adjacent paths'];
    case 'feature':
      return ['Scope creep', 'Missing edge cases'];
    case 'refactor':
      return ['Hidden behavior couples', 'Import cycles'];
    case 'revamp':
      return ['Migration downtime', 'Broken imports during moves', 'Plan without ownership'];
    case 'test':
      return ['Flaky tests', 'Testing implementation details only'];
    default:
      return [];
  }
}

function makeAssumptions(raw, classification, repo) {
  const a = [`Working tree / focus area is ${repo}`];
  if (classification.confidence === 'low' || classification.confidence === 'none') {
    a.push(`Skill "${classification.skill}" was inferred with low confidence`);
  }
  if (/continue/i.test(raw)) {
    a.push('User wants continuation of prior work; use latest plan/state if available');
  }
  if (!extractPathish(raw)) {
    a.push('No explicit path in prompt — using current working directory as context.repo');
  }
  return a;
}

function makeQuestions(raw, skill) {
  const q = [];
  if (!extractPathish(raw)) q.push('Which repo path or package is in scope?');
  if (skill === 'debug' && !/error|stack|fail|exception/i.test(raw)) {
    q.push('What is the exact error message or failing command?');
  }
  if (skill === 'revamp' && !/implement|code|apply/i.test(raw)) {
    q.push('Plan only, or also implement the first migration phase?');
  }
  if (skill === 'feature' && raw.length < 40) {
    q.push('What is the user-visible success criterion for this feature?');
  }
  return q.slice(0, 3);
}

function makeDoD(skill, acceptance) {
  return `All acceptance criteria satisfied (${acceptance.length} items) for skill "${skill}", with constraints respected and residual risks listed.`;
}

function extractRepo(raw) {
  const m =
    raw.match(/(\/[\w.@-]+(?:\/[\w.@-]+)+)/) ||
    raw.match(/\b([\w-]+\/[\w.-]+)\b/) ||
    raw.match(/\bfor\s+([a-zA-Z][\w.-]{2,})\b/) ||
    raw.match(/\bin\s+([a-zA-Z][\w.-]{2,})\b/);
  if (!m) return null;
  const stop = new Set(['the', 'this', 'that', 'our', 'my', 'a', 'an', 'checkout', 'login', 'flow']);
  if (stop.has(m[1].toLowerCase())) return null;
  return m[1];
}

function extractPathish(raw) {
  return extractRepo(raw);
}

function extractStack(raw) {
  const stacks = [];
  const map = [
    [/python|django|fastapi|pytest/i, 'python'],
    [/node|typescript|javascript|react|next/i, 'typescript'],
    [/rust|cargo/i, 'rust'],
    [/go\b|golang/i, 'go'],
    [/java\b|spring/i, 'java'],
    [/agent|claude|llm/i, 'agents'],
  ];
  for (const [re, name] of map) {
    if (re.test(raw) && !stacks.includes(name)) stacks.push(name);
  }
  return stacks;
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function ensurePeriod(s) {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : t + '.';
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
