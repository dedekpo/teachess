import OpenAI from "openai";
import { NextResponse } from "next/server";
import { buildLiveSession, type LiveSessionOptions } from "@/lib/live/session-config";

export const runtime = "nodejs";

/**
 * Creates a GPT-Live session for the browser. The browser sends its WebRTC SDP
 * offer here; we attach the API key and session config server-side and return
 * the SDP answer. The API key never reaches the client.
 */
export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server" }, { status: 500 });
  }

  let body: { sdp?: string; options?: LiveSessionOptions };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.sdp) return NextResponse.json({ error: "Missing sdp" }, { status: 400 });

  const client = new OpenAI({ apiKey });
  try {
    const result = await client.live.create({
      session: buildLiveSession(body.options ?? {}),
      transport: { type: "webrtc", sdp: body.sdp },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
