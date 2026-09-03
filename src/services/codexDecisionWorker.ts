import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { DecisionContext, StrategySignal } from "../domain/types.js";
import { StrategySignalSchema, strategySignalJsonSchema } from "../domain/schemas.js";

const buildPrompt = (context: DecisionContext): string => `
You are the central intraday BTC futures decision engine for an automated system.

Hard rules:
- Symbol: ${context.market_snapshot.symbol}
- Trading universe: BTC perpetual only.
- Do not bypass risk limits already enforced downstream.
- Do not use martingale, averaging down, or pyramiding losers.
- You are not responsible for leverage, take-profit placement, or sizing. Another deterministic planner handles execution.
- Focus on directional thesis quality, invalidation level, and whether the setup fits the regime.
- Allowed setup types: continuation, breakout, reversal, range_reversion, momentum_exit, protective_exit.
- In paper mode, the operating target is 2-6 trades per day when moderate edge exists, but do not force low-quality trades.
- If there is already an open position, use CLOSE or REDUCE only when there is a clear reversal or invalidation. Do not micro-manage every small pullback.
- Output must be valid JSON only, matching the schema.

Current trigger:
${JSON.stringify(context.trigger, null, 2)}

Context summary:
${JSON.stringify(context.context_summary, null, 2)}

Decision context:
${JSON.stringify(context, null, 2)}

Choose among LONG, SHORT, FLAT, CLOSE, REDUCE.
Return a setup_type that matches the thesis.
Set invalidation_price whenever bias is LONG or SHORT.
If you choose FLAT, the reasoning_summary must explicitly state which concrete condition is missing.
If you choose LONG or SHORT, prefer setups with visible momentum, directional trend bias, or catalyst alignment even if the edge is moderate rather than exceptional.
`;

export class CodexDecisionWorker {
  private readonly client = new Codex();

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  public async decide(context: DecisionContext): Promise<StrategySignal> {
    const prompt = buildPrompt(context);
    const thread = this.startThread();

    try {
      const result = await thread.run(prompt, {
        outputSchema: strategySignalJsonSchema,
        signal: AbortSignal.timeout(this.config.codex.timeoutMs)
      });

      const parsed = StrategySignalSchema.parse(JSON.parse(result.finalResponse));
      return {
        ...parsed,
        invalidation_price: parsed.invalidation_price ?? undefined
      };
    } catch (error) {
      this.logger.warn(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : { message: String(error) }
        },
        "Codex SDK decision failed"
      );
      if (!this.config.codex.useCliFallback) {
        throw error;
      }
    }

    const cliDecision = StrategySignalSchema.parse(await this.runViaCli(prompt));
    return {
      ...cliDecision,
      invalidation_price: cliDecision.invalidation_price ?? undefined
    };
  }

  private startThread(): ReturnType<Codex["startThread"]> {
    return this.client.startThread({
      model: this.config.codex.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      workingDirectory: process.cwd(),
      modelReasoningEffort: "high",
      networkAccessEnabled: true,
      webSearchMode: "live"
    });
  }

  private async runViaCli(prompt: string): Promise<unknown> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "btc-codex-schema-"));
    const schemaPath = path.join(tempDir, "strategy-signal.schema.json");
    await writeFile(schemaPath, JSON.stringify(strategySignalJsonSchema), "utf8");

    try {
      const finalResponse = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          path.join(process.cwd(), "node_modules", ".bin", "codex"),
          [
            "exec",
            "--experimental-json",
            "--model",
            this.config.codex.model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--config",
            'model_reasoning_effort="high"',
            "--config",
            'approval_policy="never"',
            "--config",
            'web_search="live"',
            "--output-schema",
            schemaPath
          ],
          {
            cwd: process.cwd(),
            env: process.env
          }
        );

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`codex exec failed with code ${code}: ${stderr}`));
            return;
          }

          const lines = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          for (const line of lines.reverse()) {
            const parsed = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
            if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
              resolve(parsed.item.text ?? "");
              return;
            }
          }
          reject(new Error(`No agent_message found in codex CLI output: ${stdout}`));
        });
        child.stdin.write(prompt);
        child.stdin.end();
      });

      return JSON.parse(finalResponse);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
