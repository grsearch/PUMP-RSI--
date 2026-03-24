# SOL RSI Monitor  v1.3

Solana 小币 5 秒 K 线 RSI 策略监控系统

---

## 文件结构

```
rsi-monitor/
├── src/
│   ├── server.js      Express 服务器（纯 REST，无 WebSocket）
│   ├── monitor.js     策略引擎（核心逻辑）
│   ├── rsi.js         RSI 计算 + 5 秒 K 线聚合
│   ├── birdeye.js     BirdEye API 封装
│   ├── webhook.js     买卖信号发送
│   └── logger.js      日志工具
├── public/
│   └── index.html     实时 Dashboard（5 秒 REST 轮询）
├── logs/              运行日志（自动创建）
├── .env               配置（需填入 API Key）
├── rsi-monitor.service  systemd 服务文件
└── package.json
```

---

## 策略说明

### 买入

| 条件 | 说明 |
|------|------|
| RSI(7) 上穿 30 | 前一根 5s K 线 RSI ≤ 30，当前 K 线 RSI > 30 |

- 30 分钟监控窗口内允许**多次买卖**
- 卖出后 5 秒重置为观察状态，等待下一次买入信号

### 卖出（满足任一触发）

| 触发 | 条件 |
|------|------|
| RSI ≥ 80 | 当前 RSI 极度超买（优先判断） |
| RSI 下穿 70 | 前一根 K 线 RSI ≥ 70，当前 K 线 RSI < 70 |

### 白名单强制退出（退出前若持仓先发卖出信号）

| 条件 | 说明 |
|------|------|
| FDV < $10,000 | 实时 FDV 跌破门槛 |
| Age > 30 分钟 | 超过监控时长上限 |

---

## 部署（腾讯云 2C4G Ubuntu）

### 1. 安装 Node.js 18

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18 && nvm use 18 && nvm alias default 18
node -v   # 应为 v18.x
```

### 2. 克隆 & 安装依赖

```bash
git clone https://github.com/your-username/rsi-monitor.git
cd rsi-monitor
npm install
```

### 3. 配置 .env

```bash
nano .env
```

**必填：**
```env
BIRDEYE_API_KEY=粘贴你的 BirdEye API Key
```

### 4. 部署 systemd 服务

**4-1. 确认 node 路径**

```bash
which node
# 示例输出：/home/ubuntu/.nvm/versions/node/v18.20.4/bin/node
```

如果路径与 `rsi-monitor.service` 里的 `ExecStart` 不同，先修改 service 文件：

```bash
nano rsi-monitor.service
# 将 ExecStart= 行的 node 路径改为上面 which node 的实际输出
```

**4-2. 安装并启动**

```bash
# 复制 service 文件到 systemd 目录
sudo cp rsi-monitor.service /etc/systemd/system/

# 重载 systemd 配置
sudo systemctl daemon-reload

# 设置开机自启
sudo systemctl enable rsi-monitor

# 立即启动
sudo systemctl start rsi-monitor

# 查看运行状态
sudo systemctl status rsi-monitor
```

### 5. 验证

```bash
# 查看实时日志
sudo journalctl -u rsi-monitor -f

# 检查健康接口
curl http://localhost:3003/health

# 手动测试加入代币
curl -X POST http://localhost:3003/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

### 6. 腾讯云安全组

放行入站 TCP 端口 **3003**，来源 IP 限制为扫描服务器 IP。

---

## 日志

```bash
# 实时跟踪
sudo journalctl -u rsi-monitor -f

# 查看最近 200 行
sudo journalctl -u rsi-monitor -n 200

# 按时间筛选
sudo journalctl -u rsi-monitor --since "2024-01-01 10:00:00" --until "2024-01-01 11:00:00"

# 开启 DEBUG 模式（需修改 service 文件的 Environment 行）
# 在 /etc/systemd/system/rsi-monitor.service 中添加：
# Environment=DEBUG=1
# 然后：
sudo systemctl daemon-reload && sudo systemctl restart rsi-monitor
```

---

## 常用管理命令

```bash
# 启动 / 停止 / 重启
sudo systemctl start rsi-monitor
sudo systemctl stop rsi-monitor
sudo systemctl restart rsi-monitor

# 查看状态
sudo systemctl status rsi-monitor

# 开机自启 / 取消自启
sudo systemctl enable rsi-monitor
sudo systemctl disable rsi-monitor

# 修改配置后重载
sudo systemctl daemon-reload && sudo systemctl restart rsi-monitor
```

---

## 常见问题

**Q: RSI 显示 null / ——？**
A: RSI(7) 需要至少 8 根已封闭的 5 秒 K 线，启动后约 40 秒才出现第一个值。

**Q: 买入信号已发但交易服务器未收到？**
A: 检查 `TRADE_WEBHOOK_BUY_URL` 配置，并确认网络互通：
```bash
curl -X POST http://43.165.7.149:3002/webhook/new-token \
  -H "Content-Type: application/json" \
  -d '{"mint":"test","symbol":"TEST"}'
```

**Q: 代币被拒绝 fdv_too_low？**
A: BirdEye 返回的 FDV < $10,000，符合策略预期，正常现象。

**Q: service 启动失败，提示 node not found？**
A: nvm 安装的 node 路径不在系统 PATH 里。执行 `which node` 获取完整路径，
更新 `rsi-monitor.service` 的 `ExecStart=` 行后重新 `daemon-reload`。
