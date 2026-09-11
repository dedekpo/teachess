import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Resumes a stored GPT-Live session as a new session (fork), preserving the
 * conversation state. Used after an idle close.
 */
export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server" }, { status: 500 });
  }
  let body: { sessionId?: string; sdp?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.sdp || !body.sessionId) {
    return NextResponse.json({ error: "Missing sessionId or sdp" }, { status: 400 });
  }
  const client = new OpenAI({ apiKey });
  try {
    const result = await client.live.sessions.fork(body.sessionId, {
      transport: { type: "webrtc", sdp: body.sdp },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
