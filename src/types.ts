/** Shared contracts between modules. Report shapes are public: see docs/json-output.md. */

export type Language = 'javascript' | 'typescript' | 'tsx' | 'python' | 'go' | 'rust';

export type ProviderName =
  | 'typesafe'
  | 'openai'
  | 'gateway'
  | 'cloudflare'
  | 'microsoft'
  | 'compatible';

interface QuestionBase {
  /** Unique within a preset; the full id is `<preset>.<id>`. */
  id: string;
  title: string;
  instructions: string;
  weight: number;
  /** Guidance handed to coding agents when this question scores badly. */
  fix: string;
}

export interface ScoreQuestion extends QuestionBase {
  type: 'score';
  /** 2 to 10 levels, ordered worst to best. */
  levels: string[];
}

export interface BooleanQuestion extends QuestionBase {
  type: 'boolean';
  /** The answer a clean file should give. */
  good: boolean;
}

export type Question = ScoreQuestion | BooleanQuestion;

export interface AstPattern {
  id: string;
  language: Language;
  /** ast-grep pattern, for example `console.log($$$)`. */
  pattern: string;
  message: string;
}

/** A sentence that judges each match of an ast-grep pattern. Yes means a violation. */
export interface AstRule extends AstPattern {
  /** Asked about each match's text. */
  question: string;
  /** Guidance handed to coding agents with each hit. */
  fix: string;
  /** Report a match at or above this probability, from 0 to 1. */
  threshold: number;
}

/** The command a preset's questions are written for. */
export type PresetUse = 'audit' | 'architecture' | 'intent';

export interface Preset {
  name: string;
  description: string;
  source: string;
  /** `audit` unless the questions only make sense to `jevlint architecture` or `--intent`. */
  used_by: PresetUse;
  /** Other presets that run alongside this one, each keeping its own question ids. */
  includes: string[];
  questions: Question[];
  patterns: AstPattern[];
  rules: AstRule[];
}

export interface AstFinding {
  /** `cognitive-complexity`, `nesting`, `function-lines`, `params`, `file-lines`, or a pattern or rule id. */
  rule: string;
  message: string;
  /** 1-indexed. */
  line: number;
  symbol?: string;
  value?: number;
  limit?: number;
  /** Semantic rules only: how likely the model thinks this match is a violation, from 0 to 1. */
  probability?: number;
  /** Semantic rules only: guidance handed to coding agents. */
  fix?: string;
}

export interface AstResult {
  /** 0 (worst) to 1 (best). */
  score: number;
  findings: AstFinding[];
  /** Set when the file had no grammar, so the metrics come from keywords and indentation. */
  approximate?: boolean;
}

/** Raw decision for one question, as cached. */
export interface RawAnswer {
  /**
   * Score questions: 0 to levels-1. Boolean questions: probability of true. Choice questions: the
   * probability of the chosen option, or 1 when the provider reports none.
   */
  value: number;
  /** Choice questions only: the chosen option. */
  choice?: string;
}

/** A score a team fixed with a `jevlint-score` comment. */
export interface Pin {
  /** 0 (worst) to 1 (best). */
  value: number;
  reason: string;
  /** 1-indexed line of the comment. */
  line: number;
}

export interface ModelAnswer {
  /** Full id: `<preset>.<id>`. */
  id: string;
  title: string;
  /** 0 (worst) to 1 (best). */
  compliance: number;
  weight: number;
  fix: string;
  /** Present when a comment fixed this answer's compliance. */
  pin?: Pin;
}

export interface ModelResult {
  /** 0 (worst) to 1 (best). */
  score: number;
  answers: ModelAnswer[];
  /** Per-preset compliance from 0 to 1. */
  presets: Record<string, number>;
  cached: boolean;
  truncated: boolean;
  inputTokens: number;
}

export interface FileReport {
  /** Relative to the report root, with forward slashes. */
  path: string;
  language: Language | null;
  lines: number;
  /** On the configured scale. Higher is cleaner. */
  score: number;
  /** Refactor-first ranking value. Higher means fix sooner. */
  priority: number;
  commits: number;
  /** Present when a comment fixed the whole file's score. No model ran, and priority is 0. */
  pin?: Pin;
  ast: AstResult | null;
  model: ModelResult | null;
  /** Present when a semantic rule got an answer. Counted apart from `model`. */
  ruleUsage?: RuleUsage;
  warnings: string[];
}

/** What judging one file's rule matches took. */
export interface RuleUsage {
  inputTokens: number;
  cacheHits: number;
  modelCalls: number;
}

export interface AuditReport {
  root: string;
  provider: string | null;
  model: string | null;
  presets: string[];
  scale: number;
  /** Line-weighted mean on the configured scale. */
  score: number;
  /** Sorted by priority, highest first. */
  files: FileReport[];
  /** Files found but not scoreable (no AST language and no model). */
  skipped: string[];
  usage: {
    inputTokens: number;
    /** A rough USD cost of this run, or null when the model's price is unknown or none ran. */
    estimatedCostUsd: number | null;
    cacheHits: number;
    modelCalls: number;
  };
}

/** One file an agent changed, as `jevlint quickfix --json` prints it. */
export interface FileDiff {
  /** Relative to the report root, with forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** A git-style unified diff, which `git apply` accepts. Binary files have no hunks. */
  patch: string;
  /** `quickfix` only: the score before the run, or null for a file no audit had scored. */
  scoreBefore?: number | null;
  /** `quickfix` only: the score after re-auditing, or null for a deleted or unscored file. */
  scoreAfter?: number | null;
}

/** One file `jevlint quickfix` handed to an agent, as `--json` prints it. */
export interface QuickfixFileResult {
  path: string;
  /** Before the run, on the configured scale. */
  score: number;
  /** After the run, or null when it was not re-scored: removed, unscored or the agent failed. */
  after: number | null;
  diffs: FileDiff[];
}

/** Two commits to compare. A null base means a root commit, where every file is new. */
export interface Change {
  title: string;
  base: string | null;
  head: string;
  /** The full commit message, or a pull request's title and body. Read only by `--intent`. */
  message?: string;
}

/** How a change moved one file. */
export interface ChangedFile {
  path: string;
  /** On the configured scale. Null when the change added the file. */
  before: number | null;
  after: number;
  /** AST findings the change introduced or made worse. */
  findings: AstFinding[];
  /** Weak question answers the change lowered. */
  answers: ModelAnswer[];
  warnings: string[];
}

export interface ChangeReview extends Omit<Change, 'message'> {
  provider: string | null;
  model: string | null;
  scale: number;
  files: ChangedFile[];
  /** Changed files found but not scoreable (no AST language and no model). */
  skipped: string[];
  usage: AuditReport['usage'];
  /** With `--intent` and a model: the change judged against its message and instructions. */
  intent?: ModelAnswer[];
  /** With `intent`: problems judging it, such as a truncated diff. */
  warnings?: string[];
}

/** A structural problem, and the directories whose score it counts against. */
export interface ArchitectureFinding extends AstFinding {
  /** The file or directory to look at first. */
  path: string;
  directories: string[];
}

/** One dependency in a graph. A cyclic edge is part of a dependency cycle. */
export interface ArchitectureEdge {
  from: string;
  to: string;
  /** How many imports or references it stands for. */
  weight: number;
  cyclic: boolean;
  /** Class graphs only. */
  kind?: 'inherits' | 'uses';
}

/** Layer 0 depends on nothing in the graph, and each layer depends only on those below it. */
export interface ModuleNode {
  path: string;
  directory: string;
  language: Language;
  lines: number;
  layer: number;
  fanIn: number;
  fanOut: number;
  /** Names declared at the top level. */
  symbols: string[];
}

export interface ClassNode {
  /** `<path>#<name>`. */
  id: string;
  name: string;
  path: string;
  line: number;
  lines: number;
  methods: string[];
  layer: number;
}

export interface DirectoryNode {
  /** Relative to the report root. The root itself is `.`. */
  path: string;
  files: number;
  lines: number;
  layer: number;
}

/** A level of the design that the review looks at. */
export type Perspective = 'codebase' | 'directory' | 'class';

/** One reviewed thing: the whole codebase, a directory or a class. */
export interface ArchitectureUnit {
  perspective: Perspective;
  /** `codebase`, a directory's path, or a class's id. */
  name: string;
  /** Where to look. */
  path: string;
  line: number;
  lines: number;
  /** On the configured scale. Higher is cleaner. */
  score: number;
  /** Structural findings, scored like a file's AST findings. */
  ast: { score: number; findings: ArchitectureFinding[] };
  model: ModelResult | null;
  warnings: string[];
}

export interface ArchitectureReport {
  root: string;
  provider: string | null;
  model: string | null;
  scale: number;
  /** Line-weighted mean of the units, on the configured scale. */
  score: number;
  /** Line-weighted mean for each perspective that ran. */
  perspectives: Partial<Record<Perspective, number>>;
  /** Every reviewed unit, lowest score first. */
  units: ArchitectureUnit[];
  /** Problems with the run as a whole, such as a file that could not be read. */
  warnings: string[];
  directories: DirectoryNode[];
  modules: ModuleNode[];
  classes: ClassNode[];
  edges: {
    directories: ArchitectureEdge[];
    modules: ArchitectureEdge[];
    classes: ArchitectureEdge[];
  };
  /** Every structural problem. */
  findings: ArchitectureFinding[];
  usage: AuditReport['usage'];
}

/** One checkable requirement in a spec checklist. */
export interface SpecItem {
  /** Unique within its checklist. The full id is `<feature>.<id>`, or `global.<id>`. */
  id: string;
  text: string;
  /** Where the item came from, for people only. */
  source?: string;
}

/** `index.yaml`: the project and the checklist every file is judged against. */
export interface SpecIndex {
  version: 1;
  name: string;
  description: string;
  checklist: SpecItem[];
  /** Documents a person decided may state requirements the spec leaves out. */
  accept_uncovered: SpecAcceptedDoc[];
}

/** One `accept_uncovered` entry: a document path, relative to the root, and why. */
export interface SpecAcceptedDoc {
  path: string;
  reason: string;
}

/** `features/<id>.yaml`: one feature and its checklist. */
export interface SpecFeature {
  id: string;
  title: string;
  /** Tells this feature apart from the others in the routing question. */
  summary: string;
  checklist: SpecItem[];
}

/** A loaded and validated spec. See docs/spec-reference.md. */
export interface Spec {
  /** Root-relative posix path of the spec directory. */
  dir: string;
  index: SpecIndex;
  /** Sorted by id. */
  features: SpecFeature[];
}

/** An item named by its full id, as reports list it. */
export interface SpecItemRef {
  id: string;
  text: string;
}

/** What a code file does with one item. */
export type CheckVerdict = 'satisfies' | 'violates' | 'not-applicable';

/** What a document does with one item. */
export type DriftVerdict = 'agrees' | 'contradicts' | 'absent';

/** One item's verdict on one file or document. */
export interface SpecItemResult<V extends string> extends SpecItemRef {
  verdict: V;
  /** The probability the model gave its choice, or 1 when the provider reports none. */
  confidence: number;
}

/** One code file judged against the spec. */
export interface SpecFileResult {
  path: string;
  /** A feature id, `global` for shared code, or null when the file got no answer. */
  feature: string | null;
  featureConfidence: number | null;
  /** Satisfied over satisfied plus violated, on the configured scale. Null with none applicable. */
  score: number | null;
  /** Project items first. */
  items: SpecItemResult<CheckVerdict>[];
  warnings: string[];
}

/** The result of `jevlint spec check`. */
export interface SpecCheckReport {
  root: string;
  specDir: string;
  provider: string | null;
  model: string | null;
  scale: number;
  /** False when paths narrowed the run, which leaves `unimplemented` empty. */
  complete: boolean;
  /** Most violations first, then lowest score. */
  files: SpecFileResult[];
  violations: number;
  /** Items no file satisfies. */
  unimplemented: SpecItemRef[];
  usage: AuditReport['usage'];
  warnings: string[];
}

/** One document compared with the spec. */
export interface SpecDocResult {
  path: string;
  feature: string | null;
  featureConfidence: number | null;
  items: SpecItemResult<DriftVerdict>[];
  /** Probability the document states a requirement the checklist misses. Null with no answer. */
  uncovered: number | null;
  /** The `accept_uncovered` reason, present when the document may be uncovered. */
  uncoveredAccepted?: string;
  warnings: string[];
}

/** The result of `jevlint spec drift`. */
export interface SpecDriftReport {
  root: string;
  specDir: string;
  provider: string | null;
  model: string | null;
  /** False when paths narrowed the run, which leaves `unbacked` and `undocumented` empty. */
  complete: boolean;
  docs: SpecDocResult[];
  contradictions: number;
  /** Documents whose `uncovered` is 0.5 or more, leaving out those in `accept_uncovered`. */
  uncovered: string[];
  /** Items absent from every document routed to their checklist. */
  unbacked: SpecItemRef[];
  /** Feature ids no document is routed to. */
  undocumented: string[];
  usage: AuditReport['usage'];
  warnings: string[];
}
