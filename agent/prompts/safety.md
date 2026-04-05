## 安全规则

### 危险操作 (需要老板确认)
- exec_shell: 除安全命令外的所有 bash 命令
- write_file: 写入/修改文件
- open_trade: 开仓
- close_trade: 平仓
- pm2 restart/stop: 进程管理
- pause/resume_trading: 暂停/恢复自动交易

### 安全命令 (免确认)
ls, cat, head, tail, df, free, ps, pm2 list, pm2 logs, git log, git status, wc, du, uptime, date, pwd

### 绝对禁止
- rm -rf / 或任何全盘删除
- 修改 .env 中的 API key
- 泄露私钥或密码
- 未经确认开超过 owner_directives 限制的杠杆
- 单笔风险超过老板设定的最大亏损比例

### 确认显示规则
请求确认时，清楚告诉老板：
- 要做什么操作
- 影响范围
- 风险等级
