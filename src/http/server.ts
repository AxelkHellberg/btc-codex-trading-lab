import Fastify from "fastify";

import type { RuntimeState } from "../services/runtimeState.js";

export async function createHttpServer(
  runtime: RuntimeState,
  port: number,
  triggerEvaluation?: () => Promise<void>
): Promise<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });

  const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BTC Codex Trader</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081018;
        --panel: rgba(13, 22, 34, 0.92);
        --panel-border: rgba(255, 255, 255, 0.08);
        --text: #e8f0f7;
        --muted: #8ea0b5;
        --green: #40d890;
        --red: #ff6b6b;
        --amber: #f7c66a;
        --blue: #69b7ff;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(68, 142, 255, 0.2), transparent 35%),
          radial-gradient(circle at top right, rgba(64, 216, 144, 0.12), transparent 28%),
          linear-gradient(180deg, #081018 0%, #060b12 100%);
        color: var(--text);
      }

      .wrap {
        max-width: 1380px;
        margin: 0 auto;
        padding: 28px;
      }

      .hero {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 24px;
        margin-bottom: 24px;
      }

      h1 {
        margin: 0 0 6px;
        font-size: 32px;
        letter-spacing: -0.03em;
      }

      .sub {
        color: var(--muted);
        font-size: 14px;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--panel-border);
        color: var(--muted);
        font-size: 13px;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--green);
        box-shadow: 0 0 16px rgba(64, 216, 144, 0.7);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 16px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 18px;
        padding: 18px;
        backdrop-filter: blur(14px);
        box-shadow: 0 20px 50px rgba(0,0,0,0.18);
      }

      .metric {
        grid-column: span 3;
      }

      .metric-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }

      .metric-value {
        margin-top: 10px;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }

      .positive { color: var(--green); }
      .negative { color: var(--red); }
      .neutral { color: var(--text); }

      .wide {
        grid-column: span 6;
      }

      .full {
        grid-column: span 12;
      }

      .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 14px;
        font-size: 15px;
        font-weight: 600;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        vertical-align: top;
        font-size: 13px;
      }

      th {
        color: var(--muted);
        font-weight: 500;
      }

      .reasoning {
        max-width: 520px;
        color: #d5dfeb;
        line-height: 1.45;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        padding: 5px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .badge-flat, .badge-close, .badge-reduce {
        background: rgba(247, 198, 106, 0.12);
        color: var(--amber);
      }

      .badge-long {
        background: rgba(64, 216, 144, 0.12);
        color: var(--green);
      }

      .badge-short {
        background: rgba(255, 107, 107, 0.12);
        color: var(--red);
      }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }

      .small {
        color: var(--muted);
        font-size: 12px;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: #dbe6f2;
        font-size: 12px;
      }

      @media (max-width: 1100px) {
        .metric, .wide { grid-column: span 6; }
      }

      @media (max-width: 720px) {
        .wrap { padding: 18px; }
        .hero { flex-direction: column; align-items: start; }
        .metric, .wide, .full { grid-column: span 12; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>BTC Codex Trader</h1>
          <div class="sub">Paper mode dashboard. Auto-refresh every 2 seconds.</div>
        </div>
        <div class="status-pill">
          <span class="dot"></span>
          <span id="heartbeat">Connecting...</span>
        </div>
      </div>

      <div class="grid">
        <div class="card metric">
          <div class="metric-label">Equity</div>
          <div class="metric-value mono" id="equity">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Wallet Balance</div>
          <div class="metric-value mono" id="walletBalance">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Daily PnL</div>
          <div class="metric-value mono" id="dailyPnl">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Weekly Drawdown</div>
          <div class="metric-value mono" id="weeklyDrawdown">-</div>
        </div>

        <div class="card metric">
          <div class="metric-label">Realized PnL</div>
          <div class="metric-value mono" id="realizedPnl">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Unrealized PnL</div>
          <div class="metric-value mono" id="unrealizedPnl">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Win Rate</div>
          <div class="metric-value mono" id="winRate">-</div>
        </div>
        <div class="card metric">
          <div class="metric-label">Expectancy</div>
          <div class="metric-value mono" id="expectancy">-</div>
        </div>

        <div class="card wide">
          <div class="section-title">
            <span>Position</span>
            <span class="small" id="positionUpdated">-</span>
          </div>
          <table>
            <tbody>
              <tr><th>Side</th><td id="posSide">-</td></tr>
              <tr><th>Quantity</th><td class="mono" id="posQty">-</td></tr>
              <tr><th>Entry</th><td class="mono" id="posEntry">-</td></tr>
              <tr><th>Mark</th><td class="mono" id="posMark">-</td></tr>
              <tr><th>Unrealized PnL</th><td class="mono" id="posUpnl">-</td></tr>
              <tr><th>Leverage</th><td class="mono" id="posLev">-</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card wide">
          <div class="section-title">
            <span>Performance</span>
            <span class="small">Closed trade lifecycle metrics</span>
          </div>
          <table>
            <tbody>
              <tr><th>Profit Factor</th><td class="mono" id="profitFactor">-</td></tr>
              <tr><th>Average Winner</th><td class="mono" id="averageWinner">-</td></tr>
              <tr><th>Average Loser</th><td class="mono" id="averageLoser">-</td></tr>
              <tr><th>Average MFE</th><td class="mono" id="averageMfe">-</td></tr>
              <tr><th>Average MAE</th><td class="mono" id="averageMae">-</td></tr>
              <tr><th>% FLAT Signals</th><td class="mono" id="flatRate">-</td></tr>
              <tr><th>Confidence Rejects</th><td class="mono" id="confidenceRejectRate">-</td></tr>
              <tr><th>RR Rejects</th><td class="mono" id="rrRejectRate">-</td></tr>
              <tr><th>Invalid Exit Rejects</th><td class="mono" id="invalidExitRate">-</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card wide">
          <div class="section-title">
            <span>Market</span>
            <span class="small" id="marketUpdated">-</span>
          </div>
          <table>
            <tbody>
              <tr><th>Mark Price</th><td class="mono" id="markPrice">-</td></tr>
              <tr><th>Funding</th><td class="mono" id="fundingRate">-</td></tr>
              <tr><th>Regime</th><td id="regime">-</td></tr>
              <tr><th>Open Interest</th><td class="mono" id="openInterest">-</td></tr>
              <tr><th>OI 1m</th><td class="mono" id="oiChange">-</td></tr>
              <tr><th>1m Change</th><td class="mono" id="price1m">-</td></tr>
              <tr><th>5m Change</th><td class="mono" id="price5m">-</td></tr>
              <tr><th>15m Change</th><td class="mono" id="price15m">-</td></tr>
              <tr><th>1h Change</th><td class="mono" id="price1h">-</td></tr>
              <tr><th>EMA 9 / 21</th><td class="mono" id="emaPair">-</td></tr>
              <tr><th>Volume Accel</th><td class="mono" id="volumeAccel">-</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card full">
          <div class="section-title">
            <span>Recent Decisions</span>
            <button id="triggerBtn" style="background:#152232;color:#e8f0f7;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px 12px;cursor:pointer;">Trigger Now</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Trigger</th>
                <th>Bias</th>
                <th>Setup</th>
                <th>Confidence</th>
                <th>Approved</th>
                <th>Reasons</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody id="decisionsBody"></tbody>
          </table>
        </div>

        <div class="card full">
          <div class="section-title">
            <span>Recent Trades</span>
            <span class="small">Paper or live executions</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Status</th>
                <th>Exit</th>
                <th>Net PnL</th>
                <th>MFE/MAE</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="tradesBody"></tbody>
          </table>
        </div>

        <div class="card full">
          <div class="section-title">
            <span>Exit Distribution</span>
            <span class="small">Closed trades by exit reason</span>
          </div>
          <pre id="exitDistribution"></pre>
        </div>

        <div class="card full">
          <div class="section-title">
            <span>Raw Snapshot</span>
            <span class="small">Useful while tuning the bot</span>
          </div>
          <pre id="raw"></pre>
        </div>
      </div>
    </div>

    <script>
      const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
      const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
      const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });

      const setText = (id, value, className, metric = true) => {
        const el = document.getElementById(id);
        el.textContent = value;
        if (className) {
          el.className = (metric ? "metric-value mono " : "mono ") + className;
        }
      };

      const trendClass = (value) => value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
      const badgeClass = (action) => {
        const key = String(action || "").toLowerCase();
        return "badge badge-" + (key || "flat");
      };

      const formatTs = (value) => value ? new Date(value).toLocaleString() : "-";

      async function refresh() {
        const response = await fetch("/status");
        const data = await response.json();
        document.getElementById("heartbeat").textContent = "Live · " + new Date().toLocaleTimeString();
        setText("equity", money.format(data.account.equity), trendClass(data.account.dailyPnl));
        setText("walletBalance", money.format(data.account.walletBalance), "neutral");
        setText("dailyPnl", money.format(data.account.dailyPnl), trendClass(data.account.dailyPnl));
        setText("weeklyDrawdown", pct.format(data.account.weeklyDrawdown || 0), data.account.weeklyDrawdown > 0.02 ? "negative" : "neutral");
        setText("realizedPnl", money.format(data.tradeStats?.realizedPnl || 0), trendClass(data.tradeStats?.realizedPnl || 0));
        setText("unrealizedPnl", money.format(data.tradeStats?.unrealizedPnl || 0), trendClass(data.tradeStats?.unrealizedPnl || 0));
        setText("winRate", pct.format(data.tradeStats?.winRate || 0), (data.tradeStats?.winRate || 0) >= 0.5 ? "positive" : "neutral");
        setText("expectancy", money.format(data.tradeStats?.expectancy || 0), trendClass(data.tradeStats?.expectancy || 0));

        document.getElementById("posSide").innerHTML = '<span class="' + badgeClass(data.position.side === "long" ? "LONG" : data.position.side === "short" ? "SHORT" : "FLAT") + '">' + data.position.side + '</span>';
        document.getElementById("posQty").textContent = num.format(data.position.quantity);
        document.getElementById("posEntry").textContent = money.format(data.position.entryPrice || 0);
        document.getElementById("posMark").textContent = money.format(data.position.markPrice || 0);
        document.getElementById("posUpnl").textContent = money.format(data.position.unrealizedPnl || 0);
        document.getElementById("posUpnl").className = "mono " + trendClass(data.position.unrealizedPnl || 0);
        document.getElementById("posLev").textContent = num.format(data.position.leverage || 1) + "x";
        document.getElementById("positionUpdated").textContent = "Updated " + formatTs(data.account.updatedAt);

        document.getElementById("markPrice").textContent = money.format(data.market?.markPrice || 0);
        document.getElementById("fundingRate").textContent = num.format(data.market?.fundingRate || 0);
        document.getElementById("regime").textContent = data.recentDecisions?.[0]?.context?.context_summary?.regime || "-";
        document.getElementById("openInterest").textContent = num.format(data.market?.openInterest || 0);
        document.getElementById("oiChange").textContent = num.format(data.market?.openInterestChangePct1m || 0) + "%";
        document.getElementById("oiChange").className = "mono " + trendClass(data.market?.openInterestChangePct1m || 0);
        document.getElementById("price1m").textContent = num.format(data.market?.priceChangePct1m || 0) + "%";
        document.getElementById("price1m").className = "mono " + trendClass(data.market?.priceChangePct1m || 0);
        document.getElementById("price5m").textContent = num.format(data.market?.priceChangePct5m || 0) + "%";
        document.getElementById("price5m").className = "mono " + trendClass(data.market?.priceChangePct5m || 0);
        document.getElementById("price15m").textContent = num.format(data.market?.priceChangePct15m || 0) + "%";
        document.getElementById("price15m").className = "mono " + trendClass(data.market?.priceChangePct15m || 0);
        document.getElementById("price1h").textContent = num.format(data.market?.priceChangePct1h || 0) + "%";
        document.getElementById("price1h").className = "mono " + trendClass(data.market?.priceChangePct1h || 0);
        document.getElementById("emaPair").textContent = num.format(data.market?.emaFast || 0) + " / " + num.format(data.market?.emaMedium || 0);
        document.getElementById("volumeAccel").textContent = num.format(data.market?.volumeAcceleration || 0) + "x";
        document.getElementById("volumeAccel").className = "mono " + trendClass((data.market?.volumeAcceleration || 1) - 1);
        document.getElementById("marketUpdated").textContent = "Updated " + formatTs(data.market?.timestamp);

        const decisions = data.recentDecisions || [];
        const flatCount = decisions.filter((item) => item.signal?.bias === "FLAT").length;
        const confidenceRejects = decisions.filter((item) => (item.reasons || []).some((reason) => reason.includes("confidence below"))).length;
        const rrRejects = decisions.filter((item) => (item.reasons || []).some((reason) => reason.includes("risk/reward below minimum"))).length;
        const invalidExitRejects = decisions.filter((item) => (item.reasons || []).includes("invalid model exit decision: no open position")).length;
        const denom = decisions.length || 1;
        setText("flatRate", pct.format(flatCount / denom), flatCount / denom > 0.65 ? "negative" : "neutral", false);
        setText("confidenceRejectRate", pct.format(confidenceRejects / denom), confidenceRejects / denom > 0.35 ? "negative" : "neutral", false);
        setText("rrRejectRate", pct.format(rrRejects / denom), rrRejects / denom > 0.25 ? "negative" : "neutral", false);
        setText("invalidExitRate", pct.format(invalidExitRejects / denom), invalidExitRejects > 0 ? "negative" : "neutral", false);
        setText("profitFactor", num.format(data.tradeStats?.profitFactor || 0), (data.tradeStats?.profitFactor || 0) > 1 ? "positive" : "neutral", false);
        setText("averageWinner", money.format(data.tradeStats?.averageWinner || 0), "positive", false);
        setText("averageLoser", money.format(data.tradeStats?.averageLoser || 0), "negative", false);
        setText("averageMfe", money.format(data.tradeStats?.averageMfe || 0), "positive", false);
        setText("averageMae", money.format(data.tradeStats?.averageMae || 0), "negative", false);

        document.getElementById("decisionsBody").innerHTML = (data.recentDecisions || []).slice(0, 12).map((item) => {
          const reasons = (item.reasons || []).join(", ") || "-";
          return '<tr>' +
            '<td class="small">' + formatTs(item.createdAt) + '</td>' +
            '<td><div>' + (item.trigger?.reason || "-") + '</div><div class="small">' + (item.trigger?.details || "") + '</div></td>' +
            '<td><span class="' + badgeClass(item.signal?.bias) + '">' + (item.signal?.bias || "-") + '</span></td>' +
            '<td>' + (item.signal?.setup_type || "-") + '</td>' +
            '<td class="mono">' + num.format(item.signal?.confidence || 0) + '</td>' +
            '<td>' + (item.approved ? '<span class="positive">yes</span>' : '<span class="negative">no</span>') + '</td>' +
            '<td class="small">' + reasons + '</td>' +
            '<td class="reasoning">' + (item.signal?.reasoning_summary || "-") + '</td>' +
          '</tr>';
        }).join("") || '<tr><td colspan="8" class="small">No decisions yet</td></tr>';

        document.getElementById("tradesBody").innerHTML = (data.recentTrades || []).slice(0, 12).map((item) => {
          return '<tr>' +
            '<td class="small">' + formatTs(item.createdAt) + '</td>' +
            '<td><span class="' + badgeClass(item.action) + '">' + item.action + '</span></td>' +
            '<td>' + item.side + '</td>' +
            '<td class="mono">' + num.format(item.remainingQuantity || item.quantity) + ' / ' + num.format(item.quantity) + '</td>' +
            '<td class="mono">' + money.format(item.entryPrice || 0) + '</td>' +
            '<td>' + item.status + '</td>' +
            '<td>' + (item.exitReason || "-") + '</td>' +
            '<td class="mono ' + trendClass(item.netPnl || 0) + '">' + money.format(item.netPnl || 0) + '</td>' +
            '<td class="small">' + money.format(item.mfe || 0) + ' / ' + money.format(item.mae || 0) + '</td>' +
            '<td class="small">' + (item.details?.message || "-") + '</td>' +
          '</tr>';
        }).join("") || '<tr><td colspan="10" class="small">No trades yet</td></tr>';

        document.getElementById("exitDistribution").textContent = JSON.stringify(data.tradeStats?.exitDistribution || {}, null, 2);
        document.getElementById("raw").textContent = JSON.stringify(data, null, 2);
      }

      document.getElementById("triggerBtn").addEventListener("click", async () => {
        const button = document.getElementById("triggerBtn");
        button.disabled = true;
        button.textContent = "Triggering...";
        try {
          await fetch("/trigger", { method: "POST" });
          await refresh();
        } finally {
          button.disabled = false;
          button.textContent = "Trigger Now";
        }
      });

      refresh().catch((error) => {
        document.getElementById("heartbeat").textContent = "Dashboard error";
        console.error(error);
      });
      setInterval(() => {
        refresh().catch(console.error);
      }, 2000);
    </script>
  </body>
</html>`;

  app.get("/healthz", async () => ({
    ok: true,
    ts: Date.now()
  }));

  app.get("/", async (_, reply) => {
    reply.type("text/html").send(dashboardHtml);
  });

  app.get("/status", async () => ({
    market: runtime.getMarket(),
    onchain: runtime.getOnchain(),
    account: runtime.getAccount(),
    position: runtime.getPosition(),
    tradeStats: runtime.getTradeStats(),
    recentDecisions: runtime.getRecentDecisions().slice(0, 25),
    recentTrades: runtime.getRecentTrades().slice(0, 25)
  }));

  app.post("/trigger", async () => {
    if (!triggerEvaluation) {
      return {
        ok: false
      };
    }
    await triggerEvaluation();
    return {
      ok: true
    };
  });

  return {
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
    },
    stop: async () => {
      await app.close();
    }
  };
}
