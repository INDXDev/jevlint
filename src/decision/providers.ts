/** Creates the configured decision model. */
import { createGateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { createTypeSafeAi, type TypeSafeAiProvider } from '@ai-sdk/typesafe-ai';
import { type Config, UserError } from '../config.ts';
import { getApiKey } from '../credentials.ts';
import type { ProviderName } from '../types.ts';

type DecisionModel = ReturnType<TypeSafeAiProvider['decisionModel']>;
type ProviderConfig = Config['provider'];
type Build = (apiKey: string, modelId: string, provider: ProviderConfig) => DecisionModel;

/** A ready model, with the names that identify it in reports and cache keys. */
export interface ResolvedModel {
  model: DecisionModel;
  provider: ProviderName;
  modelId: string;
  /** The custom endpoint, whose same-named model may be a different one. */
  endpoint?: string;
}

/** The names that identify a model, which need no API key. */
export type ModelTarget = Pick<ResolvedModel, 'provider' | 'modelId' | 'endpoint'>;

const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  typesafe: 'jev-latest',
  openai: 'gpt-6-luna',
  gateway: 'typesafe-ai/jev',
  cloudflare: 'clef',
};

/** Cloudflare speaks the Jev protocol at a fixed URL and wraps responses in `{ result }`. */
function cloudflareFetch(accountId: string): typeof fetch {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/clef`;
  return async (_input, init) => {
    const response = await fetch(url, init);
    if (!response.ok) return response;
    const { result } = (await response.json()) as { result: unknown };
    return Response.json(result);
  };
}

const cloudflare: Build = (apiKey, modelId, { account_id }) => {
  const accountId = account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new UserError(
      'Provider "cloudflare" needs provider.account_id or CLOUDFLARE_ACCOUNT_ID.',
    );
  }
  return createTypeSafeAi({ apiKey, fetch: cloudflareFetch(accountId) }).decisionModel(modelId);
};

const jevEndpoint: Build = (apiKey, modelId, { name, base_url }) => {
  if (!base_url) throw new UserError(`Provider "${name}" needs provider.base_url.`);
  return createTypeSafeAi({ apiKey, baseURL: base_url }).decisionModel(modelId);
};

const BUILDERS: Record<ProviderName, Build> = {
  typesafe: (apiKey, modelId) => createTypeSafeAi({ apiKey }).decisionModel(modelId),
  openai: (apiKey, modelId) => createOpenAI({ apiKey }).decisionModel(modelId),
  gateway: (apiKey, modelId) => createGateway({ apiKey }).decisionModel(modelId),
  cloudflare,
  microsoft: jevEndpoint,
  compatible: jevEndpoint,
};

/**
 * Picks the configured provider, or else the first that works from a key alone.
 * A fallback gets no configured model or endpoint: those belong to the configured provider.
 */
async function keyedProvider(
  configured: ProviderConfig,
): Promise<{ provider: ProviderConfig; apiKey: string } | null> {
  const apiKey = await getApiKey(configured.name);
  if (apiKey) return { provider: configured, apiKey };
  for (const name of Object.keys(DEFAULT_MODELS) as ProviderName[]) {
    if (name === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) continue;
    const apiKey = await getApiKey(name);
    if (apiKey) return { provider: { name }, apiKey };
  }
  return null;
}

/** Names the configured model, for estimating a run that has no key yet. */
export function configuredTarget({ provider }: Config): ModelTarget {
  const { name, model, base_url: endpoint } = provider;
  return { provider: name, modelId: model ?? DEFAULT_MODELS[name] ?? '', endpoint };
}

/** Builds the model from config. Returns null with no usable key, so a run can use the AST alone. */
export async function createDecisionModel(config: Config): Promise<ResolvedModel | null> {
  const keyed = await keyedProvider(config.provider);
  if (!keyed) return null;
  const { provider, apiKey } = keyed;
  const modelId = provider.model ?? DEFAULT_MODELS[provider.name];
  if (!modelId) throw new UserError(`Provider "${provider.name}" needs provider.model.`);
  const model = BUILDERS[provider.name](apiKey, modelId, provider);
  return { model, provider: provider.name, modelId, endpoint: provider.base_url };
}
