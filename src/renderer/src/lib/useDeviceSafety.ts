import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_DEVICE_SAFETY_CONTROLS, type DeviceSafetyControls } from "@shared/deviceSafety";
import { api } from "./client";

export function useDeviceSafetyControls(): DeviceSafetyControls {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["deviceSafety"],
    queryFn: api.deviceSafety.get,
    staleTime: Infinity,
  });
  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["deviceSafety"] });
    };
    window.addEventListener("total:device-safety-refresh", refresh);
    return () => window.removeEventListener("total:device-safety-refresh", refresh);
  }, [queryClient]);
  return data ?? DEFAULT_DEVICE_SAFETY_CONTROLS;
}
