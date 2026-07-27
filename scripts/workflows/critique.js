export const meta = {
  name: 'blackout-critique',
  description: 'Harsh art-direction critique of captured frames, then per-module fixes',
  phases: [
    { title: 'Critique', detail: 'one hostile critic per captured shot' },
    { title: 'Fix', detail: 'one agent per owning module, disjoint files' },
  ],
}

/**
 * args: { shotDir: 'shots', shots: [{name, what}], round: 1 }
 *
 * Critics look at one image each and answer one question, so a finding is always
 * traceable to a frame. Fixers are grouped by the module that owns the files, so
 * two agents never touch the same directory.
 */
// args can arrive already parsed or as a JSON string depending on how the run
// was launched; normalise rather than silently running zero critics.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { input = null }
}
if (!input || !Array.isArray(input.shots) || !input.shots.length) {
  throw new Error('critique: no shots supplied; args was ' + JSON.stringify(args))
}

const shotDir = input.shotDir || 'shots'
const round = input.round || 1
const shots = input.shots

const OWNERS = {
  world: 'src/world/',
  materials: 'src/render/Materials.js and src/render/textures/',
  postfx: 'src/render/PostFX.js, src/render/passes/ and src/render/shaders/',
  weapons: 'src/weapons/',
  vfx: 'src/vfx/',
  ai: 'src/ai/',
  ui: 'src/ui/',
  player: 'src/player/',
}

const CRITIC_RULES = [
  "You are a hostile, senior art director on a shipped AAA military shooter. You have looked at",
  "ten thousand Call of Duty frames. You are reviewing a frame from a browser game in three.js",
  "that is TRYING to pass as one of yours. Your job is to find every reason it does not.",
  "",
  "Rules:",
  "- Be specific and technical. 'Lighting looks flat' is worthless. 'The sunlit wall plane and",
  "  the shadowed return wall are within 8% luminance of each other, so the building reads as a",
  "  flat card; the shadow side needs to drop to 25-30% of the lit side with cool sky bounce'",
  "  is useful.",
  "- Judge against the real thing. For each problem, say what a Modern Warfare frame does",
  "  instead. If you cannot name what the reference does differently, the finding is too vague.",
  "- Rank by how much each defect costs the illusion, worst first. A single wrong thing that",
  "  screams 'web demo' outranks five subtle ones.",
  "- Do not praise. Note what works in one clause only if it constrains a fix.",
  "- Attribute every finding to exactly one owning module from this list, by what would have to",
  "  change: world, materials, postfx, weapons, vfx, ai, ui, player.",
  "- Only report what you can actually SEE in this image. No speculation about code.",
  "- Give a verdict score 0-10 for 'would a player believe this is a shipped AAA title', where",
  "  0 is an untextured prototype and 10 is indistinguishable from Modern Warfare. Be stingy.",
  "  A 5 means 'clearly a good web game'. Most first-pass work is a 2-4.",
].join('\n')

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shot', 'score', 'verdict', 'findings'],
  properties: {
    shot: { type: 'string' },
    score: { type: 'number' },
    verdict: { type: 'string', description: 'One sentence: the single biggest reason this is not AAA.' },
    findings: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'module', 'observed', 'reference', 'fix'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          module: {
            type: 'string',
            enum: ['world', 'materials', 'postfx', 'weapons', 'vfx', 'ai', 'ui', 'player'],
          },
          observed: { type: 'string', description: 'What is visibly wrong in this image.' },
          reference: { type: 'string', description: 'What a real AAA shooter frame does instead.' },
          fix: { type: 'string', description: 'Concrete, implementable change.' },
        },
      },
    },
  },
}

phase('Critique')

const reviews = await parallel(shots.map((s) => () => agent([
  CRITIC_RULES,
  '',
  'Read this image with the Read tool: /home/user/Game/' + shotDir + '/' + s.name + '.png',
  '',
  'This frame is meant to demonstrate: ' + s.what,
  'Judge it primarily on that, but report anything else that damages the illusion.',
  'Set "shot" to "' + s.name + '".',
].join('\n'), {
  label: 'critic:' + s.name,
  phase: 'Critique',
  schema: FINDING_SCHEMA,
  effort: 'high',
})))

const ok = reviews.filter(Boolean)
const all = ok.flatMap((r) => (r.findings || []).map((f) => Object.assign({}, f, { shot: r.shot })))

log('round ' + round + ': ' + ok.length + ' frames reviewed, ' + all.length + ' findings, mean score ' +
  (ok.reduce((a, r) => a + r.score, 0) / Math.max(1, ok.length)).toFixed(1))

// Group by owning module so no two fixers ever touch the same directory.
const byModule = {}
for (const f of all) (byModule[f.module] = byModule[f.module] || []).push(f)

const modules = Object.keys(byModule).filter((m) => OWNERS[m])
for (const m of modules) {
  const crit = byModule[m].filter((f) => f.severity === 'critical').length
  log('  ' + m + ': ' + byModule[m].length + ' findings (' + crit + ' critical)')
}

phase('Fix')

const FIX_RULES = [
  "Repo: /home/user/Game. Read ARCHITECTURE.md first — it is the binding module contract.",
  "Edit ONLY files in the directory you own. Never touch src/core/**, src/main.js, scripts/**,",
  "or another module's directory. Runtime imports: 'three', 'three/addons/**', 'three-mesh-bvh',",
  "'simplex-noise' and local files only. No network and no asset files — every texture, mesh,",
  "animation and sound is generated in code.",
  "",
  "Verify with:  cd /home/user/Game && node scripts/check.mjs <files you changed>",
  "Do NOT run 'npm run build' or 'npm run shoot' — they are whole-tree and other agents are",
  "editing right now. Do not fix errors in files you do not own; report them instead.",
  "",
  "You are fixing findings from an art-direction review of real captured frames. Address every",
  "critical and major finding. Where a finding names a specific numeric relationship, honour it.",
  "Where you disagree with a finding on technical grounds, say so in your report and explain what",
  "you did instead — do not silently ignore it.",
].join('\n')

const fixes = await parallel(modules.map((m) => () => {
  const lines = byModule[m]
    .sort((a, b) => ({ critical: 0, major: 1, minor: 2 }[a.severity] - { critical: 0, major: 1, minor: 2 }[b.severity]))
    .map((f, i) => [
      (i + 1) + '. [' + f.severity.toUpperCase() + '] ' + f.title + '   (frame: ' + f.shot + ')',
      '   observed:  ' + f.observed,
      '   reference: ' + f.reference,
      '   fix:       ' + f.fix,
    ].join('\n'))

  return agent([
    FIX_RULES,
    '',
    'YOU OWN: ' + OWNERS[m],
    '',
    'Findings against your module, worst first:',
    '',
    lines.join('\n\n'),
    '',
    'The captured frames are in /home/user/Game/' + shotDir + '/ — read the ones referenced above',
    'with the Read tool so you are fixing what is actually on screen, not what you imagine.',
  ].join('\n'), { label: 'fix:' + m, phase: 'Fix', effort: 'high' })
    .then((text) => ({ module: m, count: byModule[m].length, report: text }))
}))

return {
  round,
  meanScore: +(ok.reduce((a, r) => a + r.score, 0) / Math.max(1, ok.length)).toFixed(2),
  scores: ok.map((r) => ({ shot: r.shot, score: r.score, verdict: r.verdict })),
  findingCount: all.length,
  criticalCount: all.filter((f) => f.severity === 'critical').length,
  fixed: fixes.filter(Boolean).map((f) => ({ module: f.module, count: f.count })),
}
