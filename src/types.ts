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
export type PresetUse = 'audit' | 'architecture' | 'intent' | 'acceptance';

export interface Preset {
  name: string;
  description: string;
  source: string;
  /** `audit` unless the questions only make sense to `jevlint architecture`, `--intent` or `--acceptance`. */
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
  /** The short hash of the commit with this run's files, or null when nothing was committed. */
  commit: string | null;
  /** Each `quickfix.after` command's last run on this file, with its exit code. */
  fixers: { command: string[]; code: number }[];
  /** True when a failing `retry` check gave the agent a second run. */
  retried: boolean;
  /** Paths in `diffs` that only the `quickfix.after` commands changed, not the agent. */
  fixerOnly: string[];
}

/** Two commits to compare. A null base means a root commit, where every file is new. */
export interface Change {
  title: string;
  base: string | null;
  head: string;
  /** The full commit message, or a pull request's title and body. Read only by `--intent`. */
  message?: string;
  /** When asked for: the pull request's number. */
  number?: number;
  /** When asked for: the pull request's body alone, without its title. */
  body?: string;
  /** When asked for: the numbers of the same-repository issues it closes on merge. */
  closes?: number[];
  /** When asked for: issues it closes in other repositories, as `owner/repo#n`, which are not read. */
  closesElsewhere?: string[];
}

/** An issue's title and body, as read from GitHub. Both are repository text. */
export interface IssueText {
  number: number;
  title: string;
  body: string;
}

/** One piece of a pull request's body or an issue that may be an acceptance criterion. */
export interface CriterionChunk {
  /** `PR`, or the issue it comes from as `#<n>`. */
  source: string;
  /** Its first line in the source, from 1. */
  line: number;
  /** The headings above it, outermost first, joined by ` > `. Empty under no heading. */
  heading: string;
  text: string;
}

/** How far a change meets one acceptance criterion. `cannot-tell` is left out of the score. */
export type AcceptanceVerdict = 'met' | 'partly' | 'not-met' | 'cannot-tell';

/** A chunk with the model's probability that it is an acceptance criterion. */
export interface ClassifiedChunk extends CriterionChunk {
  probability: number;
}

/** An acceptance criterion and how the change meets it. */
export interface AcceptanceCriterion extends ClassifiedChunk {
  /** Null when the model could not be asked. */
  verdict: AcceptanceVerdict | null;
  /** The model's probability for the verdict, or null with no verdict. */
  confidence: number | null;
}

/** `pr --acceptance`: the change judged against what it was asked to do. */
export interface AcceptanceResult {
  /** On the configured scale. Null when no criterion could be judged from the diff. */
  score: number | null;
  criteria: AcceptanceCriterion[];
  /** The chunks the model did not take for criteria. */
  rejected: ClassifiedChunk[];
  warnings: string[];
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

/** What only judging a change reads, which a review leaves out so that `--json` keeps its shape. */
type ChangeInput = 'message' | 'number' | 'body' | 'closes' | 'closesElsewhere';

export interface ChangeReview extends Omit<Change, ChangeInput> {
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
  /** With `--architecture`: the SSOT violations the change added. */
  architecture?: ArchitectureViolation[];
  /** With `--acceptance` and a model: the change judged against its acceptance criteria. */
  acceptance?: AcceptanceResult;
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

/**
 * A level of the design that the review looks at. `component`, `design` and `chapter` review the
 * architecture SSOT, so they run only when one exists.
 */
export type Perspective = 'codebase' | 'directory' | 'class' | 'component' | 'design' | 'chapter';

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

/** One import as written, with the line it is on. */
export interface ImportRef {
  specifier: string;
  /** 1-indexed. */
  line: number;
  /** The names a JavaScript or TypeScript import picks, when it names them. */
  names?: string[];
}

/** What kind of thing outside the repository an import reaches. */
export type ExternalKind = 'system' | 'library' | 'runtime';

/** A file's import of something outside the repository, normalised to a package name. */
export interface ExternalImport {
  package: string;
  line: number;
}

/** A resolved dependency of one file on another, with the line that makes it. */
export interface ModuleImport {
  path: string;
  line: number;
  names?: string[];
}

/** One source file as the architecture facts see it: resolved imports, externals, names. */
export interface FactModule {
  path: string;
  language: Language;
  lines: number;
  imports: ModuleImport[];
  externals: ExternalImport[];
  symbols: string[];
  /** Data types it declares. */
  types?: DataType[];
  /** Comments that are not doc comments, which often explain why. */
  comments?: CodeComment[];
}

/** Where a dependency comes from: a file and the line of its import. */
export interface Evidence {
  path: string;
  line: number;
  /** The file or package imported. */
  target: string;
}

/** A group of files that the facts propose as one component. */
export interface ComponentCandidate {
  /** Derived from the paths. Stable while the paths stay the same. */
  id: string;
  /** Globs that select its files. */
  paths: string[];
  files: string[];
  lines: number;
  /** 0 depends on no other component. */
  layer: number;
  /** PageRank over the component graph, so the most depended-on parts rank first. */
  rank: number;
  fanIn: number;
  fanOut: number;
  /** The files most depended on from outside, with the most central first. */
  central: string[];
  /** Names that other components import from it. */
  interface: string[];
  /** External system and library ids it imports. */
  externals: string[];
  /** Commits that touched its files over `priority.churn_days`. */
  churn: number;
}

/** A dependency between two components, with the imports behind it. */
export interface ComponentDependency {
  from: string;
  to: string;
  /** How many imports it stands for. */
  weight: number;
  /** A few of those imports. */
  evidence: Evidence[];
}

/** An external system, library or runtime module the code imports. */
export interface ExternalUse {
  id: string;
  title: string;
  kind: ExternalKind;
  /** The packages seen, such as `@ai-sdk/openai`. */
  packages: string[];
  /** Component ids that import it. */
  users: string[];
  evidence: Evidence[];
}

/** Where execution starts: a binary, a route, a handler or a main function. */
export interface EntryPoint {
  path: string;
  kind: string;
  /** The component that holds it, if any. */
  component: string | null;
}

/** The longest chain of component dependencies from an entry point. */
export interface CandidateFlow {
  entry: string;
  components: string[];
}

/** Files in two components that change in the same commits, with no import between them. */
export interface CoChange {
  a: string;
  b: string;
  commits: number;
}

/** What static analysis tells about a repository, with no model and no network. */
export interface ArchitectureFacts {
  version: 1;
  root: string;
  /** HEAD when the facts were collected, or null outside git. */
  commit: string | null;
  files: number;
  lines: number;
  components: ComponentCandidate[];
  /** Number of inferred layers; component layers run from 0 to this minus one. */
  layers: number;
  dependencies: ComponentDependency[];
  externals: ExternalUse[];
  entrypoints: EntryPoint[];
  flows: CandidateFlow[];
  /** Component ids in a dependency cycle, one list per cycle. */
  cycles: string[][];
  coChanges: CoChange[];
  /** Globs of test files, which the facts leave out of components. */
  tests: string[];
  /** The data types most referred to, with their fields. */
  dataTypes: FactDataType[];
  modules: FactModule[];
  warnings: string[];
}

/** An entry in `externals` of the SSOT's `index.yaml`. */
export interface ArchitectureExternal {
  id: string;
  title: string;
  /** Package names, where `*` matches any characters, such as `@ai-sdk/*`. */
  packages: string[];
  summary?: string;
}

/** A structural rule in the SSOT. Every kind is decided from the AST, with no model. */
export type ArchitectureRule =
  | { id: string; kind: 'layers' }
  | { id: string; kind: 'no-cycles' }
  | { id: string; kind: 'only'; externals: string[]; components?: string[] }
  | {
      id: string;
      kind: 'forbid';
      from?: string[];
      packages?: string[];
      components?: string[];
    }
  | {
      id: string;
      kind: 'forbid-call';
      pattern: string;
      language?: Language;
      from?: string[];
      except?: string[];
    };

/** `index.yaml` of the architecture SSOT. */
export interface ArchitectureIndex {
  version: 1;
  name: string;
  /** The commit the SSOT was compiled from: the base for `drift` and an update. */
  compiled_at?: string;
  /** The date it was compiled, as `YYYY-MM-DD`, so a reader need not ask git. */
  compiled_on?: string;
  description: string;
  /** Layer names, top to bottom. */
  layers: string[];
  /** Globs of files that belong to no component on purpose, such as tests. */
  ignore: string[];
  externals: ArchitectureExternal[];
  rules: ArchitectureRule[];
  checklist: SpecItem[];
}

/** A file to start reading a component from, and what it does. */
export interface KeyFile {
  path: string;
  role: string;
}

/** `components/<id>.yaml`: one part of the system. */
export interface ArchitectureComponent {
  id: string;
  title: string;
  summary: string;
  layer?: string;
  paths: string[];
  key_files: KeyFile[];
  interface: string[];
  /** The components it may depend on. When absent, any. */
  depends_on?: string[];
  /** External ids it uses. */
  uses: string[];
  rules: ArchitectureRule[];
  checklist: SpecItem[];
  /** `target` marks the intended shape: its violations are known debt. */
  status: 'current' | 'target';
}

/** One step of a flow: one component calling another. */
export interface FlowStep {
  from: string;
  to: string;
  verb: string;
  /** What comes back to `from`, drawn as a return arrow. */
  returns?: string;
  /** Drawn dashed: optional, asynchronous or not always taken. */
  optional?: boolean;
}

/** `flows/<id>.yaml`: a main workflow through the components. */
export interface ArchitectureFlow {
  id: string;
  title: string;
  trigger?: string;
  steps: FlowStep[];
}

/** A loaded and validated architecture SSOT. See docs/architecture-reference.md. */
export interface ArchitectureSsot {
  /** Root-relative posix path of the SSOT directory. */
  dir: string;
  index: ArchitectureIndex;
  /** Sorted by id. */
  components: ArchitectureComponent[];
  flows: ArchitectureFlow[];
  /** Curated diagrams, sorted by id. */
  views: ArchitectureView[];
  /** The document's chapters, in file name order. */
  chapters: ArchitectureChapter[];
  /** Decision records in number order. Absent when `decisions/` holds none. */
  decisions?: ArchitectureDecision[];
}

/** What a structural violation broke. */
export type ViolationRule =
  | 'layer-violation'
  | 'undeclared-dependency'
  | 'restricted-external'
  | 'forbidden-dependency'
  | 'forbidden-call'
  | 'component-cycle'
  | 'missing-flow-step'
  | 'stale-reference'
  | 'unmapped-file';

/** Code that does not follow the SSOT, found from the AST with a file and line. */
export interface ArchitectureViolation {
  rule: ViolationRule;
  /** The SSOT rule's full id, such as `layers-point-down` or `decision.owns-ai-sdk`. */
  ruleId: string;
  /** The component the offending file belongs to, or null for an unmapped file. */
  component: string | null;
  path: string;
  line: number;
  /** The file, package, component or symbol it points at. */
  target?: string;
  message: string;
  /** `target` when the component has `status: target`, so it is known debt. */
  status: 'current' | 'target';
}

/** How a component dependency compares with what the SSOT declares. */
export type DependencyStatus = 'declared' | 'violation' | 'unused' | 'actual';

/** One edge of the component map, with the real dependency laid over the declared one. */
export interface MapEdge {
  from: string;
  to: string;
  weight: number;
  status: DependencyStatus;
}

/** One checklist item's verdict on one file. */
export interface ArchitectureFileResult {
  path: string;
  component: string | null;
  items: SpecItemResult<CheckVerdict>[];
  warnings: string[];
}

/** The result of `jevlint architecture check`. */
export interface ArchitectureCheckReport {
  root: string;
  dir: string;
  provider: string | null;
  model: string | null;
  /** False when paths or `--diff` narrowed the run, which leaves `unimplemented` empty. */
  complete: boolean;
  /** The base of `--diff`, when given. */
  base?: string;
  /** Violations that count, in path and line order. */
  violations: ArchitectureViolation[];
  /** Violations in components with `status: target`, which do not affect the exit code. */
  targetGaps: ArchitectureViolation[];
  /** Violations left out because the baseline records them. */
  baselined: number;
  /** Checklist verdicts per file. Empty with `--static`. */
  files: ArchitectureFileResult[];
  checklistViolations: number;
  /** Checklist items no file satisfies. */
  unimplemented: SpecItemRef[];
  usage: AuditReport['usage'];
  warnings: string[];
}

/** What kind of drift between the code and the SSOT. */
export type DriftKind =
  | 'unmapped-code'
  | 'undocumented-dependency'
  | 'undocumented-external'
  | 'stale-reference'
  | 'stale-summary'
  | 'stale-chapter'
  | 'stale-view'
  | 'document';

/** One way the SSOT no longer describes the code. */
export interface DriftItem {
  kind: DriftKind;
  component: string | null;
  /** The file, directory or SSOT file to look at. */
  path: string;
  line?: number;
  target?: string;
  message: string;
  /** True when the code it points at was added after `compiled_at`. */
  since?: boolean;
}

/** The result of `jevlint architecture drift`. */
export interface ArchitectureDriftReport {
  root: string;
  dir: string;
  provider: string | null;
  model: string | null;
  compiledAt: string | null;
  head: string | null;
  items: DriftItem[];
  /** Files added and removed since `compiled_at`. */
  added: string[];
  removed: string[];
  /** Documents compared with the SSOT, with `--docs`. */
  docs: SpecDocResult[];
  usage: AuditReport['usage'];
  warnings: string[];
}

/** One step of a refactoring plan, computed from the structure. */
export interface PlanStep {
  /** 1 is the first to do. */
  rank: number;
  /** Severity times churn times fan-in, normalised. */
  priority: number;
  problem: string;
  /** What to change, such as the import to cut. */
  move: string;
  component: string | null;
  evidence: Evidence[];
}

/** The result of `jevlint architecture plan`, as `plan.json`. */
export interface ArchitecturePlan {
  root: string;
  dir: string | null;
  steps: PlanStep[];
  warnings: string[];
}

/** One `compilerOptions.paths` entry, with its targets made root-relative. */
export interface PathAlias {
  /** The pattern, such as `@/*` or `~config`. At most one `*`. */
  pattern: string;
  /** Root-relative targets, each with at most one `*`. */
  targets: string[];
}

/** A workspace package: its name, its directory and the files its manifest names as entries. */
export interface WorkspacePackage {
  name: string;
  /** Root-relative. */
  dir: string;
  /** Root-relative entry files from `exports`, `module`, `main` and `types`. */
  entries: string[];
}

/** A field of a data type, with its type as written. */
export interface DataField {
  name: string;
  type: string;
}

/** A type that holds data: an interface, a struct, a dataclass, or a class with fields. */
export interface DataType {
  name: string;
  line: number;
  fields: DataField[];
}

/** A comment in the code, which often says why. Doc comments are left out. */
export interface CodeComment {
  line: number;
  text: string;
}

/** A data type in the facts, with the other data types its fields name. */
export interface FactDataType extends DataType {
  path: string;
  component: string | null;
  /** Names of other data types its fields refer to. */
  refs: string[];
  /** How many other data types refer to it. */
  usedBy: number;
}

/** A commit worth reading for the reasons behind the design. */
export interface CommitSummary {
  hash: string;
  subject: string;
  /** The first lines of the message body. */
  body: string;
  files: number;
}

/** What a node of a view stands for, which sets its shape. */
export type ViewNodeKind = 'actor' | 'component' | 'store' | 'queue' | 'external' | 'document';

/** A box in a drawn view. */
export interface ViewNode {
  id: string;
  label: string;
  kind: ViewNodeKind;
  /** The file or directory it stands for, root-relative. */
  path?: string;
  /** Or the SSOT component it stands for. */
  component?: string;
  /** For an external node: the packages that reach it, such as `ai` or `@ai-sdk/*`. */
  packages?: string[];
  group?: string;
  description?: string;
}

/** An arrow in a drawn view, owned by the caller. */
export interface ViewEdge {
  from: string;
  to: string;
  /** A short verb phrase, such as `asks questions`. */
  verb: string;
  /** Dashed for optional or inferred relationships. */
  style: 'solid' | 'dashed';
}

/** A curated diagram: a system context or the building blocks, for people to read. */
export interface GraphView {
  id: string;
  kind: 'graph';
  title: string;
  description?: string;
  groups: { id: string; label: string }[];
  nodes: ViewNode[];
  edges: ViewEdge[];
}

/** One entity of a data model view. */
export interface DataEntity {
  id: string;
  /** The type's name in the code. */
  name: string;
  path: string;
  description?: string;
  fields: { name: string; type: string; note?: string }[];
}

/** A relation between two entities. */
export interface DataRelation {
  from: string;
  to: string;
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  label: string;
}

/** A data model diagram, drawn as an ER diagram. */
export interface DataView {
  id: string;
  kind: 'data';
  title: string;
  description?: string;
  entities: DataEntity[];
  relations: DataRelation[];
}

/** A view of the SSOT, in `views/<id>.yaml`. */
export type ArchitectureView = GraphView | DataView;

/** A chapter of the architecture document, in `chapters/<name>.md`. */
export interface ArchitectureChapter {
  /** The file name without `.md`, which sets the order, such as `20-principles`. */
  id: string;
  title: string;
  /** Where its claims come from: `path`, `path:line`, `path:10-20` or `commit:<hash>`. */
  evidence: string[];
  body: string;
}

/** Where a decision record stands. Only `status` and `superseded_by` change once it is accepted. */
export type DecisionStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';

/** A dated, append-only decision record, in `decisions/<n>-<id>.md`. */
export interface ArchitectureDecision {
  id: string;
  /** The file name without `.md`, which sets the order, such as `0001-ai-sdk-in-decision`. */
  file: string;
  title: string;
  /** When it was accepted, as `YYYY-MM-DD`. */
  date: string;
  status: DecisionStatus;
  /** Ids of the decisions this one replaces. */
  supersedes: string[];
  /** The id of the decision that replaced this one, on a superseded record. */
  superseded_by: string | null;
  /** The components it is about. */
  components: string[];
  /** The rule and checklist ids that enforce it, as `check` names them. */
  enforced_by: string[];
  /** Where it comes from: `path`, `path:line`, `path:10-20` or `commit:<hash>`. */
  evidence: string[];
  body: string;
}

/** A check that still failed after the fixers: its command and what it printed. */
export interface FailedCheck {
  command: string[];
  output: string;
}
