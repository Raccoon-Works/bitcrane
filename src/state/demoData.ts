/**
 * Invented servers, watches and transfers of the browser prototype and the
 * website demo.
 */
import type { CloudPlace, ImportedServer, KnownHost, LocalShell, NetworkHost } from '../backend/api';
import type { PaneSide, Place, Platform, Server, Transfer, Watch } from '../backend/types';
import { defaultWatchOptions } from './defaults';

/**
 * Typical drives of the browser prototype, which has no real ones. Constant
 * lists, so store selectors that return them keep a stable value.
 */
export const DEMO_DRIVES: Record<Platform, Place[]> = {
  mac: [
    { name: 'Macintosh HD', path: '~' },
    { name: 'USB-Stick', path: '~/Downloads' },
    { name: 'iMac im Studio', path: '~/Projekte/blog', network: true },
  ],
  win: [
    { name: 'C:', path: '~' },
    { name: 'D:', path: '~/Downloads', label: 'Daten' },
    { name: 'Z: (NAS)', path: '~/Projekte/blog', network: true },
  ],
};

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

/** Servers "found" in other programs (import window, welcome screen). */
export const DEMO_IMPORTS: { servers: ImportedServer[]; sources: string[] } = {
  sources: ['SSH-Konfiguration', 'FileZilla', 'WinSCP'],
  servers: [
    {
      source: 'SSH-Konfiguration',
      name: 'shop',
      group: '',
      host: 'shop.example',
      port: 22,
      user: 'deploy',
      protocol: 'sftp',
      implicitTls: false,
      auth: 'key',
      keyPath: '~/.ssh/shop_ed25519',
    },
    {
      source: 'FileZilla',
      name: 'Portfolio',
      group: 'Websites',
      host: 'portfolio.example',
      port: 21,
      user: 'web',
      protocol: 'ftps',
      implicitTls: false,
      auth: 'password',
    },
    {
      source: 'WinSCP',
      name: 'NAS',
      group: 'Privat',
      host: 'nas.local',
      port: 22,
      user: 'admin',
      protocol: 'sftp',
      implicitTls: false,
      auth: 'password',
    },
  ],
};

/** The server of the exported file the prototype pretends to read. */
export const DEMO_IMPORT_FILE: ImportedServer = {
  source: 'Transmit',
  name: 'Webseite',
  group: '',
  host: 'ftp.example',
  port: 21,
  user: 'web',
  protocol: 'ftps',
  implicitTls: false,
  auth: 'password',
};

/** A computer with file shares in the prototype's network. */
export const DEMO_NETWORK_HOSTS: NetworkHost[] = [{ name: 'NAS Keller', host: 'nas-keller.local' }];

/** Example text for the browser prototype, which reads no real files (editor). */
export function sampleText(name: string): string {
  if (/\.py$/i.test(name))
    return 'from flask import Blueprint, jsonify, request\n\nfrom .models import Cart, Product\n\ncart = Blueprint("cart", __name__)\n\n\n@cart.post("/cart/items")\ndef add_item():\n    """Adds a product to the cart of the visitor."""\n    data = request.get_json()\n    product = Product.query.get_or_404(data["id"])\n    Cart.current().add(product, qty=data.get("qty", 1))\n    return jsonify(ok=True)\n';
  if (/\.(json)$/i.test(name))
    return '{\n  "name": "webshop",\n  "version": "1.4.2",\n  "currency": "EUR",\n  "shipping": {\n    "free_from": 50,\n    "countries": ["DE", "AT", "CH"]\n  }\n}\n';
  if (/\.(md)$/i.test(name))
    return '# Webshop\n\nEin kleiner Shop mit Flask.\n\n## Start\n\n```bash\nflask --app app run\n```\n';
  if (/^\.env$|\.ini$|\.conf$/i.test(name)) return 'SECRET_KEY=…\nDATABASE_URL=sqlite:///data.db\nLOG_LEVEL=info\n';
  return `${name}\n`;
}

/**
 * The app.py of the demo webshop in two versions, server and this computer:
 * what previews and file comparisons of the prototype show.
 */
export const DEMO_APP_PY: Record<PaneSide, string> = {
  remote:
    'from flask import Flask\n\nfrom .routes import cart, products\n\nDEBUG = True\n\napp = Flask(__name__)\napp.register_blueprint(cart)\napp.register_blueprint(products)\n\n\n@app.get("/health")\ndef health():\n    return "ok"\n',
  local:
    'from flask import Flask\n\nfrom .routes import cart, checkout, products\n\nDEBUG = False\nLOG_LEVEL = "info"\n\napp = Flask(__name__)\napp.register_blueprint(cart)\napp.register_blueprint(products)\napp.register_blueprint(checkout)\n\n\n@app.get("/health")\ndef health():\n    return "Webshop ok"\n',
};

/** Free space of the prototype's disk, in bytes. */
export const DEMO_FREE_SPACE = 86.2e9;

/** Cloud storage folders the prototype pretends to find. */
export const DEMO_CLOUD_PLACES: CloudPlace[] = [
  { name: 'Google Drive', path: '~/Library/CloudStorage/GoogleDrive', service: 'gdrive' },
  { name: 'OneDrive', path: '~/Library/CloudStorage/OneDrive-Personal', service: 'onedrive' },
  { name: 'iCloud Drive', path: '~/Library/Mobile Documents/com~apple~CloudDocs', service: 'icloud' },
];

/** Stored host key fingerprints of the demo servers. */
export const DEMO_KNOWN_HOSTS: KnownHost[] = [
  { host: 'shop.example:22', fingerprint: 'SHA256:U2hvcC1leGFtcGxlLWZpbmdlcnByaW50AA' },
  { host: 'portfolio.example:22', fingerprint: 'SHA256:UG9ydGZvbGlvLWV4YW1wbGUtZmluZ2Vy' },
];

/** The shells a Mac and a Windows computer typically offer. */
export const DEMO_SHELLS: Record<Platform, LocalShell[]> = {
  mac: [
    { id: 'zsh', name: 'zsh' },
    { id: 'bash', name: 'bash' },
  ],
  win: [
    { id: 'pwsh', name: 'PowerShell 7' },
    { id: 'powershell', name: 'Windows PowerShell' },
    { id: 'cmd', name: 'Eingabeaufforderung (cmd)' },
    { id: 'gitbash', name: 'Git Bash' },
  ],
};
