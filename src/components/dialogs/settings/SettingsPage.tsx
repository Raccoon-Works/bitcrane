/**
 * Settings window: the list of areas with the search on the left, the rows of
 * the chosen area (or of all areas matching the search) on the right. Each
 * area lives in its own module in this folder; changes apply immediately.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListChecks, MagnifyingGlass, TerminalWindow } from '@phosphor-icons/react';
import { ArrowUpDown, Keyboard, Settings as Gear, Shield, SlidersHorizontal, SunMoon } from '../../glyphs';
import { WatchIcon } from '../../icons';
import type { SettingsTab } from '../../../backend/types';
import { setSettingsSection, useStore } from '../../../state/store';
import { $t } from '../../../i18n';
import { AboutHeader } from './AboutHeader';
import { AdvancedSettings } from './AdvancedTab';
import { AppearanceSettings } from './AppearanceTab';
import { ConnectionSettings } from './ConnectionsTab';
import { GeneralSettings } from './GeneralTab';
import { KeysSettings } from './KeysTab';
import { RulesSettings } from './RulesTab';
import { TerminalSettingsPage } from './TerminalTab';
import { TransferSettings } from './TransfersTab';
import { WatchSettings } from './WatchTab';
import { AreaTitle } from './parts';
import { filterSettings, matches } from './search';

/** Colour of each settings area's symbol. */
const TAB_COLORS: Record<SettingsTab, string> = {
  general: '#8e8e93',
  watch: '#2a6de0',
  transfers: '#e8a600',
  rules: '#3fbfaa',
  connections: '#30b158',
  appearance: '#af52de',
  terminal: '#30b0c7',
  keys: '#5ac8fa',
  advanced: '#ff7a3d',
};

/** The rows of each area; the search shows all areas with them at once. */
const AREAS: Record<SettingsTab, ComponentType> = {
  general: GeneralSettings,
  watch: WatchSettings,
  transfers: TransferSettings,
  rules: RulesSettings,
  connections: ConnectionSettings,
  appearance: AppearanceSettings,
  terminal: TerminalSettingsPage,
  keys: KeysSettings,
  advanced: AdvancedSettings,
};

/** The settings, shown in a tab of their own with the areas listed on the left. */
export function SettingsPage({ section }: { section: SettingsTab }) {
  const current = section;
  const setCurrent = setSettingsSection;
  // Another area starts at its top, not where the last one was scrolled to.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [section]);
  // Search over all areas: every row whose name or description fits stays, the rest is hidden.
  const [query, setQuery] = useState('');
  const [noHits, setNoHits] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // Ctrl+F / Cmd+F inside the settings goes to the search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useLayoutEffect(() => {
    const root = resultsRef.current;
    if (!root) return;
    const apply = () => setNoHits(!filterSettings(root, query));
    apply();
    // Rows that appear later (lists that load) are filtered as well.
    const mo = new MutationObserver(apply);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  });
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'general', label: $t('Allgemein'), icon: <Gear size={18} strokeWidth={1.6} /> },
    { id: 'watch', label: $t('Überwachung'), icon: <WatchIcon size={18} waves={2} /> },
    { id: 'transfers', label: $t('Übertragungen'), icon: <ArrowUpDown size={18} strokeWidth={1.6} /> },
    { id: 'rules', label: $t('Regeln'), icon: <ListChecks size={18} /> },
    { id: 'connections', label: $t('Verbindungen'), icon: <Shield size={18} strokeWidth={1.6} /> },
    { id: 'appearance', label: $t('Darstellung'), icon: <SunMoon size={18} strokeWidth={1.6} /> },
    { id: 'terminal', label: $t('Terminal'), icon: <TerminalWindow size={18} /> },
    { id: 'keys', label: $t('Tastenkürzel'), icon: <Keyboard size={18} strokeWidth={1.6} /> },
    { id: 'advanced', label: $t('Erweitert'), icon: <SlidersHorizontal size={18} strokeWidth={1.6} /> },
  ];
  const title = tabs.find((t) => t.id === current)!.label;
  const Body = AREAS[current];

  const searching = query.trim().length > 0;
  // With the sidebar shown, the list of areas moves into it (see MainWindow); otherwise it stays here.
  const sideOn = useStore((st) => st.settings.sidebar !== false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const inFront = useStore((st) => !!st.tabs.find((t) => t.id === st.activeTabId)?.settings);
  useLayoutEffect(() => {
    setSlot(sideOn && inFront ? document.getElementById('side-settings-slot') : null);
  }, [sideOn, inFront]);
  const nav = (
    <nav role="tablist" aria-orientation="vertical" aria-label={$t('Bereiche')} className="set-nav">
      <span className="set-nav-title">{$t('Einstellungen')}</span>
      <label className="set-search">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={$t('Suchen')}
          aria-label={$t('Einstellungen durchsuchen')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
        />
      </label>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={!searching && t.id === current}
          className={`set-tab${!searching && t.id === current ? ' is-sel' : ''}`}
          onClick={() => {
            setQuery('');
            setCurrent(t.id);
          }}
        >
          {/* Each area has its own colour, as in Transmit's and the Windows settings. */}
          <span className="set-tab-icon" style={{ color: TAB_COLORS[t.id] }}>
            {t.icon}
          </span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );

  return (
    <div className="settings-page">
      {slot ? createPortal(nav, slot) : nav}
      <div className="set-scroll" ref={scrollRef}>
        {searching ? (
          <div className="set-body set-search-results" ref={resultsRef} aria-label={$t('Suchergebnisse')}>
            {tabs.map((t) => {
              const Area = AREAS[t.id];
              return (
                <section
                  key={t.id}
                  className="set-search-section"
                  data-match={matches(t.label, query) ? '1' : undefined}
                >
                  <button
                    type="button"
                    className="set-search-head"
                    onClick={() => {
                      setQuery('');
                      setCurrent(t.id);
                    }}
                  >
                    <span className="set-tab-icon" style={{ color: TAB_COLORS[t.id] }}>
                      {t.icon}
                    </span>
                    {t.label}
                  </button>
                  <AreaTitle title={t.label}>
                    <Area />
                  </AreaTitle>
                </section>
              );
            })}
            {noHits && (
              <p className="muted set-search-empty">{$t('Keine Einstellung zu „{0}“ gefunden.', query.trim())}</p>
            )}
          </div>
        ) : (
          <AreaTitle title={title}>
            <div className="set-body" role="tabpanel" aria-label={title}>
              {current === 'general' && <AboutHeader />}
              <h1 className="set-heading">{title}</h1>
              <Body />
            </div>
          </AreaTitle>
        )}
      </div>
    </div>
  );
}
