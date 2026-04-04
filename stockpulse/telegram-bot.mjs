/**
 * StockPulse Telegram Bot
 * Handles commands, push delivery, and follow-up conversations.
 */

const TG_API = 'https://api.telegram.org/bot';

export function createStockPulseBot({ config, pushEngine, aiAnalyst, dataSources }) {
  const token = process.env.SP_TELEGRAM_BOT_TOKEN || config.SP_BOT_TOKEN || '';
  if (!token) {
    console.log('[StockPulse Bot] No bot token configured, bot disabled');
    return { start() {}, sendPush() {} };
  }

  const apiBase = `${TG_API}${token}`;
  let pollOffset = 0;
  let polling = false;

  // Last push context per user (for follow-up conversations) — bounded
  const userPushContext = new Map();
  const CONTEXT_MAX = 1000;
  const CONTEXT_TTL = 24 * 60 * 60 * 1000; // 24h
  // Chat rate limiting for follow-ups — bounded
  const userChatCount = new Map();

  // Prune stale entries periodically — store ref so stop() can clean up
  let pruneTimer = null;
  let pollTimer = null;

  function startPruneTimer() {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of userPushContext) {
        if (now - v.timestamp > CONTEXT_TTL) userPushContext.delete(k);
      }
      const today = new Date().toISOString().split('T')[0];
      for (const [k, v] of userChatCount) {
        if (v.date !== today) userChatCount.delete(k);
      }
    }, 60 * 60 * 1000);
  }

  // ── Telegram API helpers ───────────────────────────────────────────────

  async function tgCall(method, body, timeout) {
    try {
      const res = await fetch(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout || 15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[SP Bot] ${method} failed: ${res.status} ${text}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error(`[SP Bot] ${method} error:`, e.message);
      return null;
    }
  }

  async function sendMessage(chatId, text, opts = {}) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      reply_to_message_id: opts.replyTo || undefined,
    });
  }

  // ── Push delivery ──────────────────────────────────────────────────────

  async function sendPush(telegramId, message, event) {
    const result = await sendMessage(telegramId, message);
    // Store context for follow-up (bounded)
    if (result?.result?.message_id) {
      if (userPushContext.size >= CONTEXT_MAX) {
        // Evict oldest entry
        const oldest = userPushContext.keys().next().value;
        userPushContext.delete(oldest);
      }
      userPushContext.set(telegramId, {
        messageId: result.result.message_id,
        event,
        timestamp: Date.now(),
      });
    }
  }

  // ── Command dedup lock ─────────────────────────────────────────────────
  const processingCommands = new Map(); // key: `${chatId}:${cmd}` → true

  // ── Command handlers ───────────────────────────────────────────────────

  const commands = {};

  commands['/start'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const username = msg.from.username || msg.from.first_name || '';

    pushEngine.registerUser(tgId, username);

    await sendMessage(chatId, `StockPulse — 你的AI美股情报员

欢迎！我会在重要事件发生时第一时间通知你。

快速开始：发送 /watch NVDA AAPL TSLA 添加关注
一键关注科技五巨头：/watch AAPL MSFT NVDA GOOGL AMZN

所有命令：
/watch — 添加关注
/unwatch — 取消关注
/list — 查看关注列表
/brief — 市场快报
/detail NVDA — 个股分析
/macro — 宏观环境
/risk — 地缘风险
/status — 系统状态

收到推送后直接回复即可追问AI。`);
  };

  commands['/watch'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const args = (msg.text || '').replace(/^\/watch\s*/i, '').trim().toUpperCase().split(/[\s,]+/).filter(Boolean);

    if (!args.length) {
      return sendMessage(chatId, '用法: /watch NVDA AAPL TSLA\n用空格或逗号分隔多个ticker');
    }

    const results = [];
    for (const sym of args) {
      const r = pushEngine.addToWatchlist(tgId, sym, sym);
      if (r.ok) {
        results.push(`+ ${sym}`);
      } else if (r.error === 'watchlist_full') {
        results.push(`${sym}: 关注已满 (上限${r.limit})`);
      } else if (r.error === 'user_not_found') {
        pushEngine.registerUser(tgId, msg.from.username || '');
        const r2 = pushEngine.addToWatchlist(tgId, sym, sym);
        results.push(r2.ok ? `+ ${sym}` : `${sym}: 失败`);
      }
    }

    await sendMessage(chatId, `关注列表更新\n${results.join('\n')}`);
  };

  commands['/unwatch'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const args = (msg.text || '').replace(/^\/unwatch\s*/i, '').trim().toUpperCase().split(/[\s,]+/).filter(Boolean);

    if (!args.length) {
      return sendMessage(chatId, '用法: /unwatch TSLA');
    }

    for (const sym of args) {
      pushEngine.removeFromWatchlist(tgId, sym);
    }

    await sendMessage(chatId, `已取消关注: ${args.join(', ')}`);
  };

  commands['/list'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const watchlist = pushEngine.getWatchlist(tgId);

    if (!watchlist.length) {
      return sendMessage(chatId, '关注列表为空。\n发送 /watch NVDA AAPL 添加关注');
    }

    const list = watchlist.map((w, i) => `${i + 1}. ${w.symbol}`).join('\n');
    await sendMessage(chatId, `我的关注列表 (${watchlist.length}只)\n\n${list}`);
  };

  commands['/brief'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);

    await sendMessage(chatId, '正在生成市场快报...');

    const watchlist = pushEngine.getWatchlist(tgId);
    const crucix = await dataSources.fetchCrucix();
    const marketContext = dataSources.compactCrucixObj(crucix);

    const brief = await aiAnalyst.dailyBrief(
      watchlist.length ? watchlist : [{ symbol: 'SPY' }, { symbol: 'QQQ' }],
      marketContext
    );

    await sendMessage(chatId, brief || '快报生成失败，请稍后重试。');
  };

  commands['/detail'] = async (msg) => {
    const chatId = msg.chat.id;
    const symbol = (msg.text || '').replace(/^\/detail\s*/i, '').trim().toUpperCase();

    if (!symbol) {
      return sendMessage(chatId, '用法: `/detail NVDA`');
    }

    await sendMessage(chatId, `正在分析 ${symbol}...`);

    // Fetch quote from Crucix
    let quoteData;
    try {
      const res = await fetch(`${config.CRUCIX}/api/quote/${symbol}`, {
        signal: AbortSignal.timeout(10000),
      });
      quoteData = res.ok ? await res.json() : null;
    } catch { quoteData = null; }

    const crucix = await dataSources.fetchCrucix();
    const marketContext = dataSources.compactCrucixObj(crucix);

    const analysis = await aiAnalyst.detailAnalysis(symbol, quoteData, marketContext);
    await sendMessage(chatId, analysis);
  };

  commands['/macro'] = async (msg) => {
    const chatId = msg.chat.id;
    await sendMessage(chatId, '正在分析宏观环境...');

    const crucix = await dataSources.fetchCrucix();
    const marketContext = dataSources.compactCrucixObj(crucix);
    const analysis = await aiAnalyst.macroAnalysis(marketContext);
    await sendMessage(chatId, analysis);
  };

  commands['/risk'] = async (msg) => {
    const chatId = msg.chat.id;
    await sendMessage(chatId, '正在扫描全球风险...');

    const crucix = await dataSources.fetchCrucix();
    const ctx = dataSources.compactCrucixObj(crucix);
    const news = await dataSources.fetchAllNews(crucix, 15);

    // 把新闻标题拼成摘要给 AI
    const newsDigest = news.slice(0, 10).map(n => n.title).filter(Boolean).join(' | ');

    const analysis = await aiAnalyst.riskAnalysis(ctx, newsDigest);
    await sendMessage(chatId, analysis);
  };

  commands['/status'] = async (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const watchlist = pushEngine.getWatchlist(tgId);
    const symbols = watchlist.map(w => w.symbol).join(', ') || '(还没添加)';

    await sendMessage(chatId, `系统一切正常，正在帮你盯着 ${watchlist.length} 只票：${symbols}

数据每5分钟扫一次，覆盖行情、新闻、地缘、宏观27个数据源。有异动第一时间通知你。

AI引擎：${config.LLM_MODEL}`);
  };

  // ── Follow-up (reply to push) ──────────────────────────────────────────

  async function handleFollowUp(msg) {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const question = msg.text || '';

    // Rate limit check
    const today = new Date().toISOString().split('T')[0];
    const cc = userChatCount.get(tgId);
    if (cc && cc.date === today) {
      const user = pushEngine.getWatchlist(tgId); // just to check user exists
      const limit = 3; // free tier, TODO: check tier
      if (cc.count >= limit) {
        return sendMessage(chatId, `今日追问次数已用完 (${limit}次/天)。明天再来！`);
      }
      cc.count++;
    } else {
      userChatCount.set(tgId, { count: 1, date: today });
    }

    await sendMessage(chatId, '正在分析...');

    const pushCtx = userPushContext.get(tgId);
    const crucix = await dataSources.fetchCrucix();
    const marketContext = dataSources.compactCrucixObj(crucix);

    const answer = await aiAnalyst.followUp(
      question,
      pushCtx?.event || null,
      marketContext
    );

    await sendMessage(chatId, answer, { replyTo: msg.message_id });
  }

  // ── Polling ────────────────────────────────────────────────────────────

  let pollBackoff = 1000; // ms, resets on success

  async function poll() {
    if (!polling) return;

    try {
      const data = await tgCall('getUpdates', {
        offset: pollOffset,
        timeout: 25,
        allowed_updates: ['message'],
      }, 35000);

      pollBackoff = 1000; // reset on success

      if (data?.result?.length) {
        for (const update of data.result) {
          pollOffset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          const chatId = msg.chat.id;
          const cmd = msg.text.split(' ')[0].toLowerCase().split('@')[0];

          if (commands[cmd]) {
            // Command dedup: skip if same command+args already processing for this chat
            const dedupKey = `${chatId}:${msg.text.trim()}`;
            if (processingCommands.has(dedupKey)) {
              sendMessage(chatId, '上一条还在处理中，请稍等...').catch(() => {});
              continue;
            }
            processingCommands.set(dedupKey, true);
            commands[cmd](msg)
              .catch(e => console.error(`[SP Bot] Command ${cmd} error:`, e.message))
              .finally(() => processingCommands.delete(dedupKey));
          } else if (msg.reply_to_message || !msg.text.startsWith('/')) {
            handleFollowUp(msg).catch(e => console.error('[SP Bot] Follow-up error:', e.message));
          }
        }
      }
    } catch (e) {
      // Backoff on all errors (including timeout/502), max 30s
      pollBackoff = Math.min(pollBackoff * 2, 30000);
      if (!e.message?.includes('timeout') && !e.message?.includes('aborted')) {
        console.error('[SP Bot] Poll error:', e.message);
      }
    }

    pollTimer = setTimeout(poll, pollBackoff);
  }

  function start() {
    if (polling) return; // idempotent
    console.log('[StockPulse Bot] Starting Telegram bot...');
    polling = true;
    startPruneTimer();
    poll();
  }

  function stop() {
    polling = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  }

  return { start, stop, sendPush, sendMessage };
}
