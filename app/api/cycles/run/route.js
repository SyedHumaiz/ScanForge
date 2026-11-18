import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeWebsiteUrl, resolvePublicTarget } from "@/lib/cycle-runner.mjs";
import { createClient } from "@supabase/supabase-js";
import { encryptLoginConfig, LOGIN_CONFIG_TTL_MS, validateLoginConfig } from "@/lib/run-login-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const fail = (error, status = 400) => NextResponse.json({ error }, { status });

export async function POST(request) {
  let supabase;
  let run;
  let privateDb;
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
    let loginConfig;
    try { loginConfig = validateLoginConfig(cases, body.loginConfig); }
    catch (error) { return fail(error.message); }
    let websiteUrl;
    try {
      websiteUrl = normalizeWebsiteUrl(body.websiteUrl);
      await resolvePublicTarget(websiteUrl);
    } catch (error) { return fail(error.message); }
    const owner = process.env.GITHUB_AUTOMATION_OWNER;
    const repository = process.env.GITHUB_AUTOMATION_REPOSITORY;
    const token = process.env.GITHUB_AUTOMATION_TOKEN;
    if (!owner || !repository || !token) return fail("The GitHub Actions automation runner has not been configured.", 503);
    if (Object.keys(loginConfig).length) {
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.RUN_CONFIG_ENCRYPTION_KEY) return fail("Per-run login configuration is not configured on the server.", 503);
      privateDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    }
    const workflow = process.env.GITHUB_AUTOMATION_WORKFLOW || "automation.yml";
    const branch = process.env.GITHUB_AUTOMATION_BRANCH || "main";
    const started = Date.now();
    const { data: inserted, error: insertError } = await supabase.from("test_runs").insert({
      project_id: body.projectId, cycle_id: cycle.id, triggered_by: user.id,
      source: "playwright", status: "queued", branch, started_at: null,
      summary: { execution: "local_cycle", target_url: websiteUrl, uses_run_login_config: Object.keys(loginConfig).length > 0, total: cases.length, passed: 0, failed: 0, skipped: 0 },
    }).select("id,project_id,cycle_id,source,status,branch,summary,created_at").single();
    if (insertError) throw insertError;
    run = inserted;
    if (Object.keys(loginConfig).length) {
      const expiresAt = new Date(Date.now() + LOGIN_CONFIG_TTL_MS).toISOString();
      const ciphertext = encryptLoginConfig(loginConfig, { runId: run.id, projectId: body.projectId, expiresAt }, process.env.RUN_CONFIG_ENCRYPTION_KEY);
      const { error: configError } = await privateDb.from("run_login_configs").insert({ run_id: run.id, project_id: body.projectId, expires_at: expiresAt, ciphertext });
      if (configError) throw new Error("Could not securely store this run's login configuration. Apply the database migration and check the service role key.");
    }
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: branch, inputs: { run_id: run.id, project_id: body.projectId, test_case_ids: ids.join(","), source: "cycle" } }),
    });
    if (!response.ok) {
      if (privateDb) await privateDb.from("run_login_configs").delete().eq("run_id", run.id);
      await supabase.from("test_runs").update({ status: "failed", finished_at: new Date().toISOString(), summary: { ...run.summary, error: `Runner dispatch failed (${response.status})` } }).eq("id", run.id);
      return fail(`Could not start the GitHub Actions runner (${response.status}).`, 502);
    }
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    if (run) {
      if (privateDb) await privateDb.from("run_login_configs").delete().eq("run_id", run.id);
      await supabase.from("test_runs").update({ status: "failed", finished_at: new Date().toISOString(), summary: { ...run.summary, error: "Cycle dispatch failed." } }).eq("id", run.id);
    }
    return fail("Unable to securely start this test cycle. Check runner configuration.", 500);
  }
}
