/**
 * Server editor › Weitere Einstellungen: the folded-in section with proxy,
 * protocol options, connection limits, name form, synchronous browsing, the
 * Explorer folder, web address, note and the template for new servers.
 */
import { useState } from 'react';
import { ChevronRight } from '../../glyphs';
import type { Server } from '../../../backend/types';
import { showToast, updateSettings, useStore } from '../../../state/store';
import { Button, Select, Switch, TextField } from '../../ui';
import { $t } from '../../../i18n';
import type { Fam, SetField } from './model';
import { ProtocolOptions } from './ProtocolOptions';
import { ProxyField } from './ProxyField';

export function MoreSettings({
  draft,
  set,
  family,
  proxyPassword,
  setProxyPassword,
}: {
  draft: Server;
  set: SetField;
  family: Fam;
  proxyPassword: string;
  setProxyPassword: (v: string) => void;
}) {
  const platform = useStore((s) => s.platform);
  const defaults = useStore((s) => s.settings.serverDefaults);
  const parallel = useStore((s) => s.settings.parallel);
  const [more, setMore] = useState(() => !!(draft.proxy || draft.webUrl || draft.note));
  return (
    <section aria-label={$t('Weitere Einstellungen')} className="section-card disclosure server-more">
      <button type="button" className="disclosure-head" aria-expanded={more} onClick={() => setMore(!more)}>
        <ChevronRight size={13} strokeWidth={2} className={`chev${more ? ' is-open' : ''}`} aria-hidden="true" />
        <span className="strong">{$t('Weitere Einstellungen')}</span>
        <span className="small muted ellipsis">
          {[
            draft.proxy?.host && $t('Proxy'),
            draft.forwards?.length &&
              (draft.forwards.length === 1 ? $t('1 Tunnel') : $t('{0} Tunnel', draft.forwards.length)),
            (draft.maxTransfers || draft.connectTimeout) && $t('Verbindung'),
            draft.syncBrowseOnOpen && $t('Synchron blättern'),
            draft.webUrl && $t('Web-Adresse'),
            draft.note && $t('Notiz'),
          ]
            .filter(Boolean)
            .join(', ') ||
            (family === 'ftp'
              ? $t('Proxy, TLS-Version, Dateinamen, Zeitzone, Verbindung, Notiz')
              : family === 'sftp'
                ? $t('Proxy, Terminal, Tunnel, Verbindung, Notiz')
                : $t('Proxy, Verbindung, Web-Adresse, Notiz'))}
        </span>
      </button>
      {more && (
        <div className="disclosure-body form-grid">
          {family !== 'smb' && (
            <ProxyField draft={draft} set={set} proxyPassword={proxyPassword} setProxyPassword={setProxyPassword} />
          )}
          <ProtocolOptions draft={draft} set={set} family={family} />

          {family !== 'cloud' && (
            <>
              <label htmlFor="s-maxtr">{$t('Verbindung')}</label>
              <div className="col-text">
                <div className="field-row">
                  <Select
                    id="s-maxtr"
                    label={$t('Gleichzeitige Übertragungen')}
                    value={String(draft.maxTransfers ?? 0)}
                    onChange={(v) => set('maxTransfers', Number(v) || undefined)}
                    options={[
                      { value: '0', label: $t('Übertragungen: wie eingestellt ({0})', parallel) },
                      ...[1, 2, 3, 4, 6, 8].map((n) => ({
                        value: String(n),
                        label: n === 1 ? $t('Übertragungen: höchstens 1') : $t('Übertragungen: höchstens {0}', n),
                      })),
                    ]}
                  />
                  <Select
                    id="s-timeout"
                    label={$t('Zeitlimit beim Verbinden')}
                    value={String(draft.connectTimeout ?? 0)}
                    onChange={(v) => set('connectTimeout', Number(v) || undefined)}
                    options={[
                      { value: '0', label: $t('Zeitlimit: 15 s (Standard)') },
                      ...[30, 60, 120].map((n) => ({ value: String(n), label: $t('Zeitlimit: {0} s', n) })),
                    ]}
                  />
                </div>
                <span className="small muted">
                  {$t(
                    'Manche Anbieter erlauben nur wenige gleichzeitige Verbindungen; dann hier begrenzen. Ein längeres Zeitlimit hilft bei langsamen oder weit entfernten Servern.',
                  )}
                </span>
              </div>
            </>
          )}

          <span>{$t('Umlaute')}</span>
          <div className="col-text">
            <span className="row-inline">
              <Switch
                checked={!draft.keepNameForm}
                onChange={(v) => set('keepNameForm', !v || undefined)}
                label={$t('Dateinamen einheitlich speichern (empfohlen)')}
              />
              <span>{$t('Dateinamen einheitlich speichern (empfohlen)')}</span>
            </span>
            <span className="small muted">
              {$t(
                'Der Mac speichert Umlaute manchmal zerlegt (u + ¨). Bitcrane lädt sie in der üblichen Form hoch (Unicode NFC), sonst sieht der Server zwei verschiedene Namen.',
              )}
            </span>
          </div>

          <span>{$t('Synchron blättern')}</span>
          <div className="col-text">
            <span className="row-inline">
              <Switch
                checked={!!draft.syncBrowseOnOpen}
                onChange={(v) => set('syncBrowseOnOpen', v || undefined)}
                label={$t('Beim Öffnen synchron blättern')}
              />
              <span>{$t('Beim Öffnen synchron blättern')}</span>
            </span>
            <span className="small muted">
              {$t(
                'Lokaler Ordner und Ordner auf dem Server (oben unter Startordner) wandern gemeinsam: ein Ordnerwechsel auf einer Seite gilt auch für die andere.',
              )}
            </span>
          </div>

          {family !== 'cloud' && (
            <>
              <span>{platform === 'win' ? $t('Im Explorer zeigen') : $t('Im Finder zeigen')}</span>
              <div className="col-text">
                {platform === 'win' ? (
                  <>
                    <span className="row-inline">
                      <Switch
                        checked={!!draft.mountExplorer}
                        onChange={(v) => set('mountExplorer', v || undefined)}
                        label={$t('Im Explorer als Ordner zeigen')}
                      />
                      <span>{$t('Im Explorer als Ordner zeigen')}</span>
                    </span>
                    <span className="small muted">
                      {$t(
                        'Wie OneDrive: Der Server erscheint links im Explorer, Dateien werden erst beim Öffnen geladen, Änderungen gehen von selbst zurück auf den Server. Braucht ein gespeichertes Passwort.',
                      )}
                    </span>
                  </>
                ) : (
                  <span className="small muted">
                    {$t(
                      'Server als Ordner im Finder kommen mit einer von Apple signierten Version von Bitcrane. Unter Windows gibt es das schon.',
                    )}
                  </span>
                )}
              </div>
            </>
          )}

          <label htmlFor="s-web">{$t('Web-Adresse')}</label>
          <div className="col-text">
            <div className="field-row">
              <TextField
                id="s-web"
                value={draft.webUrl ?? ''}
                onChange={(v) => set('webUrl', v.trim() || undefined)}
                placeholder="https://example.com"
                className="flex-1"
              />
              <TextField
                label={$t('Passender Ordner auf dem Server')}
                mono
                value={draft.webRoot ?? ''}
                onChange={(v) => set('webRoot', v.trim() || undefined)}
                placeholder="/var/www/html"
                className="flex-1"
              />
            </div>
            <span className="small muted">
              {$t('Damit gibt es bei Dateien „Web-Adresse kopieren“ und „Im Browser öffnen“.')}
            </span>
          </div>

          <label htmlFor="s-note">{$t('Notiz')}</label>
          <textarea
            id="s-note"
            className="note-field"
            rows={3}
            value={draft.note ?? ''}
            onChange={(e) => set('note', e.target.value || undefined)}
            placeholder={$t('Was läuft hier? Wen fragen?')}
          />

          <span>{$t('Vorlage')}</span>
          <div className="row-inline">
            <Button
              small
              onClick={() => {
                updateSettings({
                  serverDefaults: {
                    port: draft.port,
                    user: draft.user,
                    auth: draft.auth,
                    keyPath: draft.keyPath,
                    localStart: draft.localStart,
                    group: draft.group,
                    color: draft.color,
                    jumpServerId: draft.jumpServerId,
                    proxy: draft.proxy,
                  },
                });
                showToast($t('Neue Server beginnen jetzt mit diesen Einstellungen.'), 'ok');
              }}
            >
              {$t('Als Vorlage für neue Server')}
            </Button>
            {Object.keys(defaults).length > 0 && (
              <Button
                small
                variant="ghost"
                onClick={() => {
                  updateSettings({ serverDefaults: {} });
                  showToast($t('Vorlage entfernt.'));
                }}
              >
                {$t('Vorlage entfernen')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
