/** Validated native model configuration. Tariffs remain authenticated by the
 * existing manifest and ControlClient; this module does not own financial state. */
import type { Mode, Quote, Tariff } from './control.ts';
import { jcsBytes, sha256Hex } from './trust.ts';

export type DaemonApi = 'chat' | 'responses' | 'messages' | 'count_tokens';
export interface DaemonModelPolicy {
  id: string;
  provider: Quote['body']['provider'];
  apis: readonly DaemonApi[];
}
export interface DaemonModel extends DaemonModelPolicy { tariff: Tariff }
export interface DaemonModelSource extends DaemonModelPolicy { tariff: string }
export const daemonApiPaths: Record<DaemonApi, string> = {
  chat: '/v1/chat/completions', responses: '/v1/responses',
  messages: '/v1/messages', count_tokens: '/v1/messages/count_tokens',
};

export function supportedDaemonApis(mode: Mode, provider: Quote['body']['provider']): DaemonApi[] {
  if (mode === 'proxy') {
    if (provider === 'openai') return ['chat', 'responses'];
    if (provider === 'openrouter') return ['chat'];
    if (provider === 'anthropic') return ['messages', 'count_tokens'];
  } else if (mode === 'direct_oa' && provider === 'oa') return ['chat', 'responses'];
  else if (mode === 'direct_openrouter' && provider === 'openrouter') return ['chat'];
  throw new Error('model provider does not match explicit mode');
}

export function validateDaemonModelPolicy(mode: Mode, model: DaemonModelPolicy): void {
  if (!model || typeof model.id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(model.id) || model.id === '*'
    || !Array.isArray(model.apis) || !model.apis.length || new Set(model.apis).size !== model.apis.length
    || model.apis.some(api => !supportedDaemonApis(mode, model.provider).includes(api))) {
    throw new Error('unique supported APIs and a concrete model ID are required');
  }
}

/** Legacy models:string[] + tariff:file is supported only when that tariff
 * actually covers every listed ID. New entries supply their own tariff file. */
export async function loadDaemonModels(config: {
  mode: Mode; models: readonly (string | DaemonModelSource)[]; tariff?: string;
}, pinnedTariffHashes: readonly string[], readTariff: (path: string) => Promise<Tariff>): Promise<DaemonModel[]> {
  const input = structuredClone(config), pins = [...pinnedTariffHashes];
  if (!Array.isArray(input.models) || !input.models.length) throw new Error('configured models required');
  const legacy = input.models.every(model => typeof model === 'string');
  if (!legacy && (input.tariff !== undefined || input.models.some(model => typeof model === 'string'))) {
    throw new Error('do not mix legacy and per-model tariff configuration');
  }
  if (legacy && (typeof input.tariff !== 'string' || !input.tariff)) throw new Error('legacy tariff file required');
  const shared = legacy ? structuredClone(await readTariff(input.tariff!)) : undefined;
  const models: DaemonModel[] = [];
  for (const source of input.models) {
    let model: DaemonModel;
    if (typeof source === 'string') {
      const tariff = structuredClone(shared!);
      const provider = tariff.provider as Quote['body']['provider'];
      model = { id: source, provider, apis: supportedDaemonApis(input.mode, provider), tariff };
    } else {
      if (!source || typeof source.tariff !== 'string' || !source.tariff
        || Object.keys(source).sort().join(',') !== 'apis,id,provider,tariff') throw new Error('complete per-model configuration required');
      model = { id: source.id, provider: source.provider, apis: [...source.apis], tariff: structuredClone(await readTariff(source.tariff)) };
    }
    validateDaemonModelPolicy(input.mode, model);
    const { tariff_hash: hash, ...body } = model.tariff;
    if (!pins.includes(hash) || await sha256Hex(jcsBytes(body)) !== hash) throw new Error('model tariff is not pinned by this deployment');
    if (model.tariff.provider !== model.provider || model.tariff.model !== (input.mode === 'proxy' ? model.id : '*')
      || model.tariff.pricing_basis !== (input.mode === 'proxy' ? 'fixed_usage_rates' : 'provider_reported_usd')) {
      throw new Error('model, mode and tariff must agree; use a tariff file for each proxy model');
    }
    if (models.some(existing => existing.id === model.id)) throw new Error('unique model IDs required');
    models.push(model);
  }
  return models;
}
