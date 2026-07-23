import { NextRequest, NextResponse } from "next/server";
import { queryDatabase } from "@/lib/databases";
import type { DatabaseSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const source = body.source as DatabaseSource;
    const query = String(body.query || "").trim();
    const program = body.program as "blastp" | "blastn" | undefined;
    const database = body.database as string | undefined;

    if (!source || !query) {
      return NextResponse.json(
        { error: "Missing 'source' or 'query'." },
        { status: 400 }
      );
    }
    const result = await queryDatabase(source, query, { program, database });
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/databases] error:", err);
    return NextResponse.json(
      { error: err?.message || "Database query failed." },
      { status: 500 }
    );
  }
}
