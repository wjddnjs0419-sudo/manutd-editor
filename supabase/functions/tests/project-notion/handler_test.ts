import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createProjectNotionHandler } from "../../project-notion/handler.ts";

function request(body: unknown, authorization = "Bearer secret", method = "POST") {
  return new Request("https://example.test/functions/v1/project-notion", {
    method,
    headers: { authorization, "content-type": "application/json" },
    body: method === "GET" || method === "HEAD" || body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("projects one canonical creative brief with an authenticated request", async () => {
  const received: string[] = [];
  const handler = createProjectNotionHandler({
    collectorSecret: "secret",
    requestId: () => "request-1",
    run: async (creativeBriefId) => {
      received.push(creativeBriefId);
      return { status: "PROJECTED", creative_brief_id: creativeBriefId, action: "CREATED", revision: 1, notion_page_id: "page-1" };
    },
  });

  const response = await handler(request({ creative_brief_id: "brief-1" }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    request_id: "request-1",
    status: "PROJECTED",
    creative_brief_id: "brief-1",
    action: "CREATED",
    revision: 1,
    notion_page_id: "page-1",
    url: null,
  });
  assertEquals(received, ["brief-1"]);
});

Deno.test("rejects malformed, unauthorized, and non-POST requests without running", async () => {
  let runs = 0;
  const handler = createProjectNotionHandler({ collectorSecret: "secret", run: async () => { runs += 1; return { status: "PROJECTED", creative_brief_id: "brief-1" }; } });

  assertEquals((await handler(request({ creative_brief_id: "" }))).status, 400);
  assertEquals((await handler(request({ creative_brief_id: "brief-1" }, "Bearer wrong"))).status, 401);
  assertEquals((await handler(request({ creative_brief_id: "brief-1" }, "Bearer secret", "GET"))).status, 405);
  assertEquals((await handler(request({ creative_brief_id: "brief-1", extra: true }))).status, 400);
  assertEquals(runs, 0);
});

Deno.test("returns a safe server error when Notion projection fails", async () => {
  const handler = createProjectNotionHandler({ collectorSecret: "secret", requestId: () => "request-1", run: async () => { throw new Error("notion_token=must-not-leak"); }, log: () => undefined });

  const response = await handler(request({ creative_brief_id: "brief-1" }));

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { request_id: "request-1", error: { code: "PROJECT_NOTION_FAILED", message: "Notion projection failed" } });
});
