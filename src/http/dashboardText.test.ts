import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Execute the exact inline dashboard script with DOM doubles that reject HTML sinks.
class Element {
  public children: Element[] = [];
  public textContent = "";
  public className = "";
  public colSpan = 0;
  public constructor(public tag: string) {}
  public set innerHTML(_: string) { throw new Error("Dynamic HTML is forbidden"); }
  public append(...children: Element[]): void { this.children.push(...children); }
  public replaceChildren(...children: Element[]): void { this.children = children; }
  public addEventListener(): void {}
}
async function render(data: unknown) {
  const elements = new Map<string, Element>();
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Dashboard script missing");
  const context = {
    document: {
      createElement: (tag: string) => new Element(tag),
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element("root"));
        return elements.get(id)!;
      }
    },
    fetch: async () => ({ json: async () => data }),
    setInterval: () => 0,
    console
  };
  runInNewContext(script, context);
  // Flush the cross-realm async refresh before inspecting its DOM writes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return elements;
}
function texts(node: Element): string[] {
  return [node.textContent, ...node.children.flatMap(texts)];
}
const base = { account: {}, position: {}, recentDecisions: [], recentTrades: [] };
describe("dashboard text rendering", () => {
  it("renders external strings literally without creating markup or dynamic classes", async () => {
    const payload = '<img src=x onerror="throw 1"> & <script>throw 2</script>';
    const nodes = await render({
      ...base,
      position: { side: payload },
      recentDecisions: [{ createdAt: 1, trigger: { reason: payload, details: payload },
        signal: { bias: payload, setup_type: payload, reasoning_summary: payload }, reasons: [payload] }],
      recentTrades: [{ createdAt: 1, action: payload, side: payload, status: payload,
        exitReason: payload, details: { message: payload } }]
    });
    expect(texts(nodes.get("decisionsBody")!).filter((text) => text === payload)).toHaveLength(6);
    expect(texts(nodes.get("tradesBody")!).filter((text) => text === payload)).toHaveLength(5);
    expect(nodes.get("posSide")!.children[0]!.textContent).toBe(payload);
    expect(nodes.get("posSide")!.children[0]!.className).toBe("badge badge-flat");
    const inspect = (node: Element) => {
      expect(["img", "script"]).not.toContain(node.tag);
      expect(node.className).not.toContain(payload);
      node.children.forEach(inspect);
    };
    nodes.forEach(inspect);
  });
  it("keeps empty state text and column spans", async () => {
    const nodes = await render(base);
    expect(nodes.get("decisionsBody")!.children[0]!.children[0]!.colSpan).toBe(8);
    expect(texts(nodes.get("decisionsBody")!)).toContain("No decisions yet");
    expect(nodes.get("tradesBody")!.children[0]!.children[0]!.colSpan).toBe(10);
  });
  it("keeps known badge styling and ordinary text", async () => {
    const nodes = await render({ ...base, position: { side: "long" } });
    expect(nodes.get("posSide")!.children[0]!.className).toBe("badge badge-long");
    expect(nodes.get("posSide")!.children[0]!.textContent).toBe("long");
  });
});
