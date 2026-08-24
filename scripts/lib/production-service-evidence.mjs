export const PRODUCTION_SERVICE_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateProductionServiceEvidence(evidence, options) {
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const revision = options.revision;
  const version = options.version;
  const checkedAt = Date.parse(evidence?.checkedAt ?? "");
  assert(evidence?.schema === 3 && evidence?.kind === "production-service-execution" && evidence?.executed === true && evidence?.ok === true, "Production service evidence was not executed successfully");
  assert(/^[0-9a-f]{40}$/i.test(revision) && evidence.sourceRevision === revision, "Production service evidence revision does not match the release commit");
  assert(evidence.productVersion === version, "Production service evidence version does not match the release version");
  assert(Number.isFinite(checkedAt), "Production service evidence has no valid checkedAt timestamp");
  assert(checkedAt <= now + 5 * 60 * 1_000, "Production service evidence timestamp is in the future");
  assert(now - checkedAt <= PRODUCTION_SERVICE_EVIDENCE_MAX_AGE_MS, "Production service evidence is older than six hours");
  assert(evidence.deployment?.verified === true, "Production deployment identity was not verified during execution");
  assert(typeof evidence.deployment?.id === "string" && evidence.deployment.id.length >= 8, "Production service evidence has no deployment identity");
  assert(/^https:\/\//.test(evidence.deployment?.origin ?? ""), "Production service evidence origin is not HTTPS");
  assert(evidence.synthetic?.enabled === true && evidence.synthetic?.ok === true, "Production support and feedback were not exercised");
  assert(evidence.synthetic?.checks?.support?.ok === true && evidence.synthetic?.cleanup?.support?.ok === true, "Production support create, track, resolve and delete did not pass");
  assert(evidence.synthetic?.checks?.feedback?.ok === true && evidence.synthetic?.cleanup?.feedback?.ok === true, "Production feedback submit, vote, follow and cleanup did not pass");
  assert(evidence.synthetic?.checks?.retention?.ok === true, "Production retention maintenance was not authenticated and executed");
  assert(evidence.synthetic.cleanup.feedback.deleted === 3, "Production feedback evidence did not delete all three synthetic events");
  assert(evidence.release?.deliveryReady === true && evidence.downloads?.mac?.ok === true && evidence.downloads?.win?.ok === true, "Private release metadata and installer delivery were not verified");
  return {
    ok: true,
    checkedAt: evidence.checkedAt,
    sourceRevision: evidence.sourceRevision,
    productVersion: evidence.productVersion,
    deploymentId: evidence.deployment.id,
    origin: evidence.deployment.origin,
    privateReleaseDeliveryVerified: true,
  };
}
