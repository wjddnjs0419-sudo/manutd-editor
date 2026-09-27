import { assertEquals } from "jsr:@std/assert@1";
import { extractArticleExcerpt } from "../../source-discovery/article_extractor.ts";

Deno.test("extracts bounded article paragraphs without script or navigation text", () => {
  const excerpt = extractArticleExcerpt(`
    <html>
      <script>ignore this analytics payload</script>
      <nav>Ignore navigation</nav>
      <article>
        <h1>Manchester United tactical analysis</h1>
        <p>United tried to build from the back with shorter passes.</p>
        <p>The manager adjusted the defensive shape after the draw.</p>
      </article>
      <footer>Ignore footer</footer>
    </html>
  `, 180);

  assertEquals(excerpt, "United tried to build from the back with shorter passes. The manager adjusted the defensive shape after the draw.");
});

Deno.test("returns null when an article has no meaningful paragraphs", () => {
  assertEquals(extractArticleExcerpt("<html><script>no article</script><div>short</div></html>", 180), null);
});
