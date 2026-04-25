import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export function formatProviderKindLabel(provider: ProviderKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function shouldOfferPiGlobalAgentDirShortcut(input: {
  readonly provider: ServerProvider | undefined;
  readonly agentDir: string | null | undefined;
  readonly useGlobalAgentDir: boolean;
}): boolean {
  return (
    input.provider?.provider === "pi" &&
    input.provider.installed &&
    input.provider.status === "warning" &&
    input.provider.auth.status === "unauthenticated" &&
    input.provider.auth.label === "isolated agent dir" &&
    !input.useGlobalAgentDir &&
    (input.agentDir?.trim().length ?? 0) === 0
  );
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  const requested = provider ?? "codex";
  if (isProviderEnabled(providers, requested)) {
    return requested;
  }
  return providers.find((candidate) => candidate.enabled)?.provider ?? requested;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}
