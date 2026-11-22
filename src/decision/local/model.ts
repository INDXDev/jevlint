/**
 * The built-in model: gradient-boosted trees over code features and identifier words, read from
 * `models/model.json` (questions and layout) and `models/model.bin` (the numbers).
 */
import { readFile } from 'node:fs/promises';
import { FEATURE_VERSION, type Parse, vector } from './features.ts';

interface BufferRef {
  dtype: 'f64' | 'f32' | 'i32';
  offset: number;
  length: number;
}

/** A question the model was trained on, with its trees. */
interface TrainedQuestion {
  /** `noul` is the wire name of a boolean question. */
  type: 'noul' | 'score';
  instructions: string;
  criteria?: string[];
  output: 'sigmoid' | 'identity';
  /** Multiplies the trees' output: the number of levels less one, or 1 for a probability. */
  scale: number;
  trees: { roots: BufferRef; nodes: BufferRef; thresholds: BufferRef; leaves: BufferRef };
}

/** The contents of `model.json`. */
export interface ModelMeta {
  schema: 'jevlint.local-model/v1';
  name: string;
  version: string;
  /** The model that labelled the training files. */
  teacher: string;
  feature_version: number;
  feature_names: string[];
  words: {
    n_features: number;
    questions: string[];
    intercept: number[];
    idf: BufferRef;
    /** n_features rows of one coefficient per question. */
    coef: BufferRef;
  };
  questions: Record<string, TrainedQuestion>;
}

/** A question as a decision request states it. */
export interface AskedQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

/** Predicts a value per question from a file's code features. */
type Booster = (x: Float64Array) => number;

/** A loaded model. */
export interface LocalModel {
  meta: ModelMeta;
  /** The trained question with the same wording, or undefined if the model cannot answer it. */
  match: (question: AskedQuestion) => string | undefined;
  /**
   * The teacher's expected answer to each trained question about a file: P(true) for a boolean
   * question, and the expected level from 0 for a score question.
   */
  values: (text: string, ids: string[], parse: Parse) => Record<string, number>;
}

// LightGBM's kZeroThreshold, 1e-35f widened to a double.
const ZERO = 1.0000000180025095e-35;
const DEFAULT_LEFT = 1;
const MISSING_ZERO = 1;
const MISSING_NAN = 2;

/** LightGBM's tree walk, including how it routes missing values. A negative child `c` is leaf `~c`. */
function booster(
  roots: Int32Array,
  nodes: Int32Array,
  thresholds: Float64Array,
  leaves: Float64Array,
  sigmoid: boolean,
): Booster {
  return (x) => {
    let sum = 0;
    for (const root of roots) {
      let node = root;
      while (node >= 0) {
        // Each node is four numbers: feature, flags (bit 0 default left, bits 1-2 missing type),
        // left child and right child.
        const at = node * 4;
        const flags = nodes[at + 1]!;
        const missing = flags >> 1;
        let v = x[nodes[at]!]!;
        if (Number.isNaN(v) && missing !== MISSING_NAN) v = 0;
        const isMissing =
          (missing === MISSING_ZERO && v >= -ZERO && v <= ZERO) ||
          (missing === MISSING_NAN && Number.isNaN(v));
        const left = isMissing ? flags & DEFAULT_LEFT : v <= thresholds[node]!;
        node = nodes[at + (left ? 2 : 3)]!;
      }
      sum += leaves[~node]!;
    }
    return sigmoid ? 1 / (1 + Math.exp(-sum)) : sum;
  };
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g;

/** Identifier words, lowercased and in order: `parseHTTPRequest` gives parse, http, request. */
export function identifierWords(text: string): string[] {
  return (text.match(IDENTIFIER) ?? []).flatMap((identifier) =>
    (identifier.match(WORD) ?? []).map((word) => word.toLowerCase()),
  );
}

/** MurmurHash3 x86 32-bit with seed 0, signed. Tokens are ASCII, so code units are bytes. */
export function murmur3(key: string): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const mix = (k: number) => Math.imul(rotate(Math.imul(k, c1), 15), c2);
  const rotate = (x: number, by: number) => (x << by) | (x >>> (32 - by));
  const n = key.length;
  const blocks = n & ~3;
  let h = 0;
  for (let i = 0; i < blocks; i += 4) {
    const k =
      key.charCodeAt(i) |
      (key.charCodeAt(i + 1) << 8) |
      (key.charCodeAt(i + 2) << 16) |
      (key.charCodeAt(i + 3) << 24);
    h = (Math.imul(rotate(h ^ mix(k), 13), 5) + 0xe6546b64) | 0;
  }
  let tail = 0;
  for (let i = (n & 3) - 1; i >= 0; i--) tail |= key.charCodeAt(blocks + i) << (8 * i);
  if (n & 3) h ^= mix(tail);
  h ^= n;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** The column scikit-learn's HashingVectorizer gives a token. */
function bucket(token: string, n: number): number {
  const h = murmur3(token);
  return h === -2147483648 ? (2147483647 - (n - 1)) % n : Math.abs(h) % n;
}

/** Hashed counts of word unigrams and bigrams. One-letter words are dropped, as in training. */
export function hashedCounts(text: string, columns: number): Map<number, number> {
  const words = identifierWords(text).filter((word) => word.length >= 2);
  const counts = new Map<number, number>();
  const add = (token: string) => {
    const column = bucket(token, columns);
    counts.set(column, (counts.get(column) ?? 0) + 1);
  };
  // Unigrams before bigrams, as in training: the order of the sums below depends on it.
  for (const word of words) add(word);
  for (let i = 1; i < words.length; i++) add(`${words[i - 1]} ${words[i]}`);
  return counts;
}

/**
 * One score per word-model question: sublinear TF-IDF over the hashed words, L2-normalised, through
 * a linear model. The trees take these scores as extra features.
 */
function wordScores(
  { n_features: columns, questions, intercept }: ModelMeta['words'],
  idf: Float32Array,
  coef: Float32Array,
  text: string,
): Float64Array {
  const out = Float64Array.from(intercept);
  const weights = [...hashedCounts(text, columns)].map(
    ([column, count]) => [column, (Math.log(count) + 1) * idf[column]!] as const,
  );
  const norm = Math.sqrt(weights.reduce((sum, [, w]) => sum + w * w, 0));
  if (norm === 0) return out;
  for (const [column, w] of weights) {
    for (let q = 0; q < questions.length; q++) {
      out[q]! += (w / norm) * coef[column * questions.length + q]!;
    }
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A question's identity is its wording, so a renamed question still matches. */
function wording(type: string, instructions: unknown, criteria: unknown): string {
  const levels = isRecord(criteria) ? Object.values(criteria) : (criteria ?? null);
  return JSON.stringify([type === 'boolean' ? 'noul' : type, instructions, levels]);
}

/** Builds a model from `model.json` and `model.bin`. */
export function createLocalModel(meta: ModelMeta, bin: Uint8Array): LocalModel {
  if (meta.schema !== 'jevlint.local-model/v1') {
    throw new Error(`Unknown model schema ${meta.schema}`);
  }
  if (meta.feature_version !== FEATURE_VERSION) {
    throw new Error(
      `The model needs code features v${meta.feature_version}, but features.ts computes v${FEATURE_VERSION}`,
    );
  }
  // Typed arrays need aligned offsets, which a pooled Buffer may not start at.
  const bytes = bin.byteOffset % 8 === 0 ? bin : bin.slice();
  const view = ({ dtype, offset, length }: BufferRef) => {
    const Type = dtype === 'f64' ? Float64Array : dtype === 'f32' ? Float32Array : Int32Array;
    return new Type(bytes.buffer as ArrayBuffer, bytes.byteOffset + offset, length);
  };
  const idf = view(meta.words.idf) as Float32Array;
  const coef = view(meta.words.coef) as Float32Array;
  const boosters = new Map<string, Booster>();
  const byWording = new Map<string, string>();
  for (const [id, question] of Object.entries(meta.questions)) {
    const { roots, nodes, thresholds, leaves } = question.trees;
    boosters.set(
      id,
      booster(
        view(roots) as Int32Array,
        view(nodes) as Int32Array,
        view(thresholds) as Float64Array,
        view(leaves) as Float64Array,
        question.output === 'sigmoid',
      ),
    );
    byWording.set(wording(question.type, question.instructions, question.criteria), id);
  }
  return {
    meta,
    match: ({ type, instructions, criteria }) =>
      byWording.get(wording(type, instructions, criteria)),
    values: (text, ids, parse) => {
      const named = vector(text, parse);
      const x = new Float64Array(meta.feature_names.length + meta.words.questions.length);
      meta.feature_names.forEach((name, i) => {
        x[i] = named[name] ?? Number.NaN;
      });
      x.set(wordScores(meta.words, idf, coef, text), meta.feature_names.length);
      return Object.fromEntries(
        ids.map((id) => [id, boosters.get(id)!(x) * meta.questions[id]!.scale]),
      );
    },
  };
}

/** Reads the model from a directory holding `model.json` and `model.bin`. */
export async function loadLocalModel(dir: string): Promise<LocalModel> {
  const [json, bin] = await Promise.all([
    readFile(`${dir}/model.json`, 'utf8'),
    readFile(`${dir}/model.bin`),
  ]);
  return createLocalModel(JSON.parse(json) as ModelMeta, bin);
}
