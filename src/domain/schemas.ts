import { z } from "zod";

export const StrategySignalSchema = z.object({
  bias: z.enum(["LONG", "SHORT", "FLAT", "CLOSE", "REDUCE"]),
  confidence: z.number().min(0).max(1),
  setup_type: z.enum([
    "continuation",
    "breakout",
    "reversal",
    "range_reversion",
    "momentum_exit",
    "protective_exit"
  ]),
  invalidation_price: z.number().positive().nullable(),
  holding_horizon_minutes: z.number().int().min(1).max(1_440),
  reasoning_summary: z.string().min(12).max(500)
});

export const strategySignalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bias",
    "confidence",
    "setup_type",
    "invalidation_price",
    "holding_horizon_minutes",
    "reasoning_summary"
  ],
  properties: {
    bias: { type: "string", enum: ["LONG", "SHORT", "FLAT", "CLOSE", "REDUCE"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    setup_type: {
      type: "string",
      enum: ["continuation", "breakout", "reversal", "range_reversion", "momentum_exit", "protective_exit"]
    },
    invalidation_price: {
      anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }]
    },
    holding_horizon_minutes: { type: "integer", minimum: 1, maximum: 1440 },
    reasoning_summary: { type: "string", minLength: 12, maxLength: 500 }
  }
} as const;

export type ParsedStrategySignal = z.infer<typeof StrategySignalSchema>;
