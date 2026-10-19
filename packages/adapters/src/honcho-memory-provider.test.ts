import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  HonchoMemoryProvider,
  honchoWorkspaceId,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function honchoFetch(chatAnswers?: Record<string, string>) {
  const facts = new Map<string, string[]>();
  const peers = new Set(["space-space-1", "bot-bot-1", "bot-bot-2"]);
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    expect(new URL(String(url)).origin).toBe("https://api.honcho.dev");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    const peer = path.match(/^\/v3\/workspaces\/rakazo-space-1\/peers\/([^/]+)\/chat$/)?.[1];
    let content: string | undefined;
    if (peer) {
      expect(peers.has(peer)).toBe(true);
      expect(body).toEqual({
        query: expect.any(String),
        reasoning_level: "low",
        stream: false,
        ...(peer === "space-space-1" ? {} : { target: "space-space-1" }),
      });
      if (chatAnswers) {
        if (!Object.hasOwn(chatAnswers, peer)) throw new Error(`Unexpected chat: ${path}`);
        content = chatAnswers[peer];
      } else {
        content = facts.get(peer)?.join("\n") || "NO_RELEVANT_MEMORY";
      }
    } else if (path === "/v3/workspaces") {
      expect(body).toEqual({ id: "rakazo-space-1" });
    } else if (path === "/v3/workspaces/rakazo-space-1/peers") {
      expect(body).toEqual({ id: expect.any(String) });
      expect(peers.has(body.id)).toBe(true);
    } else if (path === "/v3/workspaces/rakazo-space-1/conclusions") {
      expect(body).toEqual({ conclusions: expect.any(Array) });
      for (const conclusion of body.conclusions) {
        expect(conclusion).toEqual({
          content: expect.any(String),
          observer_id: expect.any(String),
          observed_id: "space-space-1",
        });
        expect(peers.has(conclusion.observer_id)).toBe(true);
        const saved = facts.get(conclusion.observer_id) ?? [];
        facts.set(conclusion.observer_id, [...saved, conclusion.content]);
      }
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return new Response(JSON.stringify(peer ? { content } : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function provider(fetch: typeof globalThis.fetch) {
  return new HonchoMemoryProvider(
    { baseUrl: "https://api.honcho.dev", apiKey: "hch-test", reasoningLevel: "low", fetch },
    {},
  );
}

function calls(fetchMock: ReturnType<typeof honchoFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    path: new URL(String(url)).pathname,
    body: JSON.parse(String(init?.body)),
  }));
}

describe("HonchoMemoryProvider", () => {
  it("saves shared facts for the Space and the bot, then recalls through peer chat", async () => {
    const fetchMock = honchoFetch({
      "space-space-1": "The user's favorite color is teal.",
      "bot-bot-1": "NO_RELEVANT_MEMORY",
    });
    const memory = provider(fetchMock);

    const saved = await memory.save(
      {
        content: "Favorite color is teal",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    const recalled = await memory.recall(
      { query: "what color should the deck be?", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(saved).toEqual({ ok: true, value: undefined });
    const conclusions = calls(fetchMock).find((call) => call.path.endsWith("/conclusions"));
    expect(conclusions).toEqual({
      path: "/v3/workspaces/rakazo-space-1/conclusions",
      body: {
        conclusions: [
          {
            content: "Favorite color is teal",
            observer_id: "bot-bot-1",
            observed_id: "space-space-1",
          },
          {
            content: "Favorite color is teal",
            observer_id: "space-space-1",
            observed_id: "space-space-1",
          },
        ],
      },
    });
    const chats = calls(fetchMock).filter((call) => call.path.endsWith("/chat"));
    expect(chats.map((call) => [call.path, call.body.target])).toEqual([
      ["/v3/workspaces/rakazo-space-1/peers/space-space-1/chat", undefined],
      ["/v3/workspaces/rakazo-space-1/peers/bot-bot-1/chat", "space-space-1"],
    ]);
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The user's favorite color is teal.",
          score: 1,
          provenance: "honcho",
          entity: "space-space-1",
        },
      ],
    });
    // Workspace and peers are get-or-create once per provider, not per call.
    expect(calls(fetchMock).filter((call) => call.path.endsWith("/peers"))).toHaveLength(2);
  });

  it("shares facts across members while keeping isolated facts per bot across users and routines", async () => {
    const fetch = honchoFetch();
    const memory = provider(fetch);
    const otherMember = { ...context, userId: "user-2", botId: "bot-2" };
    const save = (content: string, scope: "shared" | "isolated") =>
      memory.save({ content, scope, botId: "bot-1", source: { kind: "durable" } }, context);
    expect(await save("The Space uses teal", "shared")).toEqual({ ok: true, value: undefined });
    expect(await save("Bot A's private fact", "isolated")).toEqual({ ok: true, value: undefined });

    const recall = { query: "facts?", scope: "shared" as const, botId: "bot-2", limit: 5 };
    // Bot B sees user 1's shared fact, but never bot A's private fact.
    expect(await memory.recall(recall, otherMember)).toMatchObject({
      ok: true,
      value: [{ memory: "The Space uses teal", entity: "space-space-1" }],
    });
    expect(await memory.recall({ ...recall, scope: "isolated" }, otherMember)).toEqual({
      ok: true,
      value: [],
    });
    // A bot's private memory follows the bot across members and userless routines.
    for (const userId of ["user-1", "user-2", ""]) {
      const botContext = { ...context, userId };
      expect(
        await memory.recall({ ...recall, scope: "isolated", botId: "bot-1" }, botContext),
      ).toMatchObject({
        ok: true,
        value: [{ memory: "The Space uses teal\nBot A's private fact", entity: "bot-bot-1" }],
      });
      expect(await memory.recall(recall, { ...otherMember, userId })).toMatchObject({
        ok: true,
        value: [{ memory: "The Space uses teal", entity: "space-space-1" }],
      });
    }
    expect(
      await memory.save(
        { content: "Routine fact", scope: "shared", botId: "bot-2", source: { kind: "durable" } },
        { ...otherMember, userId: "" },
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(await memory.recall({ ...recall, botId: "bot-1" }, context)).toMatchObject({
      ok: true,
      value: [
        { memory: "The Space uses teal\nRoutine fact", entity: "space-space-1" },
        { memory: "The Space uses teal\nBot A's private fact", entity: "bot-bot-1" },
      ],
    });
  });

  it("keeps compaction summaries out of Honcho", async () => {
    const fetchMock = honchoFetch({});
    const result = await provider(fetchMock).save(
      {
        content: "summary",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "history", generation: 1 },
      },
      context,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shared recall deduplication", () => {
  it.each([1, 5])("keeps the first answer before applying limit %i", async (limit) => {
    const result = await provider(
      honchoFetch({
        "space-space-1": "Favorite color is teal.",
        "bot-bot-1": "  FAVORITE  color\nis teal.  ",
      }),
    ).recall({ query: "color?", scope: "shared", botId: "bot-1", limit }, context);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Favorite color is teal.",
          score: 1,
          provenance: "honcho",
          entity: "space-space-1",
        },
      ],
    });
  });
});

function connectionFetch(path: string, body: unknown, status = 200) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`https://api.honcho.dev${path}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer hch-test-key" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response("", { status });
  });
}

describe("prepareHonchoConnection", () => {
  it("probes an admin key without creating a workspace and derives per-Space workspaces", async () => {
    const fetch = connectionFetch("/v3/workspaces/list?size=1", {});
    const prepared = await prepareHonchoConnection(
      { apiKey: "discard", baseUrl: "http://localhost" },
      { apiKey: " hch-test-key " },
      { fetch },
    );
    expect(prepared).toEqual({
      settings: { reasoningLevel: "low" },
      credentials: { apiKey: "hch-test-key" },
    });
    expect(honchoWorkspaceId(prepared.settings, "space-1")).toBe("rakazo-space-1");
    expect(honchoWorkspaceId(prepared.settings, "space-2")).toBe("rakazo-space-2");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates an explicit workspace and saves only normalized public settings", async () => {
    const fetch = connectionFetch("/v3/workspaces", { id: "team-notes" });
    const prepared = await prepareHonchoConnection(
      { workspaceId: " team-notes ", reasoningLevel: "medium", apiKey: "discard" },
      { apiKey: " hch-test-key " },
      { fetch },
    );
    expect(prepared).toEqual({
      settings: { workspaceId: "team-notes", reasoningLevel: "medium" },
      credentials: { apiKey: "hch-test-key" },
    });
    expect(honchoWorkspaceId(prepared.settings, "space-1")).toBe("team-notes");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("rejects status %i for either workspace branch", async (status) => {
    for (const workspaceId of ["", "team-notes"]) {
      const fetch = connectionFetch(
        workspaceId ? "/v3/workspaces" : "/v3/workspaces/list?size=1",
        workspaceId ? { id: workspaceId } : {},
        status,
      );
      await expect(
        prepareHonchoConnection({ workspaceId }, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow(`Honcho request failed: ${status}`);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each(["bad workspace", "../private", "a".repeat(513)])(
    "rejects invalid workspace names before probing",
    async (workspaceId) => {
      const fetch = vi.fn(() => {
        throw new Error("Unexpected request");
      });
      await expect(
        prepareHonchoConnection({ workspaceId }, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow(/workspaceId/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "short", "k".repeat(4097)])(
    "rejects invalid key length before probing",
    async (apiKey) => {
      const fetch = vi.fn(() => {
        throw new Error("Unexpected request");
      });
      await expect(prepareHonchoConnection({}, { apiKey }, { fetch })).rejects.toThrow(/apiKey/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "timeout"])(
    "handles %s failures without reflecting exception secrets",
    async (kind) => {
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (kind === "timeout") {
          throw new DOMException("hch-test-key" + "x".repeat(5000), "TimeoutError");
        }
        throw new Error("hch-test-key" + "x".repeat(5000));
      });
      await expect(
        prepareHonchoConnection({}, { apiKey: "hch-test-key" }, { fetch }),
      ).rejects.toThrow("Honcho is unreachable or the request timed out.");
    },
  );
});

describe("Honcho scope and failures", () => {
  const recall = { query: "color?", scope: "shared" as const, botId: "bot-1", limit: 1 };
  it("applies the recall limit to distinct answers", async () => {
    const result = await provider(
      honchoFetch({ "space-space-1": "First fact", "bot-bot-1": "Second fact" }),
    ).recall(recall, context);
    expect(result).toMatchObject({ ok: true, value: [{ memory: "First fact" }] });
  });
  it("keeps isolated saves and recalls in the bot perspective", async () => {
    const fetch = honchoFetch({ "bot-bot-1": "A private fact" });
    const memory = provider(fetch);
    await memory.save(
      { content: " fact ", scope: "isolated", botId: "bot-1", source: { kind: "durable" } },
      context,
    );
    const saved = calls(fetch).find((call) => call.path.endsWith("/conclusions"));
    expect(saved?.body.conclusions).toEqual([
      { content: "fact", observer_id: "bot-bot-1", observed_id: "space-space-1" },
    ]);
    await memory.recall({ ...recall, scope: "isolated" }, context);
    expect(calls(fetch).filter((call) => call.path.endsWith("/chat"))).toHaveLength(1);
  });
  it("returns recall errors as results and retries failed peer setup", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== "https://api.honcho.dev/v3/workspaces")
        throw new Error("Unexpected request");
      return new Response("", { status: 503 });
    });
    const memory = provider(fetch);
    await expect(memory.recall(recall, context)).resolves.toEqual({
      ok: false,
      error: "Honcho request failed: 503",
    });
    await memory.recall(recall, context);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps successful shared recall when another perspective fails", async () => {
    const normal = honchoFetch({ "space-space-1": "A fact" });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/bot-bot-1/chat")) return new Response("", { status: 503 });
      return normal(url, init);
    });
    await expect(provider(fetch).recall(recall, context)).resolves.toMatchObject({
      ok: true,
      value: [{ memory: "A fact" }],
    });
  });
});
