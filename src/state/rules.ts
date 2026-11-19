/**
 * Transfer rules (Settings > Regeln): which one applies to a server or a watch, and editing them.
 */
import type { Watch } from '../backend/types';
import type { AppState, TransferRule } from './appState';
import { getState, setState, uid } from './core';

/**
 * Rule in effect for a server, or for a watch (its own choice, else its server's).
 * Undefined = the general settings.
 */
export function ruleFor(
  serverId: string,
  watchId?: string,
  s: AppState = getState(),
  useChoice = true,
): TransferRule | undefined {
  const rules = s.settings.rules ?? [];
  // Transfers by hand follow the rule chosen in the activity area (WinSCP "Transfer settings"), if any.
  if (!watchId && useChoice && s.transferRule)
    return s.transferRule === 'none' ? undefined : rules.find((r) => r.id === s.transferRule);
  const w = watchId ? s.watches.find((x) => x.id === watchId) : undefined;
  if (w?.ruleId === 'none') return undefined;
  const id = w?.ruleId ?? s.servers.find((x) => x.id === serverId)?.ruleId;
  return id ? rules.find((r) => r.id === id) : undefined;
}

/** Excludes of a watch together with those of its rule. */
export function watchExcludes(w: Watch, s: AppState = getState()): string[] {
  const r = ruleFor(w.serverId, w.id, s);
  return r?.excludes.length ? [...new Set([...w.excludes, ...r.excludes])] : w.excludes;
}

/** Adds, changes or removes a rule; servers and watches using a removed rule fall back. */
export function saveRule(rule: TransferRule) {
  setState((s) => {
    const list = s.settings.rules ?? [];
    return {
      settings: {
        ...s.settings,
        rules: list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? rule : r)) : [...list, rule],
      },
    };
  });
}

export function removeRule(id: string) {
  setState((s) => ({
    settings: { ...s.settings, rules: (s.settings.rules ?? []).filter((r) => r.id !== id) },
    servers: s.servers.map((x) => (x.ruleId === id ? { ...x, ruleId: undefined } : x)),
    watches: s.watches.map((w) => (w.ruleId === id ? { ...w, ruleId: undefined } : w)),
  }));
}

export function newRuleId(): string {
  return uid('rule');
}
