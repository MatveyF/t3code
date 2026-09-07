import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  ZaiIcon,
} from "../Icons";
import { type ProviderInstanceBrand, resolveProviderInstanceBrand } from "../../providerInstances";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

export const PROVIDER_ICON_BY_BRAND: Record<ProviderInstanceBrand, Icon> = {
  zai: ZaiIcon,
};

/**
 * Glyph for a provider instance. A branded instance (by display name) shows
 * the vendor it actually talks to, e.g. a Claude Code instance pointed at
 * Z.ai shows the Z.ai mark; otherwise the driver's icon.
 */
export function resolveProviderInstanceIcon(
  driverKind: ProviderDriverKind,
  displayName: string,
): Icon | null {
  const brand = resolveProviderInstanceBrand(displayName);
  return (
    (brand ? PROVIDER_ICON_BY_BRAND[brand] : null) ?? PROVIDER_ICON_BY_PROVIDER[driverKind] ?? null
  );
}

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
