// Connection risk under uncertain areas (R-03, R-15, R-22, R-47 model side). Pure module: no browser APIs, no UI imports.
// Method, alternatives and the adversarial scenarios it was checked on: docs/research/TRANSFER_RISK_MODEL.md.
//
// Idea: the verdict is computed on LOWER and UPPER probabilities (an interval, not one number), because three kinds of
// mass are not real probabilities and must never be spread as if they were:
//   1. history that maps to no modelled area ("unmapped", R-22) and pairs with no route (R-47);
//   2. the sampling uncertainty of a small history (Imprecise Dirichlet Model: s / (n + s) of the mass is left open);
//   3. a side with no evidence at all (zone-only candidates): equal weights are not a prediction, so that side's mass is
//      "vacuous" over its candidates (any split is possible).
// Each scenario (arrival area × departure area) gets a category from its needed time; open mass can be any category of
// the scenarios it is open over (or anything at all when nothing is known about it). The conservative verdict (`worst`)
// is the worst category whose UPPER probability reaches the tolerance; `best` is the worst category whose LOWER
// probability reaches it. More uncertainty only widens the interval, so `worst` can never improve when evidence is
// removed (monotonicity, tested), and open mass never disappears (it is reported as `coverage.open`).

export type Category = 'comfortable' | 'tight' | 'risky';
export type Verdict = Category | 'uncertain' | 'not-assessed';
export interface Needed { typical: number; high: number }
export interface Issue { level: 'blocking' | 'material' | 'secondary'; code: string; text: string }

/** One evaluated (arrival area, departure area) pair. */
export interface Outcome { needed: Needed | null; issues?: Issue[]; label?: string }

/**
 * One scenario of the low-level interface. `p` = probability mass. Scenarios sharing an `openGroup` key form one block
 * whose total mass is known but whose split between its members is not (e.g. a zone-only side): the block can turn out
 * as any of its members' categories.
 */
export interface Scenario extends Outcome { p: number; openGroup?: string }

/** Thresholds. Kept from assess.ts (owner decision pending: docs/remediation/AGENT_B_LOG.md, decision request DR-B1). */
export const RISK = {
  /** Pessimistic margin (scheduled − high) at or above this → the scenario is "comfortable". */
  comfortableMargin: 15,
  /** Typical margin (scheduled − typical) below this → "risky". In between → "tight". */
  riskyMargin: 10,
  /** Tolerance: a category drives the verdict when its probability reaches this. 0.10 = the share assess.ts already used
   *  (as a per-pair joint weight); here it applies to the total mass of the category, so splitting a side never hides it. */
  tolerance: 0.1,
  /** Imprecise Dirichlet Model prior strength (Walley 1996; s = 1 or 2 are the usual choices). */
  idmS: 1,
  /** Legacy (owner decision 2026-11-02, DR-B3/DA-2): a `material` issue used to cap a comfortable scenario at "tight".
   *  Off: every known mandatory procedure now carries minutes (or a conservative bound), and one whose time cannot be
   *  bounded makes the scenario "not assessed" instead (assess.ts, docs/research/VERDICT_POLICY_REVIEW.md). Kept as a
   *  switch for the comparison scripts and the interval-model tests. */
  materialCaps: false,
};

const ORDER: Category[] = ['risky', 'tight', 'comfortable'];   // worst first
const rank = (c: Category) => ORDER.indexOf(c);

/** Category of one scenario (null = not assessed: no route, blocking issue, or no scheduled time). */
export function categorize(o: Outcome, scheduled: number | null, t = RISK): Category | null {
  if (scheduled === null || !o.needed || o.issues?.some((i) => i.level === 'blocking')) return null;
  let c: Category = scheduled - o.needed.high >= t.comfortableMargin ? 'comfortable' : scheduled - o.needed.typical >= t.riskyMargin ? 'tight' : 'risky';
  if (t.materialCaps && c === 'comfortable' && o.issues?.some((i) => i.level === 'material')) c = 'tight';
  return c;
}

export interface Driver { label: string; category: Category | 'not-assessed'; pLower: number; pUpper: number; needed: Needed | null; issues: Issue[] }
export interface RiskAssessment {
  verdict: Verdict;
  /** Conservative bound: the worst category that is plausible at the tolerance. Never improves with more uncertainty. */
  worst: Category | 'not-assessed';
  /** Optimistic bound: the worst category that the evidence alone establishes at the tolerance. */
  best: Category | 'not-assessed';
  /** Lower / upper probability that the outcome is that category or worse. */
  bounds: { risky: [number, number]; tightOrWorse: [number, number] };
  coverage: { assessed: number; open: number; unassigned: number; notAssessed: number };
  drivers: Driver[];
  text: string;
  tolerance: number;
}

/**
 * Low-level interface (CONTRACT.md): scenarios with masses, the unassigned mass (history not mapped, pairs not routed),
 * and the scheduled connection minutes. Σp + unassignedMass should be 1; any shortfall is added to the unassigned mass,
 * an excess is normalised away (with the unassigned mass kept as given).
 */
export function assessConnection(scenarios: Scenario[], unassignedMass: number, scheduled: number | null, t = RISK): RiskAssessment {
  const tot = scenarios.reduce((s, x) => s + Math.max(x.p, 0), 0);
  let un = Math.min(Math.max(unassignedMass, 0), 1);
  const scale = tot + un > 1 + 1e-9 && tot > 0 ? (1 - un) / tot : 1;
  if (tot * scale + un < 1 - 1e-9) un = 1 - tot * scale;
  // blocks: open groups and singletons
  const blocks = new Map<string, { p: number; cats: (Category | null)[]; members: Scenario[] }>();
  scenarios.forEach((s, i) => {
    const k = s.openGroup ? `g:${s.openGroup}` : `s:${i}`;
    const b = blocks.get(k) ?? { p: 0, cats: [], members: [] };
    b.p += Math.max(s.p, 0) * scale; b.cats.push(categorize(s, scheduled, t)); b.members.push(s);
    blocks.set(k, b);
  });
  // lower/upper of "category c or worse": a block counts in the lower bound only if ALL its members are c-or-worse and
  // assessed; in the upper bound if ANY member is c-or-worse or not assessed. Unassigned mass is in every upper bound.
  const lo = [0, 0], up = [un, un];   // index 0: risky, 1: tight-or-worse
  let assessed = 0, open = 0, notAssessed = 0;
  for (const b of blocks.values()) {
    const single = b.members.length === 1 || new Set(b.cats).size === 1;
    if (b.cats.every((c) => c !== null)) { if (single) assessed += b.p; else open += b.p; } else notAssessed += b.p;
    for (const k of [0, 1]) {
      const worseOrEq = (c: Category | null) => c !== null && rank(c) <= k;
      if (b.cats.every(worseOrEq)) lo[k] += b.p;
      if (b.cats.some((c) => c === null || worseOrEq(c))) up[k] += b.p;
    }
  }
  const eps = t.tolerance;
  const pick = (v: number[]): Category => (v[0] >= eps - 1e-12 ? 'risky' : v[1] >= eps - 1e-12 ? 'tight' : 'comfortable');
  const anyAssessed = assessed + open > 1e-12;
  const worst: RiskAssessment['worst'] = scheduled === null || !anyAssessed ? 'not-assessed' : pick(up);
  const best: RiskAssessment['best'] = scheduled === null || !anyAssessed ? 'not-assessed' : pick(lo);
  let verdict: Verdict;
  if (worst === 'not-assessed' || best === 'not-assessed') verdict = 'not-assessed';
  else if (worst === best) verdict = worst;
  // The interval spans "comfortable" and something worse → the unknown part decides: 'uncertain' (its rank for any
  // comparison is `worst`). When even the optimistic bound is not comfortable, the verdict is the conservative bound
  // (R-15: never 'uncertain' when no plausible case is comfortable).
  else verdict = best === 'comfortable' ? 'uncertain' : worst;
  const drivers = driversOf(blocks, scheduled, t, un);
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const range = (b: [number, number]) => (Math.abs(b[1] - b[0]) < 0.005 ? pct(b[0]) : `${pct(b[0])}–${pct(b[1])}`);
  const bounds = { risky: [lo[0], up[0]] as [number, number], tightOrWorse: [lo[1], up[1]] as [number, number] };
  const texts: string[] = [];
  if (verdict !== 'not-assessed') {
    texts.push(`Risky in ${range(bounds.risky)} of the cases, tight or worse in ${range(bounds.tightOrWorse)}.`);
    if (un + notAssessed > 0.005) texts.push(`${pct(un + notAssessed)} of the cases could not be assessed (areas not on the map, no route, or too little history) and are counted as possibly risky.`);
    // a plausible risky pair is never silently ignored, even below the tolerance
    const lowRisk = drivers.filter((d) => d.category === 'risky' && d.pUpper > 0);
    if (lowRisk.length && worst !== 'risky') texts.push(`Less likely but risky: ${lowRisk.map((d) => `${d.label} (${pct(d.pUpper)})`).join(', ')}.`);
  }
  return { verdict, worst, best, bounds, coverage: { assessed, open, unassigned: un, notAssessed }, drivers, text: texts.join(' '), tolerance: eps };
}

function driversOf(blocks: Map<string, { p: number; cats: (Category | null)[]; members: Scenario[] }>, scheduled: number | null, t: typeof RISK, un: number): Driver[] {
  // per pair (label): lower = its point mass; upper = point mass + the mass of every open block it belongs to
  const by = new Map<string, Driver>();
  for (const b of blocks.values()) b.members.forEach((s, i) => {
    const label = s.label ?? '?';
    const d = by.get(label) ?? { label, category: b.cats[i] ?? 'not-assessed', pLower: 0, pUpper: 0, needed: s.needed, issues: s.issues ?? [] };
    if (b.members.length === 1) d.pLower += b.p;
    d.pUpper += b.p;
    by.set(label, d);
  });
  const out = [...by.values()];
  if (un > 1e-9) out.push({ label: 'areas not on the map or not routed', category: 'not-assessed', pLower: un, pUpper: un, needed: null, issues: [] });
  const r = (d: Driver) => (d.category === 'not-assessed' ? -1 : rank(d.category));
  return out.sort((x, y) => r(x) - r(y) || y.pUpper - x.pUpper);
}

// ---------------------------------------------------------------------------------------------------------------------
// High-level interface: build the scenarios from what each side's evidence actually is.
// ---------------------------------------------------------------------------------------------------------------------

/** What is known about one flight's area at the connecting airport. */
export interface SideEvidence {
  /** 'observed' = published for the flight-day; 'predicted' = history frequencies; 'unknown' = no evidence (zone only). */
  kind: 'observed' | 'predicted' | 'unknown';
  /** Evidence at its own level (R-20): `ids` with one area = a share of that area; several areas = a share of a terminal
   *  or gate area that covers them, with the split inside NOT known (e.g. CDG "2E" 70 % over K, L, M). Shares are history
   *  frequencies and may sum to less than 1. For 'unknown' the shares are ignored: the side is open over every id. */
  candidates: { ids: string[]; p: number }[];
  /** Share of the evidence that maps to no candidate (unmapped history, values dropped as too rare). Default 1 − Σp. */
  unmapped?: number;
  /** Flight-days behind the shares ('predicted'): the IDM leaves s / (n + s) of the mass open over `universe`. */
  sample?: number | null;
  /** Every area the flight could use (eligible areas of its zone). The IDM open mass is spread over these, not only over
   *  the areas already seen in a small history. Default: the candidates. */
  universe?: string[];
}

/** One side as atoms: a mass over a set of areas (one area = a point mass; several = open over them). */
export interface SideMass { atoms: { ids: string[]; p: number }[]; unassigned: number }

export function sideMass(e: SideEvidence, t = RISK): SideMass {
  const all = [...new Set([...e.candidates.flatMap((c) => c.ids), ...(e.universe ?? [])])];
  if (!all.length) return { atoms: [], unassigned: 1 };
  if (e.kind === 'unknown') return { atoms: [{ ids: all, p: 1 }], unassigned: 0 };
  const sum = e.candidates.reduce((s, c) => s + Math.max(c.p, 0), 0);
  const unmapped = Math.max(e.unmapped ?? 1 - sum, 0);
  const norm = sum + unmapped > 0 ? 1 / (sum + unmapped) : 0;
  const n = e.kind === 'predicted' && e.sample ? e.sample : null;
  const keep = n ? n / (n + t.idmS) : 1;   // IDM: s / (n + s) of the mass is open over every candidate area
  const atoms = e.candidates.filter((c) => c.p > 0 && c.ids.length).map((c) => ({ ids: [...new Set(c.ids)], p: c.p * norm * keep }));
  if (n) atoms.push({ ids: all, p: 1 - keep });   // open over the whole universe
  return { atoms, unassigned: unmapped * norm * keep };
}

/**
 * Joint scenarios of two sides, assuming the arrival and departure areas are independent (two different flights; see
 * the research note for when this fails), with `outcome(arrId, depId)` the routed result of each pair. An atom pair
 * with more than one area pair becomes one open block (the split inside it is not known).
 */
export function buildScenarios(arr: SideEvidence, dep: SideEvidence, outcome: (a: string, d: string) => Outcome, t = RISK): { scenarios: Scenario[]; unassignedMass: number } {
  const A = sideMass(arr, t), D = sideMass(dep, t);
  const cache = new Map<string, Outcome>();
  const out = (a: string, d: string) => { const k = `${a}|${d}`; if (!cache.has(k)) cache.set(k, outcome(a, d)); return cache.get(k)!; };
  const sc: Scenario[] = [];
  A.atoms.forEach((a, i) => D.atoms.forEach((d, j) => {
    const pairs = a.ids.flatMap((x) => d.ids.map((y) => [x, y] as const));
    const p = (a.p * d.p) / pairs.length;
    for (const [x, y] of pairs) { const o = out(x, y); sc.push({ ...o, label: o.label ?? `${x} → ${y}`, p, ...(pairs.length > 1 ? { openGroup: `${i}|${j}` } : {}) }); }
  }));
  const mA = A.atoms.reduce((s, x) => s + x.p, 0), mD = D.atoms.reduce((s, x) => s + x.p, 0);
  return { scenarios: sc, unassignedMass: Math.max(1 - mA * mD, 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Most-likely-route verdict (owner policy 2026-11-02, docs/research/VERDICT_POLICY_REVIEW.md).
//
// The headline describes the connection the passenger is most likely to experience. Uncertainty about WHERE (which gate
// area) is treated as uncertainty about TIME: the needed time is the probability-weighted mixture of the needed-time
// distributions of the likely area pairs (point estimates from history), and the mixture is categorised with the SAME
// margins as a single route (comfortable: 15 min left at its 90th percentile; risky: under 10 min left at its median).
//   - harmless uncertainty (several nearby areas with similar times) leaves the mixture where the most likely route is;
//   - a credible alternative that needs much longer moves the mixture's 90th percentile only if it carries enough
//     probability to matter at that percentile (≈ 10 %), so no extra threshold is introduced;
//   - a pair whose time is NOT established (no modelled route, or a required procedure with no defensible bound) counts
//     as unbounded time: it can only make the verdict worse, never better (no false confidence about a procedure);
//   - a side with no evidence at all has no "most likely" area: when its possible areas lead to different categories
//     the verdict is 'uncertain' ("depends on the area"), otherwise their common category.
// The interval model above (assessConnection) is kept as the robustness view shown in the details.
// ---------------------------------------------------------------------------------------------------------------------

/** One area pair as a point estimate: `p` = history share (renormalised), `needed` = its time distribution. */
export interface PointScenario { p: number; needed: { min: number; typical: number; high: number } | null; label: string; primary?: boolean; reason?: string }

export interface LikelyVerdict {
  verdict: Verdict;
  /** Category of the most likely pair on its own. */
  primary: Category | 'not-assessed';
  /** Median and 90th percentile of the mixture (minutes; Infinity when the unassessed share reaches that quantile). */
  needed: { typical: number; high: number } | null;
  /** Point share of pairs whose time is not established. */
  unassessed: number;
  /** Pairs worse than the primary pair, with their share (most likely first). */
  worse: { label: string; p: number; category: Category | 'not-assessed'; typical: number | null; reason?: string }[];
  /** The alternatives changed the verdict away from the primary pair's own category. */
  changed: boolean;
}

/** Standard-normal CDF (Abramowitz–Stegun 7.1.26 on erf; |error| < 1.5e-7). */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** CDF of the shifted lognormal through (min, typical = median, high = q90): the same fit as timing.ts. */
function spanCdf(n: { min: number; typical: number; high: number }, x: number): number {
  const lo = Math.min(n.min, n.typical, n.high), hi = Math.max(n.min, n.typical, n.high);
  if (hi - lo < 1e-9) return x >= lo ? 1 : 0;
  const med = Math.max(n.typical - lo, 0.02 * (hi - lo), 1e-3), top = Math.max(hi - lo, med * 1.0001);
  const sigma = Math.max(Math.log(top / med) / 1.2815515655446004, 1e-9);
  return x <= lo ? 0 : normCdf((Math.log(x - lo) - Math.log(med)) / sigma);
}
/** Quantile q of a mixture of spans (weights sum to ≤ 1; the missing weight is unbounded time). */
export function mixtureQuantile(parts: { p: number; n: { min: number; typical: number; high: number } }[], q: number): number {
  const mass = parts.reduce((s, x) => s + x.p, 0);
  if (mass < q - 1e-12) return Infinity;
  let lo = Math.min(...parts.map((x) => x.n.min)), hi = Math.max(...parts.map((x) => x.n.high)) * 4 + 60;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, f = parts.reduce((s, x) => s + x.p * spanCdf(x.n, mid), 0);
    if (f < q) lo = mid; else hi = mid;
  }
  return Math.round(hi * 10) / 10;
}

/** Category of a needed time against the scheduled connection (the margins of `categorize`). */
export const categoryOf = (scheduled: number, needed: { typical: number; high: number }, t = RISK): Category =>
  scheduled - needed.high >= t.comfortableMargin ? 'comfortable' : scheduled - needed.typical >= t.riskyMargin ? 'tight' : 'risky';

/**
 * The headline verdict from point scenarios. `noEvidence`: a side has no evidence (its shares are equal splits, not a
 * prediction). Shares are renormalised over the scenarios given.
 */
export function likelyVerdict(scenarios: PointScenario[], scheduled: number | null, opts: { noEvidence?: boolean } = {}, t = RISK): LikelyVerdict {
  const empty: LikelyVerdict = { verdict: 'not-assessed', primary: 'not-assessed', needed: null, unassessed: 1, worse: [], changed: false };
  const tot = scenarios.reduce((s, x) => s + Math.max(x.p, 0), 0);
  if (scheduled === null || !scenarios.length || tot <= 0) return empty;
  const sc = scenarios.map((x) => ({ ...x, p: Math.max(x.p, 0) / tot }));
  const prim = sc.find((x) => x.primary) ?? [...sc].sort((a, b) => b.p - a.p)[0];
  const cat = (x: PointScenario): Category | 'not-assessed' => (x.needed ? categoryOf(scheduled, x.needed, t) : 'not-assessed');
  const primary = cat(prim);
  const assessed = sc.filter((x) => x.needed).map((x) => ({ p: x.p, n: x.needed! }));
  const unassessed = Math.round((1 - assessed.reduce((s, x) => s + x.p, 0)) * 1e6) / 1e6;
  const sev = (c: Category | 'not-assessed') => (c === 'not-assessed' ? 3 : 2 - rank(c));   // comfortable 0 … risky 2, n/a 3
  const worse = sc.filter((x) => x !== prim && sev(cat(x)) > sev(primary)).sort((a, b) => b.p - a.p)
    .map((x) => ({ label: x.label, p: x.p, category: cat(x), typical: x.needed?.typical ?? null, reason: x.reason }));
  if (primary === 'not-assessed' || unassessed >= 0.5) return { ...empty, primary, unassessed, worse };
  const needed = { typical: mixtureQuantile(assessed, 0.5), high: mixtureQuantile(assessed, 0.9) };
  let verdict: Verdict = categoryOf(scheduled, needed, t);
  // no evidence: no area is "most likely". Possible areas spanning comfortable and worse → 'uncertain' (depends on the
  // area); none comfortable → the worst of them (R-15: never 'uncertain' when no possible case is comfortable)
  if (opts.noEvidence && new Set(sc.map(cat)).size > 1) {
    const cats = sc.map(cat);
    verdict = cats.includes('comfortable') ? 'uncertain' : cats.includes('not-assessed') ? 'not-assessed' : cats.includes('risky') ? 'risky' : 'tight';
  }
  return { verdict, primary, needed, unassessed, worse, changed: verdict !== primary };
}

/** Convenience: evidence → verdict in one call. */
export function assessSides(arr: SideEvidence, dep: SideEvidence, scheduled: number | null, outcome: (a: string, d: string) => Outcome, t = RISK): RiskAssessment {
  const { scenarios, unassignedMass } = buildScenarios(arr, dep, outcome, t);
  return assessConnection(scenarios, unassignedMass, scheduled, t);
}
