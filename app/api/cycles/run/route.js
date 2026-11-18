import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { executeCycle, normalizeWebsiteUrl, resolvePublicTarget } from "@/lib/cycle-runner.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const fail = (error, status = 400) => NextResponse.json({ error }, { status });

export async function POST(request) {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL) return fail("Custom cycle execution is available only in local development (npm run dev).", 403);
  let supabase;
  let run;
  try {
    supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return fail("Sign in to run a test cycle.", 401);
    const body = await request.json();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(body.projectId) || !uuid.test(body.cycleId)) return fail("Choose a valid workspace and test cycle.");
    const { data: membership, error: memberError } = await supabase.from("project_members").select("role").eq("project_id", body.projectId).eq("user_id", user.id).maybeSingle();
    if (memberError) throw memberError;
    if (!membership || !["admin", "lead", "member"].includes(membership.role)) return fail("You need workspace editing access to run this cycle.", 403);
    const { data: cycle, error: cycleError } = await supabase.from("test_cycles").select("id").eq("id", body.cycleId).eq("project_id", body.projectId).maybeSingle();
    if (cycleError) throw cycleError;
    if (!cycle) return fail("This test cycle is unavailable in the selected workspace.", 404);
    const { data: links, error: linkError } = await supabase.from("cycle_test_cases").select("test_case_id").eq("cycle_id", cycle.id);
    if (linkError) throw linkError;
    const ids = [...new Set((links || []).map(link => link.test_case_id))];
    if (!ids.length) return fail("Assign at least one test case to this cycle before running it.");
    const { data: cases, error: caseError } = await supabase.from("test_cases").select("id,title,automation_type,steps").eq("project_id", body.projectId).in("id", ids);
    if (caseError) throw caseError;
    if (cases.length !== ids.length) return fail("Some assigned cases are unavailable in this workspace.", 403);
    let websiteUrl;
    try {
      websiteUrl = normalizeWebsiteUrl(body.websiteUrl);
      await resolvePublicTarget(websiteUrl);
    } catch (error) { return fail(error.message); }
    const started = Date.now();
    const { data: inserted, error: insertError } = await supabase.from("test_runs").insert({
      project_id: body.projectId, cycle_id: cycle.id, triggered_by: user.id,
      source: "playwright", status: "running", started_at: new Date(started).toISOString(),
      summary: { execution: "local_cycle", target_url: websiteUrl, total: cases.length },
    }).select("*").single();
    if (insertError) throw insertError;
    run = inserted;
    const results = await executeCycle(cases, websiteUrl);
    const { error: resultError } = await supabase.from("test_results").insert(results.map(result => ({ ...result, run_id: run.id })));
    if (resultError) throw resultError;
    const summary = {
      execution: "local_cycle", target_url: websiteUrl, total: results.length,
      passed: results.filter(result => result.status === "passed").length,
      failed: results.filter(result => result.status === "failed").length,
      skipped: results.filter(result => result.status === "skipped").length,
      duration_ms: Date.now() - started,
    };
    const { data: finished, error: finishError } = await supabase.from("test_runs").update({
      status: summary.passed === summary.total ? "passed" : "failed",
      finished_at: new Date().toISOString(), summary,
    }).eq("id", run.id).select("*,test_results(*,test_cases(key,title))").single();
    if (finishError) throw finishError;
    return NextResponse.json({ run: finished }, { status: 201 });
  } catch (error) {
    if (run) {
      await supabase.from("test_runs").update({ status: "failed", finished_at: new Date().toISOString(), summary: { ...run.summary, error: error.message } }).eq("id", run.id);
    }
    return fail(error.message || "Unable to execute this test cycle.", 500);
  }
}
