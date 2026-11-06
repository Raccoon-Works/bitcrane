/**
 * Top of Settings › Allgemein: the app symbol with name and version, the
 * update state and links to the project.
 */
import { type ReactNode } from 'react';
import { Bug, GithubLogo, Scroll, Sparkle } from '@phosphor-icons/react';
import { openDialog, openExternal, useStore } from '../../../state/store';
import { useAppVersion } from '../../../state/updates';
import { BMark } from '../../icons';
import { Wordmark } from '../../ui';
import { $t } from '../../../i18n';

const GITHUB_URL = 'https://github.com/Raccoon-Works/bitcrane';

export function AboutHeader() {
  const version = useAppVersion();
  const update = useStore((st) => st.update);
  const links: Array<{ label: string; note: string; icon: ReactNode; run: () => void }> = [
    {
      label: $t('Was ist neu?'),
      note: $t('Änderungen der Versionen'),
      icon: <Sparkle size={18} />,
      run: () => openExternal(`${GITHUB_URL}/releases`),
    },
    {
      label: $t('Problem melden'),
      note: $t('Auf GitHub'),
      icon: <Bug size={18} />,
      run: () => openExternal(`${GITHUB_URL}/issues/new`),
    },
    { label: $t('Quellcode'), note: 'GitHub', icon: <GithubLogo size={18} />, run: () => openExternal(GITHUB_URL) },
    {
      label: $t('Lizenzen'),
      note: $t('Verwendete Bausteine'),
      icon: <Scroll size={18} />,
      run: () => openDialog({ type: 'licenses' }),
    },
  ];
  return (
    <div className="set-about">
      <div className="set-about-app">
        <BMark variant="brand" size={80} />
        <div className="col-text">
          <Wordmark className="set-about-name" />
          <span className="small muted">
            {version ? $t('Version {0}', version) : ' '}
            {update?.status === 'ready' ? ` · ${$t('Update {0} bereit', update.version ?? '')}` : ''}
          </span>
          <span className="small muted">{$t('von')} RaccoonWorks</span>
        </div>
      </div>
      <div className="set-about-links">
        {links.map((l) => (
          <button key={l.label} type="button" className="set-about-link" onClick={l.run}>
            <span className="set-about-link-icon" aria-hidden="true">
              {l.icon}
            </span>
            <span className="col-text">
              <span>{l.label}</span>
              <span className="small muted">{l.note}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
