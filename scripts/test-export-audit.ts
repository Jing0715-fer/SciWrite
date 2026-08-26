async function main() {
  const resp = await fetch("http://localhost:3000/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "article",
      id: "cmt9irxdu00o8rertvgdk79u3",
      format: "markdown",
      language: "en",
    }),
  });
  console.log("status=", resp.status, "ctype=", resp.headers.get("content-type"));
  if (!resp.ok) {
    console.log("error:", await resp.text());
    return;
  }
  const text = await resp.text();
  console.log("len=", text.length);
  // Find the Citation Validation section
  const idx = text.indexOf("Citation Validation");
  if (idx >= 0) {
    console.log("\n=== Citation Validation section ===");
    console.log(text.slice(idx, idx + 4000));
  } else {
    console.log("no Citation Validation section found");
    console.log("\n=== last 3KB ===");
    console.log(text.slice(-3000));
  }
  // Also: check for 'uncited' mentions anywhere
  const uncitedMatches = [...text.matchAll(/uncited/gi)];
  console.log(`\nTotal 'uncited' occurrences: ${uncitedMatches.length}`);
  for (const m of uncitedMatches.slice(0, 8)) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(text.length, m.index + 200);
    console.log(`  ctx: ...${text.slice(start, end)}...`);
  }
}
main().catch(e=>console.error(e));
