/**
 * Common commands offered by the terminal's completion list (termSuggest.ts)
 * before the user has typed them once. Short on purpose: things people type
 * on Linux servers every day, not a manual.
 */
export const COMMAND_CATALOG: string[] = [
  // Files and folders
  'ls -la', 'ls -lh', 'cd ', 'cd ..', 'pwd', 'mkdir -p ', 'rm -r ', 'rm -rf ', 'cp -r ', 'mv ', 'touch ', 'cat ', 'less ', 'head -n 50 ', 'tail -n 100 ', 'tail -f ',
  'nano ', 'vim ', 'chmod +x ', 'chmod 644 ', 'chmod 755 ', 'chown -R ', 'ln -s ', 'find . -name ', 'grep -rn ', 'du -sh *', 'du -sh ', 'df -h', 'tree -L 2',
  'tar -czf ', 'tar -xzf ', 'unzip ', 'zip -r ', 'rsync -avz ', 'scp ', 'wget ', 'curl -I ', 'curl -sS ',
  // System
  'htop', 'top', 'free -h', 'uptime', 'uname -a', 'whoami', 'hostname -I', 'lsb_release -a', 'cat /etc/os-release', 'ps aux | grep ', 'kill ', 'kill -9 ', 'pkill ',
  'sudo -i', 'sudo reboot', 'sudo shutdown -h now', 'history | grep ', 'crontab -e', 'crontab -l', 'env | grep ', 'which ', 'watch -n 2 ',
  // Services and logs
  'sudo systemctl status ', 'sudo systemctl restart ', 'sudo systemctl start ', 'sudo systemctl stop ', 'sudo systemctl enable ', 'sudo systemctl daemon-reload',
  'journalctl -u ', 'journalctl -f', 'journalctl -xe', 'sudo tail -f /var/log/syslog', 'sudo tail -f /var/log/nginx/error.log', 'sudo nginx -t', 'sudo systemctl reload nginx',
  // Packages
  'sudo apt update', 'sudo apt upgrade -y', 'sudo apt install ', 'sudo apt remove ', 'sudo apt autoremove', 'apt list --upgradable', 'sudo dnf upgrade', 'sudo dnf install ',
  // Network
  'ip a', 'ss -tulpn', 'sudo ss -tulpn', 'ping -c 4 ', 'sudo ufw status', 'sudo ufw allow ', 'dig ', 'nslookup ', 'traceroute ',
  // Docker
  'docker ps', 'docker ps -a', 'docker logs -f ', 'docker exec -it ', 'docker images', 'docker compose up -d', 'docker compose down', 'docker compose logs -f', 'docker compose pull',
  'docker compose restart', 'docker system prune', 'docker stats',
  // Git
  'git status', 'git pull', 'git push', 'git log --oneline -20', 'git diff', 'git add .', 'git commit -m ""', 'git checkout ', 'git switch ', 'git branch', 'git stash', 'git fetch',
  // Node and Python
  'pm2 status', 'pm2 logs', 'pm2 logs --lines 100', 'pm2 restart ', 'pm2 stop ', 'pm2 start ', 'pm2 save', 'pm2 monit',
  'npm install', 'npm run ', 'npm ci', 'node -v', 'python3 ', 'python3 -m venv .venv', 'source .venv/bin/activate', 'pip install -r requirements.txt', 'pip install ',
  // Databases
  'mysql -u root -p', 'sudo -u postgres psql', 'redis-cli',
  // tmux and screen
  'tmux', 'tmux attach', 'tmux ls', 'screen -r', 'screen -ls',
];

/** Commands after which the next word is usually a file or folder. */
export const PATH_COMMANDS = new Set([
  'cd', 'ls', 'cat', 'less', 'more', 'head', 'tail', 'nano', 'vim', 'vi', 'code', 'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'du', 'tar',
  'unzip', 'zip', 'rsync', 'scp', 'source', '.', 'bash', 'sh', 'python', 'python3', 'node', 'stat', 'file', 'diff', 'grep', 'find', 'tree',
  'Get-Content', 'Set-Location', 'Remove-Item', 'Copy-Item', 'Move-Item', 'type', 'dir', 'del', 'copy', 'move',
]);
