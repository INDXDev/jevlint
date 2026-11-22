// Code features for the jevlintmodel gbdt student: a line-for-line port of `features_code.py`.
//
// Written by `jlm export ts`. The numbers must equal Python's, or the trees see different inputs, so this file
// keeps Python's semantics where JavaScript differs: regular expressions are translated from Python syntax
// (Unicode \w \d \s \b, `^`/`$` only at \n, `.` stopping only at \n), lengths count code points, and strip,
// split and splitlines use Python's whitespace and line breaks.
//
// No imports: the syntax trees come from the caller's `Parse` function. `parser.ts` builds one from
// web-tree-sitter with the grammar versions the model was trained with. Both sides parse UTF-16 text, which
// keeps error recovery, and with it the trees, identical.

export const FEATURE_VERSION = 4;
export const LANGUAGES = ['go', 'javascript', 'python', 'rust', 'typescript'] as const;
export type LanguageName = (typeof LANGUAGES)[number];

/** The parts of a tree-sitter node the features read. web-tree-sitter's `Node` has this shape. */
export interface SyntaxNode {
  readonly type: string;
  readonly isNamed: boolean;
  readonly isMissing: boolean;
  readonly hasError: boolean;
  readonly text: string;
  readonly startPosition: { row: number };
  readonly endPosition: { row: number };
  readonly children: (SyntaxNode | null)[];
  readonly namedChildren: (SyntaxNode | null)[];
  readonly namedChildCount: number;
  readonly descendantCount: number;
  readonly parent: SyntaxNode | null;
  readonly previousNamedSibling: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName(name: string): (SyntaxNode | null)[];
}

/**
 * Parses text with a language's grammar. The returned tree is deleted after use when it has `delete()`. Returns
 * null when the parse runs past the time limit (3 s in parser.ts, PARSE_TIMEOUT_MICROS in features_code.py):
 * real files parse in well under 0.1 s, but error recovery can run away on text in another language.
 */
export type Parse = (
  language: LanguageName,
  text: string,
) => { rootNode: SyntaxNode; delete?(): void } | null;

// --- Python semantics ------------------------------------------------------------------------------------------

const W = '\\p{L}\\p{N}_';
const SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SYNTAX = new Set('^$\\.*+?()[]{}|/');
const SPACE_CHARS = new RegExp(`[${SPACE}]`, 'u');

/** A Python regular expression (`re` module syntax, str patterns) translated to an equivalent JavaScript one. */
function translate(src: string, multiline: boolean): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[++i]!;
      if (n === 'w') out += inClass ? W : `[${W}]`;
      else if (n === 'W' && !inClass) out += `[^${W}]`;
      else if (n === 'd') out += '\\p{Nd}';
      else if (n === 'D' && !inClass) out += '[^\\p{Nd}]';
      else if (n === 's') out += inClass ? SPACE : `[${SPACE}]`;
      else if (n === 'S' && !inClass) out += `[^${SPACE}]`;
      else if (n === 'b' && !inClass) out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
      else if ('ntrfv'.includes(n)) out += `\\${n}`;
      else if (/[A-Za-z0-9]/.test(n)) throw new Error(`Untranslated escape \\${n} in ${src}`);
      else out += SYNTAX.has(n) || (inClass && n === '-') ? `\\${n}` : n;
    } else if (inClass) {
      out += c;
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
      out += c;
      if (src[i + 1] === '^') out += src[++i];
    } else if (c === '.') out += '[^\\n]';
    else if (c === '^') out += multiline ? '(?:(?<![\\s\\S])|(?<=\\n))' : '(?<![\\s\\S])';
    else if (c === '$') out += multiline ? '(?=\\n|(?![\\s\\S]))' : '(?=\\n?(?![\\s\\S]))';
    else if (c === '{') {
      const q = /^\{\d+(,\d*)?\}/.exec(src.slice(i));
      if (q) {
        out += q[0];
        i += q[0].length - 1;
      } else out += '\\{';
    } else if (c === '}') out += '\\}';
    else out += c;
  }
  return out;
}

/** Python's `re` operations over one translated pattern. */
interface PyRe {
  search(s: string): boolean;
  match(s: string): boolean;
  fullmatch(s: string): boolean;
  /** `re.search()`'s match: groups (unmatched ones as ''), index and length, or null. */
  exec(s: string): { groups: string[]; index: number; length: number } | null;
  count(s: string): number;
  /** `re.findall()`: whole matches without groups, the group with one, all groups with several. */
  findall(s: string): string[];
  findallGroups(s: string): string[][];
  sub(s: string, replacement: string): string;
}

/** Compiles a Python pattern. Flags: I (ignore case), M (multiline). */
function pyRe(src: string, flags = ''): PyRe {
  const body = translate(src, flags.includes('M'));
  const f = `u${flags.includes('I') ? 'i' : ''}`;
  const any = new RegExp(body, f);
  const all = new RegExp(body, `${f}g`);
  const sticky = new RegExp(body, `${f}y`);
  const full = new RegExp(`(?:${body})(?![\\s\\S])`, `${f}y`);
  const at = (re: RegExp, s: string) => {
    re.lastIndex = 0;
    return re.test(s);
  };
  return {
    search: (s) => any.test(s),
    match: (s) => at(sticky, s),
    fullmatch: (s) => at(full, s),
    exec: (s) => {
      const m = any.exec(s);
      return m ? { groups: m.map((g) => g ?? ''), index: m.index, length: m[0].length } : null;
    },
    count: (s) => [...s.matchAll(all)].length,
    findall: (s) => [...s.matchAll(all)].map((m) => (m.length === 1 ? m[0] : (m[1] ?? ''))),
    findallGroups: (s) => [...s.matchAll(all)].map((m) => m.slice(1).map((g) => g ?? '')),
    sub: (s, replacement) => s.replace(all, () => replacement),
  };
}

/** len() of a Python str: code points, not UTF-16 units. */
function plen(s: string): number {
  let n = s.length;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(i - 1);
      if (p >= 0xd800 && p <= 0xdbff) n--;
    }
  }
  return n;
}

/** s[:n] of a Python str. */
function pslice(s: string, n: number): string {
  if (s.length <= n) return s;
  let units = 0;
  for (let k = 0; k < n && units < s.length; k++) {
    const c = s.charCodeAt(units);
    units += c >= 0xd800 && c <= 0xdbff && units + 1 < s.length ? 2 : 1;
  }
  return s.slice(0, units);
}

function isSpace(ch: string): boolean {
  return SPACE_CHARS.test(ch);
}

function strip(s: string, chars?: string): string {
  return rstrip(lstrip(s, chars), chars);
}

function lstrip(s: string, chars?: string): string {
  let i = 0;
  while (i < s.length && (chars === undefined ? isSpace(s[i]!) : chars.includes(s[i]!))) i++;
  return s.slice(i);
}

function rstrip(s: string, chars?: string): string {
  let j = s.length;
  while (j > 0 && (chars === undefined ? isSpace(s[j - 1]!) : chars.includes(s[j - 1]!))) j--;
  return s.slice(0, j);
}

const SPLIT_WS = new RegExp(`[${SPACE}]+`, 'u');

/** str.split() without arguments. */
function splitWs(s: string): string[] {
  return s.split(SPLIT_WS).filter((x) => x !== '');
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** str.splitlines(). */
function splitlines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(LINE_BREAK);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function isUpper(s: string): boolean {
  return s === s.toUpperCase() && s !== s.toLowerCase();
}

function isLower(s: string): boolean {
  return s === s.toLowerCase() && s !== s.toUpperCase();
}

function firstChar(s: string): string {
  return pslice(s, 1);
}

function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

function lower(s: string): string {
  return s.toLowerCase();
}

function inc(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by);
}

function get(m: Map<string, number>, key: string): number {
  return m.get(key) ?? 0;
}

function sum(xs: Iterable<number>): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

function count<T>(xs: readonly T[], test: (x: T) => unknown): number {
  let n = 0;
  for (const x of xs) if (test(x)) n++;
  return n;
}

function max(xs: readonly number[], fallback = 0): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const x of xs) if (x > best) best = x;
  return xs.length ? best : fallback;
}

function nn(nodes: (SyntaxNode | null)[]): SyntaxNode[] {
  return nodes.filter((n): n is SyntaxNode => n !== null);
}

function field(node: SyntaxNode, ...names: string[]): SyntaxNode | null {
  for (const name of names) {
    const child = node.childForFieldName(name);
    if (child) return child;
  }
  return null;
}

function firstNamed(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildCount ? (node.namedChildren[0] ?? null) : null;
}

// --- feature names, in Python's order ---------------------------------------------------------------------------

export const FEATURE_NAMES = [
  'parsed',
  'parse_error_ratio',
  'code_lines',
  'test_functions',
  'functions',
  'fn_lines_max',
  'fn_lines_p90',
  'fn_statements_max',
  'fn_long_share',
  'fn_params_max',
  'fn_callees_max',
  'fn_paragraphs_max',
  'fn_mixed_level_share',
  'low_level_ops_per_100',
  'complexity_max',
  'complexity_mean',
  'nesting_max',
  'deep_nesting_lines_share',
  'branches_per_100',
  'else_after_return',
  'negated_conditions',
  'guard_clauses',
  'jumps_in_loops',
  'expr_size_max',
  'big_exprs_per_100',
  'bool_ops_max',
  'nested_ternaries',
  'call_chain_max',
  'long_lines_share',
  'magic_numbers_per_100',
  'magic_numbers_distinct',
  'magic_numbers_repeated',
  'magic_strings_compared',
  'named_constants',
  'names_declared',
  'name_len_mean',
  'name_single_char_share',
  'name_numbered_share',
  'name_generic_share',
  'name_abbrev_share',
  'name_words_mean',
  'name_vocabulary',
  'bool_names_unclear',
  'getters_with_effects',
  'fns_mutating_args',
  'fns_writing_self_share',
  'global_writes',
  'io_calls_per_100',
  'comment_lines_per_100',
  'doc_coverage',
  'comments_restating_share',
  'comments_reason_share',
  'todo_comments',
  'directives',
  'commented_code_lines',
  'commented_code_blocks',
  'unreachable_statements',
  'unused_private_functions',
  'unused_variables',
  'catches',
  'empty_catches',
  'swallowing_catches',
  'broad_catches',
  'unwraps_per_100',
  'ignored_results',
  'sentinel_returns',
  'error_checks_per_100',
  'error_statement_share',
  'external_inputs',
  'validation_calls',
  'injection_sinks',
  'dynamic_strings_into_calls',
  'auth_checks',
  'error_details_exposed',
  'weak_crypto',
  'secret_like_literals',
  'total_lines',
  'blank_line_share',
  'line_len_mean',
  'indent_depth_max',
  'imports',
  'type_declarations',
  'is_test_file',
  'fns_per_100',
  'fn_lines_mean',
  'fn_lines_median',
  'fn_statements_mean',
  'fns_over_80_lines',
  'fn_params_mean',
  'fns_complexity_over_10',
  'fns_nesting_over_3',
  'returns_max',
  'name_len_median',
  'name_len_max',
  'names_short_outside_loops',
  'fn_names_generic',
  'name_style_mixed',
  'param_single_char_share',
  'comment_blocks',
  'comment_block_lines_max',
  'comment_words_mean',
  'inline_comment_share',
  'doc_lines_per_100',
  'long_fns_uncommented',
  'complex_fns_uncommented',
  'commented_code_like_lines',
  'commented_code_block_max',
  'unused_imports',
  'disabled_blocks',
  'debug_statements',
  'deprecated_markers',
  'unused_private_types',
  'empty_functions',
  'process_exits',
  'http_handlers',
  'db_access',
  'sql_strings',
  'shell_commands',
  'path_operations',
  'html_output',
  'regex_from_variables',
  'unsafe_deserialization',
  'security_terms',
  'crypto_usage',
  'secure_random',
  'constant_time_compares',
  'tls_verification_off',
  'credential_urls',
  'placeholder_secrets',
] as const;

export const VECTOR_NAMES: readonly string[] = [
  ...FEATURE_NAMES.map((n) => `code__${n}`),
  ...LANGUAGES.map((l) => `lang__${l}`),
];

// --- grammar tables ---------------------------------------------------------------------------------------------

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const FUNCTION =
  set(`function_definition lambda function_declaration function_expression arrow_function
  method_definition generator_function_declaration generator_function function method_declaration func_literal
  function_item closure_expression`);
const NESTING =
  set(`if_statement if_expression for_statement for_in_statement while_statement do_statement
  while_expression for_expression loop_expression switch_statement match_statement match_expression
  expression_switch_statement type_switch_statement select_statement try_statement with_statement`);
const BRANCH = set(`if_statement elif_clause if_expression else_if_clause conditional_expression
  ternary_expression case_clause switch_case match_arm expression_case type_case communication_case
  except_clause catch_clause while_statement while_expression for_statement for_in_statement do_statement
  for_expression loop_expression`);
const IF = set('if_statement if_expression elif_clause');
const TERNARY = set('conditional_expression ternary_expression');
const OPERATOR_EXPR =
  set(`binary_expression boolean_operator comparison_operator not_operator unary_expression
  conditional_expression ternary_expression`);
const CALL = set('call call_expression macro_invocation new_expression');
const MEMBER = set('attribute member_expression selector_expression field_expression');
const INDEX = set('subscript subscript_expression index_expression slice slice_expression');
const STATEMENT_SUFFIXES = ['_statement', '_declaration', '_definition', '_item'];
const STATEMENT_EXTRA = set(
  'expression_statement let_declaration short_var_declaration return_expression',
);
const NOT_STATEMENTS =
  set(`function_definition function_declaration method_declaration function_item
  class_definition class_declaration import_statement import_from_statement import_declaration
  use_declaration`);
const BLOCK = set('block statement_block');
const JUMP =
  set(`return_statement raise_statement throw_statement break_statement continue_statement
  return_expression break_expression continue_expression`);
const EXIT = JUMP;
const CATCH = set('except_clause catch_clause');
const RAISE = set('raise_statement throw_statement');
const COMMENT = set('comment line_comment block_comment');
const STRING =
  set(`string template_string string_literal raw_string_literal interpreted_string_literal
  concatenated_string`);
const NUMBER = set('integer float number int_literal float_literal integer_literal');
const IDENT =
  set(`identifier property_identifier field_identifier type_identifier shorthand_property_identifier
  shorthand_property_identifier_pattern`);
const ARRAY =
  set(`list array array_expression tuple composite_literal literal_value set dictionary object
  tuple_expression`);
const CONST = set('const_spec const_item static_item enum_variant enum_assignment enum_body');
const ASSIGN =
  set(`assignment augmented_assignment assignment_expression augmented_assignment_expression
  assignment_statement compound_assignment_expr`);
const BOOL_OPS = set('&& || and or');
const COMPARE_OPS = set('== != === !== is in');
const TRIVIAL_NUMBERS = set('0 1 2 -1 0.0 1.0 0.5');
const LOOP_NAMES = set('i j k n _ e x y t ok id');
const GENERIC =
  set(`data tmp temp val value values obj item items res ret result results foo bar baz info stuff
  thing things manager helper util utils handle handler process do run arr list str num flag var elem object
  output input buf buffer ctx2 data2 obj2`);
const BOOL_PREFIXES =
  set(`is has have should can could will did does was were allow allows use uses enable
  enabled disable disabled needs need must include includes show skip found ok valid ready done any all`);
const QUERY_PREFIXES = set(
  `get is has find compute calc calculate to as parse format count check can should`,
);
const MUTATOR_PREFIXES =
  `set update init __init__ constructor reset add remove clear register load apply push pop
  insert delete close open start stop enter exit __enter__ __exit__ __post_init__ new with mark configure setup
  set_up setUp tearDown handle on write save put process run visit emit flush drop poll send fill build
  make`
    .split(/\s+/)
    .filter(Boolean);
const MUTATING_METHODS =
  set(`append extend insert pop remove clear sort reverse update setdefault push unshift
  shift splice set delete add discard push_str truncate retain drain fill`);
const IO_NAMES = pyRe(
  '^(print|println|printf|eprintln|dbg|open|write|writeln|fetch|log|debug|info|warn|warning|error|' +
    'exception|critical|Print|Println|Printf|Fprintf|Fprintln|WriteFile|ReadFile|readFile|writeFile|' +
    'readFileSync|writeFileSync|urlopen|system|popen|run|exec|spawn|send|request|get_json)$',
);
const IO_RECEIVERS =
  set(`console logger logging log fs os sys requests httpx http subprocess fmt io socket
  process shutil Path stdout stderr`);

const SPLIT_CAMEL = pyRe('[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\\d+');
const WORD = pyRe('[A-Za-z]{3,}');
const VOWEL = pyRe('[aeiouy]');
const COMMENT_MARK = pyRe('^\\s*(?://+!?|/\\*+!?|#+!?|\\*+(?!/))\\s?|\\s*\\*+/\\s*$');
const LICENSE = pyRe('copyright|licen[cs]e|spdx', 'I');
const DIRECTIVE = pyRe(
  '@ts-|eslint-|noqa|type:\\s*ignore|nolint|go:build|go:generate|go:linkname|go:noinline|prettier-ignore|' +
    'istanbul|c8 ignore|pragma|pylint:|mypy:|fmt:|isort:|biome-|jshint|@flow|@format|-\\*-|^\\s*!|clippy::|' +
    'rustfmt::|SAFETY:|@vitest|@jest-environment|@noflow|@lightSyntaxTransform|@emails|@generated',
  'I',
);
const TODO = pyRe('\\b(TODO|FIXME|HACK|XXX)\\b');
const REASON = pyRe(
  '\\b(because|since|so that|otherwise|note|warning|must|avoid|workaround|hack|why|ensure|in order to|careful|' +
    'important|due to|caveat|assume|assumes|instead|unless|required|requires|beware|never|only if|so we|we need)\\b',
  'I',
);
const CODE_HINT = pyRe(
  '[(){}\\[\\];=]|^\\s*(return|import|from|let|const|var|def|fn|func|if|for|while|use)\\b',
);
const PROSE_END = pyRe('[a-z]{3,}[.:!?]$');
const BARE_ASSIGN = pyRe('^\\s*[A-Za-z_][\\w.]*\\s*=\\s*$');
const STOP =
  set(`the and for this that with from into are was not but its it's then than when will can all any
  has have use used using get set new our out you your one also just here there`);
const TEST_FN = pyRe(
  '^\\s*(def test_\\w+|func Test\\w+|#\\[(tokio::)?test\\]|(it|test|describe)\\(\\s*[\'"`])',
  'M',
);
const INPUTS = pyRe(
  '\\brequest\\.(args|form|json|data|GET|POST|query_params|path_params|body|files|headers|cookies|values|' +
    'get_json)|\\breq\\.(body|query|params|headers|cookies|files)|\\bc\\.(Query|Param|PostForm|GetHeader|' +
    'ShouldBind\\w*|Bind\\w*)\\(|\\bc\\.req\\.(json|query|param|header|parseBody|formData)|os\\.environ|getenv|' +
    'process\\.env|sys\\.argv|os\\.Args|env::args|env::var|\\binput\\(|FormValue|URL\\.Query|r\\.Body|stdin|' +
    'readline\\(',
);
const VALIDATION = pyRe(
  '\\bisinstance\\(|\\btypeof\\b|\\bvalidate\\w*|\\bschema\\b|\\bparseInt\\(|\\bNumber\\(|\\bstrconv\\.|\\bparse::<|' +
    '\\.parse\\(|\\bis_valid\\(|\\bassert\\w*\\(|BaseModel|\\bz\\.(object|string|number)|\\bclean_\\w+|\\.isdigit\\(|' +
    '\\bmatch(es)?\\(|\\bre\\.fullmatch|\\blen\\([^)]*\\)\\s*[<>]|\\.length\\s*[<>]|Validator|\\bguard\\b',
);
const SINKS = pyRe(
  '(execute|executemany|query|raw|exec)\\s*\\(\\s*(f[\'"]|[\'"][^\'"]*[\'"]\\s*(%|\\+|\\.format)|`[^`]*\\$\\{)|' +
    'shell\\s*=\\s*True|\\beval\\s*\\(|new\\s+Function\\s*\\(|innerHTML\\s*=|outerHTML\\s*=|dangerouslySetInnerHTML|' +
    'document\\.write\\(|os\\.system\\(|mark_safe\\(|\\|\\s*safe\\b|Command::new\\(\\s*\\"(sh|bash)\\"|exec\\.Command\\(' +
    '\\s*\\"(sh|bash)\\"|child_process|execSync\\(',
  'I',
);
const DYNAMIC_INTO = pyRe(
  '\\b(execute|query|system|exec|popen|run|open|Command|raw|render_template_string)\\s*\\(\\s*(f[\'"]|`[^`]*\\$\\{|' +
    '[\'"][^\'"]*[\'"]\\s*\\.format|[\'"][^\'"]*[\'"]\\s*%\\s)',
);
const AUTH = pyRe(
  'permission|authoriz|is_authenticated|login_required|has_perm|\\bowner\\b|current_user|is_admin|is_staff|' +
    '\\brole(s)?\\b|forbidden|\\b403\\b|Unauthorized|requireAuth|isAuthenticated|access_control|can_\\w+\\(',
  'I',
);
const EXPOSE = pyRe(
  'traceback\\.(format_exc|print_exc)|\\.stack\\b|str\\(e\\)|str\\(exc\\)|err\\.Error\\(\\)|e\\.message|' +
    'error\\.message|repr\\(e\\)|DEBUG\\s*=\\s*True|debug\\s*=\\s*True|\\{e\\}|\\{err\\}|\\{exc\\}',
);
const WEAK_CRYPTO = pyRe(
  '\\b(md5|sha1)\\b|createHash\\(\\s*[\'"](md5|sha1)|Math\\.random\\(|\\brandom\\.(random|randint|choice|' +
    'randrange)\\(|math/rand|(password|secret|token|digest|signature|hmac)\\w*\\s*===?\\s*\\w+|(iv|key|nonce)\\s*=' +
    '\\s*b?[\'"][^\'"]{8,}[\'"]',
  'I',
);
const SECRET_NAME = pyRe(
  '(password|passwd|secret|api_?key|access_?key|token|private_?key)\\w*[\'"]?\\s*[:=]\\s*[\'"][^\'"\\s]{8,}[\'"]',
  'I',
);
const PRIVATE_KEY = pyRe(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk_live_',
);
const HTTP = pyRe(
  '@(app|router|bp|blueprint|api)\\.(route|get|post|put|patch|delete)\\b|@(Get|Post|Put|Patch|Delete|' +
    'Controller)\\(|\\b(app|router|server)\\.(get|post|put|patch|delete|all|use)\\(\\s*[\'"`/]|HandleFunc\\(|' +
    'http\\.ResponseWriter|\\*gin\\.Context|echo\\.Context|#\\[(get|post|put|delete|patch)\\(|\\.route\\(\\s*\\"|' +
    'Router::new\\(\\)|def (get|post|put|patch|delete)\\(self, request',
);
const DB = pyRe(
  '\\.(execute|executemany|raw|query|exec|QueryRow|QueryContext|ExecContext)\\(|\\bcursor\\(|\\.objects\\.|' +
    '\\bsql\\.(Open|DB)\\b|session\\.(query|execute)\\(|\\bprisma\\.|\\bknex\\(|\\.where\\(',
  'I',
);
const SQL_START = pyRe(
  '^\\W{0,4}(select|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from|create\\s+table|' +
    'alter\\s+table|drop\\s+table|with\\s+\\w+\\s+as)\\b',
  'I',
);
const SHELL = pyRe(
  '\\bsubprocess\\.\\w+\\(|os\\.system\\(|os\\.popen\\(|exec\\.Command(Context)?\\(|Command::new\\(|child_process|' +
    '\\bexecSync\\(|\\bspawn(Sync)?\\(',
);
const PATHS = pyRe(
  '\\bopen\\(|os\\.path\\.join\\(|\\bpath\\.(join|resolve)\\(|filepath\\.(Join|Clean|Abs)\\(|File::(open|create)\\(|' +
    '\\b(readFile|writeFile|readFileSync|writeFileSync|createReadStream)\\(|\\bPath\\(|fs::(read|write|remove)\\w*\\(|' +
    'os\\.(Open|Create|ReadFile|WriteFile|Remove)\\(',
);
const HTML = pyRe(
  '\\brender(_template|_to_string|_template_string)?\\(|\\.innerHTML\\b|dangerouslySetInnerHTML|res\\.send\\(|' +
    '\\.Execute(Template)?\\(|template\\.HTML\\(|mark_safe\\(|Markup\\(|v-html',
);
const REGEX_VAR = pyRe(
  'new RegExp\\(\\s*[A-Za-z_`]|re\\.compile\\(\\s*[A-Za-z_]|regexp\\.(Must)?Compile\\(\\s*[A-Za-z_]|' +
    'Regex::new\\(\\s*&?[a-z_]',
);
const DESERIALIZE = pyRe(
  'pickle\\.loads?\\(|yaml\\.load\\((?![^)]*SafeLoader)|marshal\\.loads?\\(|unserialize\\(|' +
    '\\beval\\(\\s*(data|body|payload|input|request)',
);
const SECURITY_TERMS = pyRe(
  'password|passwd|\\btoken|secret|credential|\\bsession|cookie|csrf|\\bjwt|\\bauth',
  'I',
);
const CRYPTO = pyRe(
  '\\bhashlib\\b|\\bcrypto\\b|crypto/|\\bhmac\\b|cipher|\\bjwt\\b|bcrypt|argon2|scrypt|pbkdf2|sha256|sha512|ring::|' +
    'rustls|\\baes\\b|\\brsa\\b|\\.sign\\(|\\.verify\\(',
  'I',
);
const SECURE_RANDOM = pyRe(
  '\\bsecrets\\.\\w+|crypto/rand|randomBytes|getRandomValues|OsRng|os\\.urandom|randomUUID|thread_rng',
);
const CONST_TIME = pyRe(
  'compare_digest|ConstantTimeCompare|timingSafeEqual|constant_time_eq|ct_eq',
);
const TLS_OFF = pyRe(
  'verify\\s*=\\s*False|InsecureSkipVerify:\\s*true|rejectUnauthorized:\\s*false|' +
    'danger_accept_invalid_(certs|hostnames)\\(\\s*true|CERT_NONE|check_hostname\\s*=\\s*False',
);
const CRED_URL = pyRe('[a-z][a-z0-9+.-]*://[^/\\s:@\'\\"]+:[^/\\s@\'\\"]+@', 'I');
const PLACEHOLDER_SECRET = pyRe(
  '(password|passwd|secret|api_?key|token)\\w*[\'"]?\\s*[:=]\\s*[\'"](changeme|change-me|x{3,}|\\*{3,}|your[-_ ]' +
    '|<|\\$\\{|example|test|dummy|fake|secret|password|placeholder|todo)',
  'I',
);
const DEBUG = pyRe(
  'console\\.(log|debug|trace)\\(|\\bdbg!\\(|^\\s*debugger;?\\s*$|\\bbreakpoint\\(\\)|\\bpdb\\.set_trace|import pdb',
  'M',
);
const DEPRECATED = pyRe(
  '@deprecated|#\\[deprecated|Deprecated:|DeprecationWarning|\\bdeprecated\\(',
  'I',
);
const EXITS = pyRe(
  '\\bpanic!\\(|\\bpanic\\(|\\btodo!\\(|\\bunimplemented!\\(|process\\.exit\\(|os\\.Exit\\(|sys\\.exit\\(',
);
const DISABLED = pyRe(
  '^\\s*(if\\s+(False|0)\\s*:|if\\s*\\(\\s*(false|0)\\s*\\)|#if\\s+0\\b|if\\s+false\\s*\\{)',
  'M',
);
const TEST_IMPORT = pyRe(
  '^\\s*(import pytest|import unittest|from unittest|import \\{[^}]*\\b(describe|it|test|' +
    'expect)\\b[^}]*\\} from [\'"](vitest|@jest/globals|node:test|mocha)|\\"testing\\"|' +
    '#\\[cfg\\(test\\)\\])',
  'M',
);
const CODE_LIKE = pyRe(
  '[;{}\\[(,]\\s*$|^\\s*[}\\])]|=>|:=|^\\s*(return|import|from|let|const|var|def|fn|func|if|for|while|use|export|' +
    'type|class|pub|await|else|elif|try|except|catch|match|case|switch|impl|struct|async)\\b|' +
    '^\\s*[\\w.$\\[\\]\\"\']+\\s*(\\+|-|\\*|/|\\|\\||&&)?=\\s*\\S|^\\s*[\\w.$]+\\([^)]*\\)\\s*;?$|^\\s*[?:|]\\s',
);
const PROSE = pyRe("^[A-Za-z][A-Za-z'\\-]*(\\s+[A-Za-z][A-Za-z,'\\-]*){3,}[.:!?]?$");
const TOKEN = pyRe('[A-Za-z_$][\\w$]*');
const GENERIC_FN =
  set(`handle process do run execute perform manage doit dostuff go main2 data info stuff thing
  helper util func fn foo bar test1 temp tmp work go2 run2 handle2 process2 callback cb f g h`);
const TYPE_DECLS =
  set(`interface_declaration type_alias_declaration enum_declaration struct_item enum_item
  trait_item type_item type_declaration union_item`);
const NAMED_DECLS = new Set([
  ...[...TYPE_DECLS].filter((t) => t !== 'type_declaration'),
  ...set(`type_spec class_definition class_declaration abstract_class_declaration enum_variant field_declaration
    property_signature public_field_definition`),
]);
const SWALLOW = pyRe('\\b(raise|throw|return|reject|panic|abort|exit|error|Error|fail|warn)\\b');
const BROAD = pyRe('\\b(Base)?Exception\\b');
const IGNORED = pyRe('(^|,)\\s*_\\s*(,|$)');
const IDENT_WORD = pyRe('[A-Za-z_]\\w*');
const CODE_PUNCT = pyRe('[(){}\\[\\];=]');
const NUMBERED = pyRe('[A-Za-z]\\d+$');
const CAMEL = pyRe('[a-z][A-Z]');

// Lexical features: (pattern, lowercase substrings at least one of which must occur for a match).
const LEXICAL: [string, PyRe, string[]][] = [
  [
    'external_inputs',
    INPUTS,
    [
      'request',
      'req.',
      'c.',
      'environ',
      'getenv',
      'process.env',
      'argv',
      'os.args',
      'env::',
      'input(',
      'formvalue',
      'url.query',
      'r.body',
      'stdin',
      'readline',
    ],
  ],
  [
    'validation_calls',
    VALIDATION,
    [
      'isinstance',
      'typeof',
      'validat',
      'schema',
      'parseint',
      'number(',
      'strconv',
      'parse',
      'is_valid',
      'assert',
      'basemodel',
      'z.',
      'clean_',
      'isdigit',
      'match',
      'len(',
      '.length',
      'guard',
    ],
  ],
  [
    'injection_sinks',
    SINKS,
    [
      'execute',
      'query',
      'raw',
      'exec',
      'shell',
      'eval',
      'function(',
      'innerhtml',
      'outerhtml',
      'dangerously',
      'document.write',
      'os.system',
      'mark_safe',
      'safe',
      'command',
      'child_process',
    ],
  ],
  [
    'dynamic_strings_into_calls',
    DYNAMIC_INTO,
    [
      'execute',
      'query',
      'system',
      'exec',
      'popen',
      'run(',
      'open(',
      'command(',
      'raw(',
      'render_template_string',
    ],
  ],
  [
    'auth_checks',
    AUTH,
    [
      'permission',
      'authoriz',
      'authenticated',
      'login_required',
      'has_perm',
      'owner',
      'current_user',
      'admin',
      'staff',
      'role',
      'forbidden',
      '403',
      'unauthorized',
      'requireauth',
      'access_control',
      'can_',
    ],
  ],
  [
    'error_details_exposed',
    EXPOSE,
    [
      'traceback',
      '.stack',
      'str(e',
      'error()',
      'message',
      'repr(e',
      'debug',
      '{e}',
      '{err}',
      '{exc}',
    ],
  ],
  [
    'weak_crypto',
    WEAK_CRYPTO,
    [
      'md5',
      'sha1',
      'random',
      'math/rand',
      'password',
      'secret',
      'token',
      'digest',
      'signature',
      'hmac',
      'iv',
      'key',
      'nonce',
    ],
  ],
  [
    'http_handlers',
    HTTP,
    [
      'route',
      'app.',
      'router',
      'handlefunc',
      'responsewriter',
      'gin.context',
      'echo.context',
      '@get',
      '@post',
      '#[get',
      '#[post',
      'handler',
    ],
  ],
  [
    'db_access',
    DB,
    ['execute', 'cursor', 'query', 'objects.', 'sql', 'session.', 'prisma', 'knex', 'where('],
  ],
  [
    'shell_commands',
    SHELL,
    [
      'subprocess',
      'os.system',
      'popen',
      'exec.command',
      'command::new',
      'child_process',
      'execsync',
      'spawn',
    ],
  ],
  [
    'path_operations',
    PATHS,
    [
      'open(',
      'path.join',
      'filepath.join',
      'file::open',
      'readfile',
      'writefile',
      'path(',
      'os.path',
      'fs::',
    ],
  ],
  ['html_output', HTML, ['render', 'innerhtml', 'res.send', 'template', 'html', 'markup']],
  ['regex_from_variables', REGEX_VAR, ['regexp', 're.compile', 'mustcompile', 'regex::new']],
  [
    'unsafe_deserialization',
    DESERIALIZE,
    ['pickle', 'yaml.load', 'marshal', 'unserialize', 'eval('],
  ],
  [
    'security_terms',
    SECURITY_TERMS,
    [
      'password',
      'passwd',
      'token',
      'secret',
      'credential',
      'session',
      'cookie',
      'csrf',
      'jwt',
      'auth',
    ],
  ],
  [
    'crypto_usage',
    CRYPTO,
    [
      'hashlib',
      'crypto',
      'hmac',
      'cipher',
      'jwt',
      'bcrypt',
      'argon2',
      'scrypt',
      'pbkdf2',
      'sha256',
      'sha512',
      'ring::',
      'rustls',
      'aes',
      'rsa',
      'sign',
    ],
  ],
  [
    'secure_random',
    SECURE_RANDOM,
    [
      'secrets.',
      'crypto/rand',
      'randombytes',
      'getrandomvalues',
      'osrng',
      'urandom',
      'randomuuid',
      'thread_rng',
    ],
  ],
  [
    'constant_time_compares',
    CONST_TIME,
    ['compare_digest', 'constanttimecompare', 'timingsafeequal', 'constant_time'],
  ],
  [
    'tls_verification_off',
    TLS_OFF,
    ['verify', 'insecureskipverify', 'rejectunauthorized', 'danger'],
  ],
  ['credential_urls', CRED_URL, ['://']],
  ['placeholder_secrets', PLACEHOLDER_SECRET, ['password', 'passwd', 'secret', 'key', 'token']],
  ['debug_statements', DEBUG, ['console.', 'dbg!', 'debugger', 'breakpoint', 'pdb']],
  ['deprecated_markers', DEPRECATED, ['deprecat']],
  ['process_exits', EXITS, ['panic', 'todo!', 'unimplemented!', 'exit']],
  ['disabled_blocks', DISABLED, ['if false', 'if (false)', 'if 0', '#if 0', 'if (0)']],
];

const subtokenCache = new Map<string, string[]>();

/** parseHTTPResponse_v2 -> ['parse', 'http', 'response', 'v', '2'] */
export function subtokens(name: string): string[] {
  let out = subtokenCache.get(name);
  if (out === undefined) {
    out = name.split('_').flatMap((part) => SPLIT_CAMEL.findall(part).map(lower));
    if (subtokenCache.size > 100_000) subtokenCache.clear();
    subtokenCache.set(name, out);
  }
  return out;
}

function statementsOf(block: SyntaxNode): SyntaxNode[] {
  let children = nn(block.namedChildren).filter((c) => !COMMENT.has(c.type));
  if (children.length === 1 && children[0]!.type === 'statement_list') {
    children = nn(children[0]!.namedChildren).filter((c) => !COMMENT.has(c.type));
  }
  return children;
}

function errorCount(root: SyntaxNode): number {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === 'ERROR' || node.isMissing) n++;
    if (node.hasError) stack.push(...nn(node.children));
  }
  return n;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  const chars = Array.from(s);
  for (const ch of chars) inc(counts, ch);
  let total = 0;
  for (const c of counts.values()) total += (c / chars.length) * Math.log2(c / chars.length);
  return -total;
}

interface Fn {
  name: string;
  lines: number;
  params: Set<string>;
  startRow: number;
  endRow: number;
  complexity: number;
  nesting: number;
  statements: number;
  callees: Set<string>;
  namedCalls: number;
  lowLevel: number;
  mutatesArgs: boolean;
  writesSelf: boolean;
  doesIo: boolean;
  hasDoc: boolean;
  isMethod: boolean;
  returns: number;
}

type Comment = [number, number, string];

const PATTERN_NODES =
  set(`expression_list pattern_list tuple_pattern list_pattern array_pattern object_pattern
  tuple parenthesized_expression mut_pattern shorthand_property_identifier_pattern pair_pattern typed_parameter
  default_parameter typed_default_parameter required_parameter optional_parameter parameter
  parameter_declaration assignment_pattern ref_pattern`);
const PATTERN_TYPES =
  set(`type type_annotation type_identifier primitive_type generic_type pointer_type
  qualified_type slice_type reference_type`);
const PATTERN_STOP = set(
  'default_parameter typed_default_parameter assignment_pattern optional_parameter required_parameter',
);

/** What one walk over a syntax tree collects. */
interface Walker {
  fns: Fn[];
  declared: string[];
  locals: string[];
  privateFns: string[];
  idents: Map<string, number>;
  comments: Comment[];
  strings: string[];
  c: Map<string, number>;
  magic: Map<string, number>;
  exprSizes: number[];
  boolOps: number[];
  chains: number[];
  fnNestingBase: number[];
  deepStatements: number;
  statements: number;
  errorStatements: number;
  nodes: number;
  lang: LanguageName;
}

function newWalker(lang: LanguageName): Walker {
  return {
    fns: [],
    declared: [],
    locals: [],
    privateFns: [],
    idents: new Map(),
    comments: [],
    strings: [],
    c: new Map(),
    magic: new Map(),
    exprSizes: [],
    boolOps: [],
    chains: [],
    fnNestingBase: [],
    deepStatements: 0,
    statements: 0,
    errorStatements: 0,
    nodes: 0,
    lang,
  };
}

function rootObject(w: Walker, start: SyntaxNode | null): string | null {
  let node = start;
  while (
    node !== null &&
    (MEMBER.has(node.type) || INDEX.has(node.type) || node.type === 'parenthesized_expression')
  ) {
    node = field(node, 'object', 'value', 'operand') ?? firstNamed(node);
  }
  if (node !== null && (node.type === 'identifier' || node.type === 'self' || node.type === 'this'))
    return node.text;
  return null;
}

function callee(w: Walker, node: SyntaxNode): [string, string | null] {
  const fn = field(node, 'function', 'macro', 'constructor');
  if (fn === null) return ['', null];
  if (MEMBER.has(fn.type)) {
    const prop = field(fn, 'property', 'attribute', 'field');
    return [prop !== null ? prop.text : '', rootObject(w, fn)];
  }
  const parts = fn.text.split('::');
  return [parts[parts.length - 1]!, null];
}

function chainLength(w: Walker, start: SyntaxNode): number {
  let length = 0;
  let node: SyntaxNode | null = start;
  while (node !== null && CALL.has(node.type)) {
    const fn: SyntaxNode | null = node.childForFieldName('function');
    if (fn === null || !MEMBER.has(fn.type)) break;
    length++;
    node = field(fn, 'object', 'value', 'operand');
    while (
      node !== null &&
      (node.type === 'await_expression' ||
        node.type === 'try_expression' ||
        node.type === 'non_null_expression')
    ) {
      node = firstNamed(node);
    }
  }
  return length;
}

function declareTargets(w: Walker, node: SyntaxNode, local: boolean): void {
  for (const sub of patternNames(w, node)) {
    w.declared.push(sub);
    if (local) w.locals.push(sub);
  }
}

function patternNames(w: Walker, node: SyntaxNode | null): string[] {
  if (node === null) return [];
  if (node.type === 'identifier') return [node.text];
  if (!PATTERN_NODES.has(node.type)) return [];
  if (node.type === 'shorthand_property_identifier_pattern') return [node.text];
  const names: string[] = [];
  for (const child of nn(node.namedChildren)) {
    if (PATTERN_TYPES.has(child.type)) continue;
    names.push(...patternNames(w, child));
    if (PATTERN_STOP.has(node.type)) break; // the rest is the default value or type
  }
  return names;
}

function walk(w: Walker, root: SyntaxNode): void {
  // flags: 1 in literal, 2 in const context, 4 in catch/error block, 8 in ternary, 16 in test fn,
  //        32 in array literal
  const stack: [SyntaxNode, number, number, number][] = [[root, -1, 0, 0]];
  while (stack.length) {
    let [node, fi, nesting, flags] = stack.pop() as [SyntaxNode, number, number, number];
    w.nodes++;
    const t = node.type;
    if (!node.isNamed) {
      if (COMPARE_OPS.has(t) && node.parent !== null) {
        for (const sib of nn(node.parent.namedChildren)) {
          if (STRING.has(sib.type) && plen(sib.text) > 3) inc(w.c, 'magic_strings_compared');
        }
      }
      continue;
    }
    const fn = fi >= 0 ? w.fns[fi]! : null;
    if (COMMENT.has(t)) {
      w.comments.push([node.startPosition.row, node.endPosition.row, node.text]);
      continue;
    }
    if (STRING.has(t)) {
      if (!(flags & 1)) w.strings.push(node.text);
      flags |= 1;
    }
    if (flags & 1) {
      if (t === 'interpolation' || t === 'template_substitution') flags &= ~1;
      else {
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (child) stack.push([child, fi, nesting, flags]);
        }
        continue;
      }
    }
    if (
      (STATEMENT_SUFFIXES.some((s) => t.endsWith(s)) || STATEMENT_EXTRA.has(t)) &&
      !NOT_STATEMENTS.has(t)
    ) {
      w.statements++;
      if (fn !== null) {
        fn.statements++;
        if (nesting - w.fnNestingBase[fi]! >= 3) w.deepStatements++;
      }
      if (flags & 4 || RAISE.has(t)) w.errorStatements++;
    }
    if (IDENT.has(t)) inc(w.idents, node.text);
    else if (NUMBER.has(t)) {
      let value = rstrip(lower(node.text), 'ulfi_');
      const parent = node.parent;
      if (
        parent !== null &&
        (parent.type === 'unary_expression' || parent.type === 'unary_operator')
      )
        value = `-${value}`;
      if (!TRIVIAL_NUMBERS.has(value) && !(flags & (2 | 16 | 32))) inc(w.magic, value);
    } else if (BRANCH.has(t) && fn !== null) fn.complexity++;
    if (BRANCH.has(t)) inc(w.c, 'branches');
    if (IF.has(t)) visitIf(w, node);
    else if (CATCH.has(t)) {
      visitCatch(w, node);
      flags |= 4;
    } else if (TERNARY.has(t)) {
      if (flags & 8) inc(w.c, 'nested_ternaries');
      flags |= 8;
    } else if (
      t === 'break_statement' ||
      t === 'continue_statement' ||
      t === 'break_expression' ||
      t === 'continue_expression'
    ) {
      inc(w.c, 'jumps_in_loops');
    } else if (t === 'return_statement' || t === 'return_expression') {
      if (fn !== null) fn.returns++;
      const value = firstNamed(node);
      if (
        value !== null &&
        (['none', 'null', 'nil', 'undefined'].includes(value.type) ||
          ['-1', 'None', 'null'].includes(value.text))
      ) {
        inc(w.c, 'sentinel_returns');
      }
    } else if (t === 'try_expression' || RAISE.has(t)) inc(w.c, 'error_checks');
    else if (
      t === 'global_statement' ||
      t === 'nonlocal_statement' ||
      (t === 'static_item' && pslice(node.text, 20).includes('mut'))
    ) {
      inc(w.c, 'global_writes');
    }
    if (
      CONST.has(t) ||
      ((t === 'assignment' || t === 'lexical_declaration' || t === 'variable_declarator') && fi < 0)
    ) {
      const head = pslice(node.text, 60);
      const target = field(node, 'left', 'name');
      if (CONST.has(t) || head.startsWith('const') || (target !== null && isUpper(target.text))) {
        inc(w.c, 'named_constants', t !== 'lexical_declaration' ? 1 : 0);
        flags |= 2;
      }
    }
    if (ARRAY.has(t) && node.namedChildCount > 3) flags |= 32;
    if (OPERATOR_EXPR.has(t)) {
      const parent = node.parent;
      if (
        parent === null ||
        !(OPERATOR_EXPR.has(parent.type) || parent.type === 'parenthesized_expression')
      ) {
        // Literal operands (test data such as `x == {...}`) are not expression complexity.
        let literal = 0;
        for (const ch of nn(node.namedChildren))
          if (ARRAY.has(ch.type) || STRING.has(ch.type)) literal += ch.descendantCount;
        w.exprSizes.push(node.descendantCount - literal);
      }
    }
    if (
      INDEX.has(t) ||
      (t === 'binary_expression' &&
        nn(node.children).some(
          (ch) => !ch.isNamed && ['&', '|', '^', '<<', '>>'].includes(ch.type),
        ))
    ) {
      inc(w.c, 'low_level_ops');
      if (fn !== null) fn.lowLevel++;
    }
    if (NAMED_DECLS.has(t)) {
      for (const n of nn(node.childrenForFieldName('name'))) w.declared.push(n.text);
    } else if (t === 'enum_body') {
      for (const n of nn(node.namedChildren))
        if (n.type === 'property_identifier') w.declared.push(n.text);
    }
    if (CALL.has(t)) visitCall(w, node, fn);
    if (
      ASSIGN.has(t) ||
      t === 'variable_declarator' ||
      t === 'short_var_declaration' ||
      t === 'let_declaration'
    ) {
      visitAssign(w, node, fn, fi);
    }
    if (BLOCK.has(t) || t === 'module' || t === 'program' || t === 'source_file')
      visitBlock(w, node);
    const childNesting = NESTING.has(t) ? nesting + 1 : nesting;
    if (fn !== null && NESTING.has(t))
      fn.nesting = Math.max(fn.nesting, childNesting - w.fnNestingBase[fi]!);
    if (FUNCTION.has(t)) {
      fi = visitFunction(w, node, fi, childNesting);
      if (TEST_FN.match(pslice(node.text, 80)) || startsWithAny(w.fns[fi]!.name, ['test', 'Test']))
        flags |= 16;
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push([child, fi, childNesting, flags]);
    }
  }
}

function visitFunction(w: Walker, node: SyntaxNode, _parentFi: number, nesting: number): number {
  const nameNode = node.childForFieldName('name');
  const name = nameNode !== null ? nameNode.text : '';
  const paramsNode = field(node, 'parameters', 'parameter');
  const params = new Set<string>();
  if (paramsNode !== null) {
    if (paramsNode.type === 'identifier') params.add(paramsNode.text);
    for (const child of nn(paramsNode.namedChildren)) {
      for (const p of patternNames(w, child)) params.add(p);
      if (child.type === 'identifier') params.add(child.text);
    }
  }
  for (const p of ['self', 'cls', 'this']) params.delete(p);
  w.declared.push(...params);
  const parent = node.parent;
  if (name) {
    w.declared.push(name);
    const isPrivate =
      (w.lang === 'python' && name.startsWith('_') && !name.startsWith('__')) ||
      // Go: lowercase functions are visible package-wide, so a file cannot tell. Rust: only free functions;
      // methods may implement a trait that is called from elsewhere.
      (w.lang === 'rust' &&
        node.type === 'function_item' &&
        parent !== null &&
        parent.type === 'source_file' &&
        !node.text.startsWith('pub')) ||
      ((w.lang === 'javascript' || w.lang === 'typescript') &&
        node.type === 'function_declaration' &&
        (parent === null || parent.type !== 'export_statement'));
    if (isPrivate && name !== 'main' && name !== 'init') w.privateFns.push(name);
  }
  const fn: Fn = {
    name,
    lines: node.endPosition.row - node.startPosition.row + 1,
    params,
    startRow: node.startPosition.row,
    endRow: node.endPosition.row,
    complexity: 1,
    nesting: 0,
    statements: 0,
    callees: new Set(),
    namedCalls: 0,
    lowLevel: 0,
    mutatesArgs: false,
    writesSelf: false,
    doesIo: false,
    hasDoc: false,
    isMethod:
      node.type === 'method_definition' ||
      node.type === 'method_declaration' ||
      (parent !== null &&
        ['block', 'declaration_list', 'class_body'].includes(parent.type) &&
        pslice((paramsNode ?? node).text, 40).includes('self')),
    returns: 0,
  };
  const body = node.childForFieldName('body');
  if (w.lang === 'python' && body !== null && body.namedChildCount) {
    const first = body.namedChildren[0] as SyntaxNode;
    fn.hasDoc =
      first.type === 'expression_statement' &&
      first.namedChildCount > 0 &&
      (first.namedChildren[0] as SyntaxNode).type === 'string';
  } else {
    let prev = node.previousNamedSibling;
    if (prev === null && parent !== null && parent.type === 'export_statement')
      prev = parent.previousNamedSibling;
    while (prev !== null && (prev.type === 'attribute_item' || prev.type === 'decorator'))
      prev = prev.previousNamedSibling;
    fn.hasDoc =
      prev !== null && COMMENT.has(prev.type) && prev.endPosition.row >= node.startPosition.row - 3;
  }
  if (name && body !== null && BLOCK.has(body.type)) {
    const inner = statementsOf(body).filter((c) => c.type !== 'pass_statement');
    if (!inner.length && !nn(body.namedChildren).some((c) => COMMENT.has(c.type)))
      inc(w.c, 'empty_functions');
  }
  w.fns.push(fn);
  w.fnNestingBase.push(nesting);
  return w.fns.length - 1;
}

function visitIf(w: Walker, node: SyntaxNode): void {
  const condition = node.childForFieldName('condition');
  if (condition !== null) {
    let ops = 0;
    let negated = false;
    const stack = [condition];
    while (stack.length) {
      const current = stack.pop() as SyntaxNode;
      if (!current.isNamed && BOOL_OPS.has(current.type)) ops++;
      else if (current.type === 'not_operator' || (!current.isNamed && current.type === '!'))
        negated = true;
      stack.push(...nn(current.children));
    }
    w.boolOps.push(ops);
    inc(w.c, 'negated_conditions', negated ? 1 : 0);
    if (condition.text.includes('err != nil')) {
      inc(w.c, 'error_checks');
      const consequence = node.childForFieldName('consequence');
      if (consequence !== null) w.errorStatements += Math.max(1, consequence.namedChildCount);
    }
  }
  const consequence = field(node, 'consequence', 'body');
  if (consequence === null) return;
  const body = statementsOf(consequence);
  if (
    body.length === 1 &&
    (EXIT.has(body[0]!.type) ||
      (body[0]!.type === 'expression_statement' &&
        body[0]!.namedChildCount &&
        EXIT.has((body[0]!.namedChildren[0] as SyntaxNode).type)))
  ) {
    inc(w.c, 'guard_clauses');
  }
  const alternative = node.childForFieldName('alternative');
  if (body.length && alternative !== null && EXIT.has(body[body.length - 1]!.type))
    inc(w.c, 'else_after_return');
}

function visitCatch(w: Walker, node: SyntaxNode): void {
  inc(w.c, 'catches');
  let body = node.childForFieldName('body');
  if (body === null) {
    for (const child of nn(node.namedChildren)) if (BLOCK.has(child.type)) body = child;
  }
  const statements = body !== null ? statementsOf(body) : [];
  if (!statements.length || (statements.length === 1 && statements[0]!.type === 'pass_statement')) {
    inc(w.c, 'empty_catches');
  }
  const text = body !== null ? body.text : '';
  if (!SWALLOW.search(text)) inc(w.c, 'swallowing_catches');
  const head = strip(node.text.split(':')[0]!.split('{')[0]!);
  if (node.type === 'except_clause' && (head === 'except' || BROAD.search(head)))
    inc(w.c, 'broad_catches');
}

function visitCall(w: Walker, node: SyntaxNode, fn: Fn | null): void {
  const [name, receiver] = callee(w, node);
  if ((name === 'unwrap' || name === 'expect') && w.lang === 'rust') inc(w.c, 'unwraps');
  const io = IO_NAMES.match(name) || (receiver !== null && IO_RECEIVERS.has(receiver));
  if (io) inc(w.c, 'io_calls');
  const parent = node.parent;
  if (parent === null || !MEMBER.has(parent.type)) w.chains.push(chainLength(w, node));
  if (fn !== null) {
    if (name) {
      fn.callees.add(name);
      if (subtokens(name).length >= 2) fn.namedCalls++;
    }
    if (io) fn.doesIo = true;
    if (receiver !== null && fn.params.has(receiver) && MUTATING_METHODS.has(name))
      fn.mutatesArgs = true;
  }
}

function visitAssign(w: Walker, node: SyntaxNode, fn: Fn | null, fi: number): void {
  const t = node.type;
  const left = field(node, 'left', 'name', 'pattern');
  const right = field(node, 'right', 'value');
  if (left === null) return;
  const ltext = left.text;
  // Thrown-away results: _ = f(), let _ = f(), x, _ := f()
  const rcall =
    right !== null &&
    (CALL.has(right.type) ||
      right.type === 'await_expression' ||
      right.type === 'await' ||
      (right.type === 'expression_list' && nn(right.namedChildren).some((c) => CALL.has(c.type))));
  if (rcall && (ltext === '_' || IGNORED.search(ltext))) inc(w.c, 'ignored_results');
  if (MEMBER.has(left.type) || INDEX.has(left.type)) {
    const root = rootObject(w, left);
    if (fn !== null && root !== null && fn.params.has(root)) fn.mutatesArgs = true;
    if (fn !== null && (root === 'self' || root === 'this')) fn.writesSelf = true;
    return;
  }
  if (
    t === 'augmented_assignment' ||
    t === 'augmented_assignment_expression' ||
    t === 'compound_assignment_expr'
  )
    return;
  declareTargets(w, left, fi >= 0);
  if (right !== null && left.type === 'identifier') {
    const rtype = right.type;
    const isBool =
      rtype === 'true' ||
      rtype === 'false' ||
      rtype === 'comparison_operator' ||
      rtype === 'boolean_operator' ||
      rtype === 'not_operator' ||
      (rtype === 'binary_expression' &&
        nn(right.children).some(
          (c) =>
            !c.isNamed &&
            (COMPARE_OPS.has(c.type) ||
              BOOL_OPS.has(c.type) ||
              ['<', '>', '<=', '>='].includes(c.type)),
        ));
    const parts = subtokens(ltext);
    if (isBool && parts.length && !BOOL_PREFIXES.has(parts[0]!)) inc(w.c, 'bool_names_unclear');
  }
}

function visitBlock(w: Walker, node: SyntaxNode): void {
  let jumped = false;
  for (const child of statementsOf(node)) {
    if (jumped) inc(w.c, 'unreachable_statements');
    if (
      JUMP.has(child.type) ||
      (child.type === 'expression_statement' &&
        child.namedChildCount &&
        JUMP.has((child.namedChildren[0] as SyntaxNode).type))
    ) {
      jumped = true;
    }
  }
}

function withTree<T>(
  parse: Parse,
  language: LanguageName,
  text: string,
  use: (root: SyntaxNode) => T,
  timedOut: T,
): T {
  const tree = parse(language, text);
  if (tree === null) return timedOut;
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete?.();
  }
}

const DOC_PREFIXES = ['/**', '///', '//!', '/*!'];
const SNIPPET_LEAVES = set('identifier string number integer');

function commentFeatures(
  w: Walker,
  lines: string[],
  language: LanguageName,
  codeLines: number,
  parse: Parse,
): Record<string, number> {
  const commentRows = new Set<number>();
  for (const [start, end] of w.comments) for (let r = start; r <= end; r++) commentRows.add(r);
  let firstCodeRow = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (strip(lines[i]!) && !commentRows.has(i)) {
      firstCodeRow = i;
      break;
    }
  }
  let kept = 0;
  let commented = 0;
  let blocks = 0;
  let restating = 0;
  let reasons = 0;
  let todos = 0;
  let directives = 0;
  let short = 0;
  let run = 0;
  let lastCodeRow = -10;
  for (const [start, end, text] of w.comments) {
    if (start < firstCodeRow && LICENSE.search(text)) continue;
    const bodyLines = splitlines(text).map((ln) => rstrip(COMMENT_MARK.sub(ln, '')));
    const body = bodyLines
      .filter((b) => strip(b))
      .map((b) => strip(b))
      .join(' ');
    if (DIRECTIVE.search(body)) {
      directives++;
      continue;
    }
    kept += Math.max(
      1,
      count(bodyLines, (b) => strip(b)),
    );
    if (TODO.search(body)) todos++;
    if (REASON.search(body)) reasons++;
    const isDoc = startsWithAny(text, DOC_PREFIXES);
    let codeHere = 0;
    if (!isDoc) {
      for (const b of bodyLines) {
        const s = strip(b);
        if (!s || !CODE_HINT.search(s) || PROSE_END.search(s)) continue;
        if (BARE_ASSIGN.match(s)) {
          codeHere++;
          continue;
        }
        const parses = withTree(
          parse,
          language,
          s,
          (root) => {
            const named = nn(root.namedChildren).filter((c) => !COMMENT.has(c.type));
            return (
              named.length > 0 &&
              !root.hasError &&
              !(
                named.length === 1 &&
                named[0]!.type === 'expression_statement' &&
                named[0]!.namedChildCount &&
                SNIPPET_LEAVES.has((named[0]!.namedChildren[0] as SyntaxNode).type)
              )
            );
          },
          false,
        );
        if (parses) codeHere++;
      }
    }
    if (codeHere) {
      commented += codeHere;
      run = start <= lastCodeRow + 1 ? run + 1 : 1;
      if (run === 2) blocks++;
      lastCodeRow = end;
      continue;
    }
    const words = WORD.findall(body)
      .filter((x) => !STOP.has(lower(x)))
      .map((x) => rstrip(lower(x), 's'));
    if (!isDoc && words.length >= 1 && words.length <= 8 && end + 1 < lines.length) {
      short++;
      let nxt = '';
      for (let i = end + 1; i < Math.min(lines.length, end + 3); i++) {
        if (strip(lines[i]!)) {
          nxt = lines[i]!;
          break;
        }
      }
      const tokens = new Set<string>();
      for (const name of IDENT_WORD.findall(nxt))
        for (const s of subtokens(name)) tokens.add(rstrip(s, 's'));
      if (words.length && count(words, (x) => tokens.has(x)) / words.length >= 0.5) restating++;
    }
  }
  const totalComments = Math.max(1, w.comments.length - directives);
  const per100 = 100.0 / Math.max(1, codeLines);
  return {
    comment_lines_per_100: kept * per100,
    comments_restating_share: restating / Math.max(1, short),
    comments_reason_share: reasons / totalComments,
    todo_comments: todos,
    directives,
    commented_code_lines: commented,
    commented_code_blocks: blocks,
  };
}

function commentBlocks(w: Walker, lines: string[], codeRows: Set<number>): Record<string, number> {
  let firstCodeRow = lines.length;
  for (const r of codeRows) if (r < firstCodeRow) firstCodeRow = r;
  if (!codeRows.size) firstCodeRow = lines.length;
  const blocks: Comment[][] = [];
  for (const c of w.comments) {
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    const prev = last ? last[last.length - 1] : null;
    if (last && prev && c[0] === prev[1] + 1 && !codeRows.has(c[0]) && !codeRows.has(prev[0]))
      last.push(c);
    else blocks.push([c]);
  }
  let kept = 0;
  let inline = 0;
  let docLines = 0;
  let codeLike = 0;
  let longest = 0;
  let biggestCode = 0;
  const words: number[] = [];
  for (const block of blocks) {
    const start = block[0]![0];
    const end = block[block.length - 1]![1];
    const text = block.map((c) => c[2]).join('\n');
    if (start < firstCodeRow && LICENSE.search(text)) continue;
    const body = splitlines(text)
      .map((ln) => strip(COMMENT_MARK.sub(ln, '')))
      .filter((b) => b);
    if (!body.length || (body.length === 1 && DIRECTIVE.search(body[0]!))) continue;
    kept++;
    if (codeRows.has(start)) inline++;
    if (startsWithAny(block[0]![2], DOC_PREFIXES)) {
      docLines += end - start + 1;
      longest = Math.max(longest, end - start + 1);
      words.push(sum(body.map((b) => splitWs(b).length)));
      continue;
    }
    longest = Math.max(longest, end - start + 1);
    words.push(sum(body.map((b) => splitWs(b).length)));
    const looks = body.map((b) => CODE_LIKE.search(b) && !PROSE.match(b) && !PROSE_END.search(b));
    const nLooks = count(looks, (x) => x);
    const strong = body.length === 1 && looks[0] && CODE_PUNCT.count(body[0]!) >= 3;
    if (strong || (body.length >= 2 && nLooks >= 2 && nLooks / body.length >= 0.6)) {
      codeLike += nLooks;
      biggestCode = Math.max(biggestCode, nLooks);
    }
  }
  return {
    comment_blocks: kept,
    comment_block_lines_max: longest,
    comment_words_mean: words.length ? sum(words) / words.length : 0.0,
    inline_comment_share: kept ? inline / kept : 0.0,
    doc_lines_per_100: (docLines * 100.0) / Math.max(1, codeRows.size),
    commented_code_like_lines: codeLike,
    commented_code_block_max: biggestCode,
  };
}

const PY_IMPORT = pyRe('^[ \\t]*import[ \\t]+([\\w., \\t]+)$', 'M');
const PY_FROM = pyRe('^[ \\t]*from[ \\t]+([\\w.]+)[ \\t]+import[ \\t]+(\\([^)]*\\)|[^\\n]+)', 'M');
const PY_HASH_COMMENT = pyRe('#[^\\n]*');
const JS_IMPORT = pyRe('^[ \\t]*import\\s+(?:type\\s+)?([^\'";]+?)\\s+from\\s+[\'"]', 'M');
const JS_BRACES = pyRe('\\{([^}]*)\\}');
const JS_STAR = pyRe('\\*\\s+as\\s+([\\w$]+)');
const JS_DEFAULT = pyRe('[\\w$]+');
const GO_IMPORT = pyRe('^import\\s+(\\w+\\s+)?"([^"]+)"', 'M');
const GO_BLOCK = pyRe('^import\\s*\\(([^)]*)\\)', 'M');
const GO_SPEC = pyRe('^\\s*(\\w+\\s+|[._]\\s+)?"([^"]+)"', 'M');
const GO_MAJOR = pyRe('v\\d+');
const GO_NAME = pyRe('[A-Za-z_]\\w*');

/** Names a file imports and could use, skipping side-effect imports and wildcards. */
function importedNames(content: string, language: LanguageName): string[] {
  const names: string[] = [];
  if (language === 'python') {
    for (const [spec = ''] of PY_IMPORT.findallGroups(content)) {
      for (const part of spec.split(',')) {
        const bits = splitWs(part);
        if (bits.length)
          names.push(bits.includes('as') ? bits[bits.length - 1]! : bits[0]!.split('.')[0]!);
      }
    }
    for (const [module, what = ''] of PY_FROM.findallGroups(content)) {
      if (module === '__future__') continue;
      for (const part of strip(PY_HASH_COMMENT.sub(what, ''), '()\\ \n').split(',')) {
        const bits = splitWs(part);
        if (bits.length && bits[0] !== '*') names.push(bits[bits.length - 1]!);
      }
    }
  } else if (language === 'javascript' || language === 'typescript') {
    for (const [found = ''] of JS_IMPORT.findallGroups(content)) {
      let spec = found;
      const inner = JS_BRACES.exec(spec);
      if (inner) {
        for (const part of inner.groups[1]!.split(',')) {
          const bits = splitWs(part.replaceAll('type ', ''));
          if (bits.length) names.push(bits[bits.length - 1]!);
        }
        spec = spec.slice(0, inner.index) + spec.slice(inner.index + inner.length);
      }
      const star = JS_STAR.exec(spec);
      if (star) {
        names.push(star.groups[1]!);
        spec = spec.replaceAll(star.groups[0]!, '');
      }
      const def = strip(spec, ' ,');
      if (JS_DEFAULT.fullmatch(def)) names.push(def);
    }
  } else if (language === 'go') {
    const specs = GO_IMPORT.findallGroups(content);
    for (const block of GO_BLOCK.findall(content)) specs.push(...GO_SPEC.findallGroups(block));
    for (const [rawAlias = '', path = ''] of specs) {
      const alias = strip(rawAlias);
      if (alias === '_' || alias === '.') continue;
      const segments = path.split('/');
      let last = segments[segments.length - 1]!;
      if (GO_MAJOR.fullmatch(last) && segments.length > 1) last = segments[segments.length - 2]!;
      const name = alias || last;
      if (GO_NAME.fullmatch(name)) names.push(name);
    }
  }
  return names;
}

const PRIVATE_TYPE_NODES = new Set([
  ...TYPE_DECLS,
  'type_spec',
  'class_definition',
  'class_declaration',
  'class',
]);

/** Names of top-level types that nothing outside this file can use. */
function privateTypes(root: SyntaxNode, language: LanguageName): string[] {
  const names: string[] = [];
  for (const node of nn(root.namedChildren)) {
    if (node.type === 'export_statement') continue;
    const specs =
      node.type === 'type_declaration'
        ? nn(node.namedChildren).filter((c) => c.type === 'type_spec')
        : [node];
    for (const spec of specs) {
      if (!PRIVATE_TYPE_NODES.has(spec.type)) continue;
      const nameNode = spec.childForFieldName('name');
      if (nameNode === null) continue;
      const name = nameNode.text;
      if (
        (language === 'rust' && !node.text.startsWith('pub')) ||
        (language === 'go' && isLower(firstChar(name))) ||
        (language === 'python' && name.startsWith('_') && !name.startsWith('__')) ||
        language === 'javascript' ||
        language === 'typescript'
      ) {
        names.push(name);
      }
    }
  }
  return names;
}

function extraFeatures(
  feats: Record<string, number>,
  w: Walker,
  root: SyntaxNode,
  content: string,
  lines: string[],
  code: string[],
  realFns: Fn[],
  commentRows: Set<number>,
  language: LanguageName,
): void {
  const codeLines = Math.max(1, code.length);
  feats.total_lines = lines.length;
  feats.blank_line_share = count(lines, (ln) => !strip(ln)) / Math.max(1, lines.length);
  feats.line_len_mean = sum(code.map((ln) => plen(strip(ln)))) / codeLines;
  const indents = code.map((ln) => {
    const k = ln.length - lstrip(ln).length;
    return k + 3 * (ln.slice(0, k).split('\t').length - 1);
  });
  const positive = indents.filter((i) => i > 0);
  const step = positive.length ? Math.min(...positive) : 0;
  feats.indent_depth_max = step ? Math.min(30, Math.floor(max(indents) / step)) : 0.0;
  const imported = importedNames(content, language);
  feats.imports = imported.length;
  const tokens = new Map<string, number>();
  for (const tok of TOKEN.findall(content)) inc(tokens, tok);
  // A file that is mostly imports re-exports them (__init__.py, index.ts); JSX needs React in scope.
  if (imported.length < 0.5 * codeLines) {
    feats.unused_imports = count(
      [...new Set(imported)].filter((n) => n !== 'React'),
      (n) => get(tokens, n) <= 1,
    );
  }
  let typeDecls = 0;
  for (let node of nn(root.namedChildren)) {
    if (node.type === 'export_statement' && node.namedChildCount)
      node = node.namedChildren[node.namedChildCount - 1] as SyntaxNode;
    if (TYPE_DECLS.has(node.type)) typeDecls++;
  }
  feats.type_declarations = typeDecls;
  feats.unused_private_types = count(
    [...new Set(privateTypes(root, language))],
    (n) => get(tokens, n) <= 1,
  );
  feats.empty_functions = get(w.c, 'empty_functions');
  feats.is_test_file = feats.test_functions! > 0 || TEST_IMPORT.search(content) ? 1 : 0;
  feats.sql_strings = count(w.strings, (s) => SQL_START.match(strip(s, '"\'`bfrRu#')));

  feats.fns_per_100 = (realFns.length * 100.0) / codeLines;
  if (realFns.length) {
    const n = realFns.length;
    const lengths = realFns.map((f) => f.lines).sort((a, b) => a - b);
    feats.fn_lines_mean = sum(lengths) / n;
    feats.fn_lines_median = lengths[Math.floor(n / 2)]!;
    feats.fn_statements_mean = sum(realFns.map((f) => f.statements)) / n;
    feats.fns_over_80_lines = count(lengths, (x) => x > 80);
    feats.fn_params_mean = sum(realFns.map((f) => f.params.size)) / n;
    feats.fns_complexity_over_10 = count(realFns, (f) => f.complexity > 10);
    feats.fns_nesting_over_3 = count(realFns, (f) => f.nesting > 3);
    feats.returns_max = max(realFns.map((f) => f.returns));
    feats.fn_names_generic = count(
      realFns,
      (f) => f.name && GENERIC_FN.has(rstrip(lower(f.name), '0123456789_')),
    );
    const params = realFns
      .flatMap((f) => [...f.params])
      .filter((p) => !['self', 'cls', 'this', '_'].includes(p));
    if (params.length)
      feats.param_single_char_share = count(params, (p) => plen(p) === 1) / params.length;
    const uncommented = (f: Fn): boolean => {
      if (f.hasDoc) return false;
      for (let r = f.startRow + 1; r <= f.endRow; r++) if (commentRows.has(r)) return false;
      return true;
    };
    feats.long_fns_uncommented = count(realFns, (f) => f.lines >= 30 && uncommented(f));
    feats.complex_fns_uncommented = count(realFns, (f) => f.complexity >= 8 && uncommented(f));
  }

  const declared = w.declared.filter((d) => d);
  if (declared.length) {
    const lengths = declared.map(plen).sort((a, b) => a - b);
    feats.name_len_median = lengths[Math.floor(lengths.length / 2)]!;
    feats.name_len_max = lengths[lengths.length - 1]!;
    feats.names_short_outside_loops = count(declared, (d) => plen(d) <= 2 && !LOOP_NAMES.has(d));
    const snake = count(declared, (d) => strip(d, '_').includes('_') && lower(d) === d);
    const camel = count(declared, (d) => CAMEL.search(d) && isLower(firstChar(d)));
    if (snake + camel) feats.name_style_mixed = Math.min(snake, camel) / (snake + camel);
  }
}

const UNDEFINED_WHEN_EMPTY: Record<'functions' | 'names' | 'comments', string[]> = {
  functions: [
    'fn_lines_max',
    'fn_lines_p90',
    'fn_statements_max',
    'fn_long_share',
    'fn_params_max',
    'fn_callees_max',
    'complexity_max',
    'complexity_mean',
    'nesting_max',
    'fn_paragraphs_max',
    'doc_coverage',
    'fn_lines_mean',
    'fn_lines_median',
    'fn_statements_mean',
    'fn_params_mean',
    'returns_max',
  ],
  names: [
    'name_len_mean',
    'name_single_char_share',
    'name_numbered_share',
    'name_generic_share',
    'name_abbrev_share',
    'name_words_mean',
    'name_len_median',
    'name_len_max',
  ],
  comments: [
    'comments_restating_share',
    'comments_reason_share',
    'comment_words_mean',
    'inline_comment_share',
  ],
};

const COUNTED = [
  'else_after_return',
  'negated_conditions',
  'guard_clauses',
  'jumps_in_loops',
  'nested_ternaries',
  'magic_strings_compared',
  'named_constants',
  'bool_names_unclear',
  'global_writes',
  'catches',
  'empty_catches',
  'swallowing_catches',
  'broad_catches',
  'ignored_results',
  'sentinel_returns',
  'unreachable_statements',
];

/** Features of one file, keyed by FEATURE_NAMES (`features_code.extract()`). */
export function extract(
  content: string,
  language: LanguageName,
  parse: Parse,
): Record<string, number> {
  const feats: Record<string, number> = {};
  for (const name of FEATURE_NAMES) feats[name] = 0.0;
  if (!LANGUAGES.includes(language)) return feats;
  const trees: { delete?(): void }[] = [];
  try {
    const first = parse(language, content);
    if (first) trees.push(first);
    let root: SyntaxNode | null = first ? first.rootNode : null;
    if (language === 'javascript' && (root === null || root.hasError)) {
      // Flow-annotated JavaScript (React, Prettier) is closer to TypeScript than to plain JS.
      const alt = parse('typescript', content);
      if (alt) {
        trees.push(alt);
        if (root === null || errorCount(alt.rootNode) < errorCount(root)) root = alt.rootNode;
      }
    }
    if (root === null) return feats; // no tree within the time limit: as for a language without a grammar
    const w = newWalker(language);
    walk(w, root);
    const lines = splitlines(content);
    if (!lines.length) lines.push('');
    const commentRows = new Set<number>();
    for (const [start, end] of w.comments) for (let r = start; r <= end; r++) commentRows.add(r);
    const code = lines.filter((ln, i) => strip(ln) && !commentRows.has(i));
    const codeLines = Math.max(1, code.length);
    const per100 = 100.0 / codeLines;
    const fns = w.fns;
    const realFns = fns.filter((f) => f.lines > 1 || f.name);

    feats.parsed = 1.0;
    feats.parse_error_ratio = errorCount(root) / Math.max(1, w.nodes);
    feats.code_lines = codeLines;
    feats.test_functions = TEST_FN.count(content);

    feats.functions = fns.length;
    if (realFns.length) {
      const lengths = realFns.map((f) => f.lines).sort((a, b) => a - b);
      feats.fn_lines_max = lengths[lengths.length - 1]!;
      feats.fn_lines_p90 = lengths[Math.min(lengths.length - 1, Math.trunc(0.9 * lengths.length))]!;
      feats.fn_statements_max = max(realFns.map((f) => f.statements));
      feats.fn_long_share = count(realFns, (f) => f.lines > 40) / realFns.length;
      feats.fn_params_max = max(realFns.map((f) => f.params.size));
      feats.fn_callees_max = max(realFns.map((f) => f.callees.size));
      feats.complexity_max = max(realFns.map((f) => f.complexity));
      feats.complexity_mean = sum(realFns.map((f) => f.complexity)) / realFns.length;
      feats.nesting_max = max(realFns.map((f) => f.nesting));
      const big = realFns.filter((f) => f.statements >= 10);
      if (big.length)
        feats.fn_mixed_level_share =
          count(big, (f) => f.namedCalls >= 2 && f.lowLevel >= 2) / big.length;
      const paragraphs = realFns.map((f) => {
        const body = lines.slice(f.startRow, f.endRow + 1);
        let n = 1;
        for (let i = 0; i + 1 < body.length; i++) if (!strip(body[i]!) && strip(body[i + 1]!)) n++;
        return n;
      });
      feats.fn_paragraphs_max = max(paragraphs);
      feats.doc_coverage = count(realFns, (f) => f.hasDoc) / realFns.length;
      feats.fns_mutating_args = count(realFns, (f) => f.mutatesArgs);
      const methods = realFns.filter((f) => f.isMethod && !startsWithAny(f.name, MUTATOR_PREFIXES));
      if (methods.length)
        feats.fns_writing_self_share = count(methods, (f) => f.writesSelf) / methods.length;
      feats.getters_with_effects = count(realFns, (f) => {
        const parts = subtokens(f.name);
        return (
          parts.length > 0 &&
          QUERY_PREFIXES.has(parts[0]!) &&
          (f.writesSelf || f.mutatesArgs || f.doesIo)
        );
      });
    }
    feats.low_level_ops_per_100 = get(w.c, 'low_level_ops') * per100;
    feats.deep_nesting_lines_share = w.deepStatements / Math.max(1, w.statements);
    feats.branches_per_100 = get(w.c, 'branches') * per100;
    for (const name of COUNTED) feats[name] = get(w.c, name);
    feats.expr_size_max = max(w.exprSizes);
    feats.big_exprs_per_100 = count(w.exprSizes, (s) => s >= 30) * per100;
    feats.bool_ops_max = max(w.boolOps);
    feats.call_chain_max = max(w.chains);
    feats.long_lines_share = count(code, (ln) => plen(ln) > 100) / codeLines;
    feats.magic_numbers_per_100 = sum(w.magic.values()) * per100;
    feats.magic_numbers_distinct = w.magic.size;
    feats.magic_numbers_repeated = count([...w.magic.values()], (c) => c > 1);

    const declared = w.declared.filter((d) => d);
    if (declared.length) {
      const n = declared.length;
      const parts = declared.flatMap((d) => subtokens(d));
      feats.names_declared = n;
      feats.name_len_mean = sum(declared.map(plen)) / n;
      feats.name_single_char_share =
        count(declared, (d) => plen(d) === 1 && !LOOP_NAMES.has(d)) / n;
      feats.name_numbered_share = count(declared, (d) => NUMBERED.search(d)) / n;
      feats.name_generic_share = count(declared, (d) => GENERIC.has(lower(d))) / n;
      feats.name_abbrev_share =
        count(parts, (p) => plen(p) >= 3 && !VOWEL.search(p)) / Math.max(1, parts.length);
      feats.name_words_mean = parts.length / n;
    }
    const vocabulary = new Set<string>();
    for (const name of w.idents.keys())
      for (const s of subtokens(name)) if (plen(s) > 1) vocabulary.add(s);
    feats.name_vocabulary = vocabulary.size;
    feats.io_calls_per_100 = get(w.c, 'io_calls') * per100;

    Object.assign(feats, commentFeatures(w, lines, language, codeLines, parse));
    const codeRows = new Set<number>();
    lines.forEach((ln, i) => {
      if (strip(ln) && !commentRows.has(i)) codeRows.add(i);
    });
    // A row with code and a trailing comment is a code row too.
    for (const [start] of w.comments) {
      const line = lines[start] ?? '';
      if (strip(line) && !startsWithAny(lstrip(line), ['//', '#', '/*', '*'])) codeRows.add(start);
    }
    Object.assign(feats, commentBlocks(w, lines, codeRows));
    extraFeatures(feats, w, root, content, lines, code, realFns, commentRows, language);
    feats.unused_private_functions = count(
      [...new Set(w.privateFns)],
      (n) => get(w.idents, n) <= 1,
    );
    feats.unused_variables = count(
      [...new Set(w.locals)].filter((n) => !n.startsWith('_') && plen(n) > 1),
      (n) => get(w.idents, n) <= 1,
    );
    feats.unwraps_per_100 = get(w.c, 'unwraps') * per100;
    feats.error_checks_per_100 = get(w.c, 'error_checks') * per100;
    feats.error_statement_share = Math.min(1.0, w.errorStatements / Math.max(1, w.statements));

    const low = lower(content);
    for (const [name, pattern, triggers] of LEXICAL) {
      if (triggers.some((t) => low.includes(t))) feats[name] = pattern.count(content);
    }
    let secrets = PRIVATE_KEY.count(content);
    if (['password', 'passwd', 'secret', 'key', 'token'].some((t) => low.includes(t)))
      secrets += SECRET_NAME.count(content);
    for (const literal of w.strings) {
      const body = strip(literal, '"\'`bfrRu#');
      if (plen(body) >= 20 && !body.includes(' ') && !body.includes('/') && entropy(body) > 4.2)
        secrets++;
    }
    feats.secret_like_literals = secrets;
    // A mean or share over an empty set is undefined, not zero: "no names" must not look like "short names".
    const counts = {
      functions: realFns.length,
      names: declared.length,
      comments: w.comments.length,
    };
    for (const group of ['functions', 'names', 'comments'] as const) {
      if (!counts[group]) for (const name of UNDEFINED_WHEN_EMPTY[group]) feats[name] = Number.NaN;
    }
    return feats;
  } finally {
    for (const t of trees) t.delete?.();
  }
}

const TS_HINT = pyRe(
  '^\\s*(export\\s+)?(interface|type|enum|declare|namespace|abstract class)\\s+\\w|\\bimport type\\b|' +
    '\\)\\s*:\\s*[\\w<\\[{|]+\\s*(=>|\\{)|\\b(private|public|protected|readonly)\\s+\\w+\\s*[:(]|' +
    ':\\s*(string|number|boolean|unknown|any|void|never)\\b|\\bas const\\b',
  'M',
);
const GO_PACKAGE = pyRe('^package\\s+\\w+\\s*$', 'M');
const LANGUAGE_SIGNS: [LanguageName, PyRe][] = [
  [
    'rust',
    pyRe(
      '^\\s*(pub(\\([\\w:]+\\))?\\s+)?(fn|struct|enum|impl|trait|mod)\\s|^\\s*use\\s+[\\w:]+::|' +
        '\\blet\\s+mut\\b|#!?\\[\\w+|&(mut\\s+)?self\\b|\\b\\w+!\\(|\\b(Option|Result|Vec|Box)<|::new\\(',
      'M',
    ),
  ],
  [
    'python',
    pyRe(
      '^\\s*(async\\s+)?def\\s+\\w+\\(|^\\s*class\\s+\\w+[(:]|^\\s*from\\s+[\\w.]+\\s+import\\s|' +
        '^\\s*import\\s+[\\w.]+\\s*$|^\\s*(elif|except|with)\\b|\\bself\\.\\w+|\\b(None|True|False)\\b|' +
        '^\\s*@\\w+',
      'M',
    ),
  ],
  [
    'javascript',
    pyRe(
      '^\\s*(export\\s+)?(const|let|var|function|class)\\s|=>|\\brequire\\(|' +
        '^\\s*import\\s.+\\sfrom\\s|\\bthis\\.\\w+|[!=]==|\\bmodule\\.exports\\b|\\bundefined\\b',
      'M',
    ),
  ],
];
const BRACE_END = pyRe('[;{}]\\s*$', 'M');

/** The language of a file from its content alone (`features_code.detect_language()`). */
export function detectLanguage(content: string): LanguageName {
  const head = pslice(content, 20_000);
  if (GO_PACKAGE.search(head)) return 'go';
  let best: LanguageName = LANGUAGE_SIGNS[0]![0];
  let bestScore = -1;
  for (const [lang, pattern] of LANGUAGE_SIGNS) {
    const score = pattern.count(head);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  if (bestScore === 0) best = BRACE_END.search(head) ? 'javascript' : 'python';
  if (best === 'javascript' || best === 'typescript')
    best = TS_HINT.search(head) ? 'typescript' : 'javascript';
  return best;
}

/** Student input: the code features and a one-hot of LANGUAGES, keyed by VECTOR_NAMES (`features_code.vector()`). */
export function vector(content: string, parse: Parse, language?: string): Record<string, number> {
  const lang =
    language && (LANGUAGES as readonly string[]).includes(language)
      ? (language as LanguageName)
      : detectLanguage(content);
  const feats = extract(content, lang, parse);
  const out: Record<string, number> = {};
  for (const name of FEATURE_NAMES) out[`code__${name}`] = feats[name]!;
  for (const l of LANGUAGES) out[`lang__${l}`] = l === lang ? 1.0 : 0.0;
  return out;
}
