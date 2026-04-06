/**
 * System tools — VPS control via TG agent.
 *   exec_shell, read_file, write_file, pm2_action, system_status
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const SHELL_TIMEOUT = 30000;
const SAFE_COMMANDS = /^(ls|cat|head|tail|df|free|ps|pm2 list|pm2 logs|git log|git status|wc|du|uptime|whoami|date|pwd|echo)/;

export function createSystemTools({ log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  const TOOL_DEFS = [
    {
      name: 'exec_shell',
      description: '在 VPS 上执行 bash 命令。安全命令(ls/cat/df/ps等)免确认，其他需要用户确认。',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string', description: '要执行的 bash 命令' } },
        required: ['cmd'],
      },
      requiresConfirmation: true,
      isDestructive: true,
      safePatterns: [SAFE_COMMANDS],
    },
    {
      name: 'read_file',
      description: '读取 VPS 上的文件内容（最多 5000 字符）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          lines: { type: 'number', description: '读取行数 (默认全部, 最多200)' },
        },
        required: ['path'],
      },
      requiresConfirmation: true,
    },
    {
      name: 'write_file',
      description: '写入或追加内容到 VPS 上的文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的内容' },
          append: { type: 'boolean', description: '是否追加 (默认覆盖)' },
        },
        required: ['path', 'content'],
      },
      requiresConfirmation: true,
      isDestructive: true,
    },
    {
      name: 'pm2_action',
      description: 'PM2 进程管理: list/logs/restart/stop',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'logs', 'restart', 'stop'], description: '操作类型' },
          name: { type: 'string', description: '进程名 (logs/restart/stop 时必填)' },
          lines: { type: 'number', description: 'logs 行数 (默认 30)' },
        },
        required: ['action'],
      },
      requiresConfirmation: true,
      safePatterns: [/^list$/, /^logs$/],
    },
    {
      name: 'system_status',
      description: '获取 VPS 系统状态: CPU、内存、磁盘、运行时间、进程数',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'codex_status',
      description: '查看 Codex 反代状态 (http://YOUR_VPS_IP:8080)',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
  ];

  const EXECUTORS = {
    async exec_shell({ cmd }) {
      if (!cmd) return '{ "error": "cmd is required" }';
      _log.info('exec_shell', { module: 'tools', cmd: cmd.slice(0, 100) });
      try {
        const output = execSync(cmd, {
          timeout: SHELL_TIMEOUT,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
        return output || '(no output)';
      } catch (err) {
        return `Error: ${err.message}\n${err.stderr || ''}`.slice(0, 2000);
      }
    },

    async read_file({ path, lines }) {
      if (!existsSync(path)) return `Error: File not found: ${path}`;
      try {
        let content = readFileSync(path, 'utf-8');
        if (lines) {
          content = content.split('\n').slice(0, Math.min(lines, 200)).join('\n');
        }
        return content.slice(0, 5000);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async write_file({ path, content, append }) {
      try {
        if (append) {
          const { appendFileSync } = await import('fs');
          appendFileSync(path, content);
        } else {
          writeFileSync(path, content);
        }
        _log.info('write_file', { module: 'tools', path, bytes: content.length });
        return `OK: wrote ${content.length} bytes to ${path}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async pm2_action({ action, name, lines }) {
      const cmds = {
        list: 'pm2 jlist',
        logs: `pm2 logs ${name || 'all'} --lines ${lines || 30} --nostream`,
        restart: `pm2 restart ${name}`,
        stop: `pm2 stop ${name}`,
      };
      const cmd = cmds[action];
      if (!cmd) return `Error: unknown action ${action}`;
      if ((action === 'restart' || action === 'stop' || action === 'logs') && !name) {
        return 'Error: name is required for this action';
      }
      try {
        const output = execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
        if (action === 'list') {
          try {
            const procs = JSON.parse(output);
            return procs.map(p =>
              `${p.name}: ${p.pm2_env?.status} | pid:${p.pid} | mem:${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB | uptime:${p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) + 'min' : '?'}`
            ).join('\n');
          } catch { return output; }
        }
        return output.slice(0, 3000);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async system_status() {
      try {
        const parts = [
          execSync('uptime', { encoding: 'utf-8', timeout: 5000 }).trim(),
          execSync('free -h | head -3', { encoding: 'utf-8', timeout: 5000 }).trim(),
          execSync('df -h / | tail -1', { encoding: 'utf-8', timeout: 5000 }).trim(),
        ];
        return parts.join('\n\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async codex_status() {
      try {
        // Docker container status
        const container = execSync(
          "docker ps --filter name=codex-proxy --format '{{.Status}} | Image: {{.Image}} | Ports: {{.Ports}}'",
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        // Health check via API
        let apiStatus = 'unknown';
        try {
          const res = await fetch('http://127.0.0.1:8080/v1/models', {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = await res.json();
            const models = data.data?.map(m => m.id).join(', ') || 'none';
            apiStatus = `OK (${models})`;
          } else {
            apiStatus = `HTTP ${res.status}`;
          }
        } catch (e) {
          apiStatus = `Error: ${e.message}`;
        }

        // Last auto-update check
        let lastUpdate = 'never';
        try {
          lastUpdate = execSync('tail -1 /home/ubuntu/codex-proxy/update.log 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim() || 'no log';
        } catch {}

        return [
          `Container: ${container || 'not running'}`,
          `API: ${apiStatus}`,
          `Auto-update: cron hourly`,
          `Last check: ${lastUpdate}`,
          `Dashboard: http://YOUR_VPS_IP:8080/#/`,
        ].join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
