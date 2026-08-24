import { featuresSchema } from "@shared/features";
import { invoiceConfigSchema } from "@shared/invoiceConfig";
import * as configSvc from "../services/config";
import type { CompanyContext, IpcHandle } from "./types";

interface ConfigHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerConfigHandlers({
  handle,
  requireCompany,
}: ConfigHandlerContext): void {
  handle(
    "config:features:get",
    () => configSvc.getFeatures(requireCompany().db),
    "viewer",
  );
  handle(
    "config:features:set",
    (payload) =>
      configSvc.setFeatures(requireCompany().db, featuresSchema.parse(payload)),
    "owner",
  );
  handle(
    "config:invoice:get",
    () => configSvc.getInvoiceConfig(requireCompany().db),
    "viewer",
  );
  handle(
    "config:invoice:set",
    (payload) =>
      configSvc.setInvoiceConfig(
        requireCompany().db,
        invoiceConfigSchema.parse(payload),
      ),
    "owner",
  );
}
