import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildCycleReportPdf, cycleReportFilename } from "@/lib/cycle-report.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sign in to download cycle reports." }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const projectId = params.get("projectId"), cycleId = params.get("cycleId");
    if (!projectId || !cycleId) return NextResponse.json({ error: "A project and cycle are required." }, { status: 400 });
    const { data: membership, error: memberError } = await supabase.from("project_members").select("project_id").eq("project_id", projectId).eq("user_id", user.id).maybeSingle();
    if (memberError) throw memberError;
    if (!membership) return NextResponse.json({ error: "You do not have access to this project." }, { status: 403 });
    const { data: cycle, error: cycleError } = await supabase.from("test_cycles").select("id,name,project_id").eq("id", cycleId).eq("project_id", projectId).maybeSingle();
    if (cycleError) throw cycleError;
    if (!cycle) return NextResponse.json({ error: "This test cycle is unavailable." }, { status: 404 });
    const { data: run, error: runError } = await supabase.from("test_runs").select("*,test_results(*,test_cases(key,title))").eq("project_id", projectId).eq("cycle_id", cycleId).eq("source", "playwright").eq("summary->>execution", "local_cycle").in("status", ["passed", "failed"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (runError) throw runError;
    if (!run) return NextResponse.json({ error: "No completed local execution exists for this cycle." }, { status: 404 });
    const pdf = buildCycleReportPdf({ cycle, run });
    return new NextResponse(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${cycleReportFilename(cycle.name, run.id)}"`, "Cache-Control": "private, no-store" } });
  } catch (error) { return NextResponse.json({ error: error.message || "Unable to generate the cycle report." }, { status: 500 }); }
}
