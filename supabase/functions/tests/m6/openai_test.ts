import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createOpenAIGenerator } from "../../_shared/m6/openai.ts";

Deno.test("parses raw Responses API output_text nested in message content", async () => {
  const generate = createOpenAIGenerator({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      output: [
        { type: "reasoning", id: "reasoning-1", content: [] },
        { type: "message", id: "message-1", content: [{ type: "output_text", text: JSON.stringify({ reply: "저는 ManUtd Content AI입니다." }) }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assertEquals(await generate({ user_message: "너 누구야" }), { reply: "저는 ManUtd Content AI입니다." });
});
