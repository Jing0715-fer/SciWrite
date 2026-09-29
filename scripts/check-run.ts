import { db } from "@/lib/db";
async function main() {
  const runs = await db.taskRun.findMany({
    where: { projectId: "cmumrsvtu0000qwcd93kq8atz" },
    orderBy: { startedAt: "desc" },
  });
  for (const r of runs) {
    const steps = JSON.parse(r.stepsJson || "[]");
    console.log(`${r.id.slice(-6)} status=${r.status} steps=${steps.length} started=${r.startedAt.toISOString()} finished=${r.finishedAt?.toISOString() || "-"} err=${(r.error || "").slice(0, 90)}`);
  }
}
main();
