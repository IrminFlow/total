import { NextResponse } from "next/server";
import sitePackage from "../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  const sourceRevision = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || process.env.TOTAL_SITE_REVISION?.trim() || null;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim() || process.env.TOTAL_DEPLOYMENT_ID?.trim() || null;
  const body = {
    schema: 1,
    sourceRevision,
    deploymentId,
    productVersion: sitePackage.version,
  };
  return NextResponse.json(body, {
    status: sourceRevision && deploymentId ? 200 : 503,
    headers: { "cache-control": "private, no-store, max-age=0" },
  });
}
