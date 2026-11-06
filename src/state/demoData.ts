/**
 * Invented servers, watches and transfers of the browser prototype and the
 * website demo.
 */
import type { Server, Transfer, Watch } from '../backend/types';
import { defaultWatchOptions } from './defaults';

export function sampleServers(): Server[] {
  const base = { port: 22, auth: 'key' as const, keyPath: '~/.ssh/id_ed25519', online: false };
  return [
    {
      ...base,
      id: 'ob',
      name: 'Webshop · Live',
      mono: 'WL',
      color: 'gray',
      ruleId: 'rule-app',
      host: 'shop.example',
      user: 'deploy',
      keyPath: '~/.ssh/shop_ed25519',
      group: 'Webshop',
      localStart: '~/Projekte/webshop/live',
      remoteStart: '/home/deploy/apps/webshop',
      online: true,
      lastUsed: Date.now() - 5 * 60000,
      places: [
        { name: 'deploy', path: '/home/deploy' },
        { name: 'webshop', path: '/home/deploy/apps/webshop' },
        { name: 'blog', path: '/home/deploy/apps/blog' },
      ],
    },
    {
      ...base,
      id: 'cw',
      name: 'Portfolio',
      mono: 'PF',
      color: 'gray',
      host: 'portfolio.example',
      user: 'web',
      group: 'Websites',
      localStart: '~/Projekte/portfolio',
      remoteStart: '/var/www/portfolio',
      online: true,
      lastUsed: Date.now() - 26 * 3600000,
      places: [{ name: 'portfolio', path: '/var/www/portfolio' }],
    },
    {
      ...base,
      id: 'ts',
      name: 'Testserver',
      mono: 'TS',
      color: 'green',
      host: 'test.portfolio.example',
      user: 'test',
      group: 'Websites',
      localStart: '~',
      remoteStart: '/home/test',
    },
    {
      ...base,
      id: 'nas',
      name: 'Backup NAS',
      mono: 'NA',
      color: 'gray',
      host: 'nas.local',
      user: 'admin',
      auth: 'password',
      group: 'Privat',
      localStart: '~/Downloads',
      remoteStart: '/volume1/backups',
    },
  ];
}

export function sampleWatches(): Watch[] {
  return [
    {
      id: 'w1',
      name: 'webshop live',
      localPath: '~/Projekte/webshop/live',
      serverId: 'ob',
      remotePath: '/home/deploy/apps/webshop',
      state: 'active',
      lastFile: 'cart.py',
      lastTime: Date.now() - 12000,
      excludes: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp', '.venv'],
      options: { ...defaultWatchOptions, commandEnabled: true, command: 'pm2 restart webshop' },
    },
    {
      id: 'w2',
      name: 'blog live',
      localPath: '~/Projekte/blog',
      serverId: 'ob',
      remotePath: '/home/deploy/apps/blog',
      state: 'paused',
      lastFile: '',
      lastTime: Date.now() - 2 * 3600 * 1000,
      excludes: ['.git', '__pycache__', '.DS_Store'],
      options: { ...defaultWatchOptions, command: 'pm2 restart blog' },
    },
  ];
}

export function sampleTransfers(): Transfer[] {
  const now = Date.now();
  return [
    {
      id: 't-welcome',
      name: 'cart.py',
      direction: 'up',
      serverId: 'ob',
      folder: 'routes',
      source: '~/Projekte/webshop/live/routes/cart.py',
      target: '/home/deploy/apps/webshop/routes/cart.py',
      size: 8192,
      done: 8192,
      state: 'done',
      watchId: 'w1',
      finishedAt: now - 12000,
    },
    {
      id: 't-cmd0',
      name: 'pm2 restart webshop',
      direction: 'command',
      serverId: 'ob',
      folder: '',
      source: '',
      target: '',
      size: 1,
      done: 1,
      state: 'done',
      watchId: 'w1',
      finishedAt: now - 10000,
      output: '[PM2] Applying action restartProcessId on app [webshop]\n[PM2] [webshop](0) ✓',
    },
    {
      id: 't-app',
      name: 'app.css',
      direction: 'up',
      serverId: 'ob',
      folder: 'admin/static',
      source: '~/Projekte/webshop/live/admin/static/app.css',
      target: '/home/deploy/apps/webshop/admin/static/app.css',
      size: 48 * 1024,
      done: 0,
      state: 'queued',
      watchId: 'w1',
    },
  ];
}
