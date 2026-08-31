const fs = await import("fs");
let f = "src/app/api/ai/generate-full/route.ts";
let s = fs.readFileSync(f, "utf8");

// 1) cancel() handler + disconnect flag (port from v2)
const oldStreamOpen = `  const encoder = new TextEncoder();
  const stream = new ReadableStream({`;
const newStreamOpen = `  const encoder = new TextEncoder();
  // r37 fix (client-disconnect waste — ported from v2): without a cancel()
  // handler the pipeline kept running for up to 30 minutes after the browser
  // closed the SSE connection (LLM calls + destructive DB writes for an
  // audience of zero). The section loop checks this flag each iteration.
  let clientDisconnected = false;
  const stream = new ReadableStream({`;
if (!s.includes(oldStreamOpen)) throw new Error("stream open not found");
s = s.replace(oldStreamOpen, newStreamOpen);

const oldStreamClose = `      } finally {
        safeClose();
      }
    },
  });

  return new Response(stream, {`;
const newStreamClose = `      } finally {
        safeClose();
      }
    },
    cancel() {
      // Browser closed the SSE stream (navigate away / refresh / drop).
      clientDisconnected = true;
    },
  });

  return new Response(stream, {`;
if (!s.includes(oldStreamClose)) throw new Error("stream close not found");
s = s.replace(oldStreamClose, newStreamClose);

// 2) snapshot before the destructive clear (port from v2)
const oldClear = `        await db.$transaction([
          db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
          db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
          db.paragraph.deleteMany({ where: { projectId } }),
          db.dataSource.deleteMany({ where: { projectId } }),
          db.reference.deleteMany({ where: { projectId } } }),
        ]);
        log("gather: cleared existing rows in DB (single transaction)");`;
const newClear = `        // r37 fix (data-loss guard — ported from v2): the force-clear below
        // DELETEs all paragraphs/references/dataSources of the project. If
        // the pipeline then dies before any section is saved (LLM timeout,
        // crash, rate-limit abort, network drop), the user's prior work
        // would be gone FOREVER. Snapshot everything the delete removes; on
        // fatal failure with ZERO new sections, restore the snapshot.
        const snapshot = {
          paragraphs: await db.paragraph.findMany({
            where: { projectId },
            include: { references: true, annotations: true },
          }),
          dataSources: await db.dataSource.findMany({ where: { projectId } }),
          articleParagraphs: await db.articleParagraph.findMany({
            where: { paragraph: { projectId } } }),
        };
        hadPriorWork =
          snapshot.paragraphs.length > 0 || snapshot.dataSources.length > 0;
        log(\`snapshot: \${snapshot.paragraphs.length} paragraphs, \${snapshot.dataSources.length} data sources (rollback safety net)\`);

        await db.$transaction([
          db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
          db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
          db.paragraph.deleteMany({ where: { projectId } }),
          db.dataSource.deleteMany({ where: { projectId } }),
          db.reference.deleteMany({ where: { projectId } } }),
        ]);
        log("gather: cleared existing rows in DB (single transaction)");`;
if (!s.includes(oldClear)) throw new Error("clear block not found");
s = s.replace(oldClear, newClear);

fs.writeFileSync(f, s);
console.log("v1 generate-full: cancel + snapshot patched");
