import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const taskType = searchParams.get("taskType");
  const where = taskType ? { taskType } : {};
  const templates = await db.promptTemplate.findMany({
    where,
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, taskType, systemPrompt, instruction } = body;
  if (!name || !taskType) {
    return NextResponse.json({ error: "Missing name or taskType." }, { status: 400 });
  }
  const template = await db.promptTemplate.create({
    data: {
      name: String(name),
      taskType: String(taskType),
      systemPrompt: systemPrompt ? String(systemPrompt) : null,
      instruction: instruction ? String(instruction) : null,
    },
  });
  return NextResponse.json({ template }, { status: 201 });
}
