import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const where = projectId ? { projectId } : {};
  const items = await db.userData.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ userData: items });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const item = await db.userData.create({
      data: {
        projectId: String(body.projectId),
        type: String(body.type || "text"), // image, table, text
        title: String(body.title || ""),
        description: body.description ? String(body.description) : null,
        filePath: body.filePath ? String(body.filePath) : null,
        data: body.data
          ? typeof body.data === "string"
            ? body.data
            : JSON.stringify(body.data)
          : null,
      },
    });
    return NextResponse.json({ userData: item });
  } catch (err: any) {
    console.error("[/api/user-data POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to save user data." },
      { status: 500 }
    );
  }
}
